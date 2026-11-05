'use strict';
// Pruebas del actualizador con un SERVIDOR DE ACTUALIZACIONES FALSO (http en 127.0.0.1). Nunca se usa main.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const U = require('../lib/updater');

// Servidor falso: sirve lo que haya en `files` (rel → texto). `fail` = rutas que responden 500.
function fakeServer() {
  const st = { files: {}, fail: new Set(), hits: [] };
  const srv = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0].replace(/^\//, ''));
    st.hits.push(rel);
    if (st.fail.has(rel)) { res.writeHead(500); return res.end('error'); }
    if (!(rel in st.files)) { res.writeHead(404); return res.end('no'); }
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }); res.end(st.files[rel]);
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => { st.url = `http://127.0.0.1:${srv.address().port}/`; st.close = () => new Promise(c => srv.close(c)); r(st); }));
}
const fetchText = async url => { const r = await fetch(url); if (!r.ok) throw Error('No se pudo descargar (' + r.status + ')'); return r.text(); };

function tmpApp(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'emm-upd-'));
  for (const [rel, txt] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), txt); }
  return root;
}
const read = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const release = (srv, version, files, notes = '') => { srv.files = { 'version.json': JSON.stringify({ version, notes, files: Object.keys(files) }), ...files }; };
let clock = Date.parse('2026-11-05T10:00:00Z');
const tick = () => new Date(clock += 60000);
const mk = (root, currentVersion, srv, extra = {}) => U.createUpdater({ root, dataDir: path.join(root, 'data'), currentVersion, baseUrl: srv.url, fetchText, now: tick, ...extra });

test('cmpVer y rutas seguras', () => {
  assert.equal(U.cmpVer('1.27.12', '1.27.9'), 1);
  assert.equal(U.cmpVer('1.28.0', '1.28.0'), 0);
  assert.equal(U.cmpVer('1.9', '1.10.0'), -1);
  assert.equal(U.safeRel('lib\\core.js'), 'lib/core.js');
  assert.throws(() => U.safeRel('../x.js'), /insegura/);
  assert.throws(() => U.safeRel('/etc/x.js'), /insegura/);
  assert.throws(() => U.safeRel('C:/x.js'), /insegura/);
  assert.throws(() => U.safeRel('tools/ffmpeg.exe'), /no permitido/);
  assert.throws(() => U.safeRel('data/project.json'), /no puede tocar/);
});

test('detecta require() a archivos que no vienen en la actualización', () => {
  const staged = new Map([['server.js', "require('./lib/core');require('./lib/nuevo');require('node:fs');require('./channel_style.json')"], ['lib/core.js', "require('./otro')"]]);
  const onDisk = new Set(['channel_style.json', 'lib/otro.js']);
  assert.deepEqual(U.missingRequires(staged, r => onDisk.has(r)), [{ file: 'server.js', require: 'lib/nuevo' }]);
  assert.deepEqual(U.localRequires('lib/a.js', "require('../server')"), ['server']);
  assert.deepEqual(U.localRequires('a.js', "// require('./comentado')\n/* require('./x') */ const u='https://x'; require('./si')"), ['si']);
});

test('actualiza respaldando antes, y "volver" regresa a lo anterior y pausa la versión mala', async () => {
  const srv = await fakeServer();
  try {
    const root = tmpApp({ 'server.js': "// v1\n", 'app.js': 'var v=1;', 'data/project.json': '{"mio":true}' });
    release(srv, '1.1.0', { 'server.js': '// v2\n', 'app.js': 'var v=2;', 'lib/nuevo.js': 'module.exports=2;' }, 'arreglos');
    const u1 = mk(root, '1.0.0', srv);
    const c = await u1.checkUpdate();
    assert.equal(c.hasUpdate, true); assert.equal(c.latest, '1.1.0'); assert.equal(c.notes, 'arreglos');
    const a = await u1.applyUpdate();
    assert.equal(a.applied, 3);
    assert.match(a.message, /volver a la 1\.0\.0/);
    assert.equal(read(root, 'app.js'), 'var v=2;');
    // Respaldo en data/backups/<versión>-<fecha>/
    const backups = fs.readdirSync(path.join(root, 'data', 'backups'));
    assert.equal(backups.length, 1); assert.match(backups[0], /^1\.0\.0-\d{8}-\d{6}$/);
    assert.equal(read(root, `data/backups/${backups[0]}/files/app.js`), 'var v=1;');
    // Sin reiniciar no se encadenan cambios de versión.
    await assert.rejects(() => u1.rollback(), /Cierra y vuelve a abrir/);

    // "Reinicio": ahora corre la 1.1.0.
    const u2 = mk(root, '1.1.0', srv);
    const info = await u2.rollbackInfo();
    assert.equal(info.previous.version, '1.0.0');
    const r = await u2.rollback();
    assert.equal(r.restored, '1.0.0'); assert.equal(r.from, '1.1.0');
    assert.equal(read(root, 'app.js'), 'var v=1;');
    assert.equal(read(root, 'server.js'), '// v1\n');
    assert.equal(read(root, 'data/project.json'), '{"mio":true}', 'los datos del usuario no se tocan');
    assert.equal((await u2.listBackups()).length, 0, 'el respaldo usado se quita');

    // Ya en la 1.0.0: la 1.1.0 NO se vuelve a ofrecer sola…
    const u3 = mk(root, '1.0.0', srv);
    const c3 = await u3.checkUpdate();
    assert.equal(c3.hasUpdate, false); assert.equal(c3.paused, '1.1.0');
    const a3 = await u3.applyUpdate();
    assert.equal(a3.applied, 0); assert.match(a3.message, /pausada/);
    assert.equal(read(root, 'app.js'), 'var v=1;');
    // …pero una versión más nueva (el arreglo) sí.
    release(srv, '1.1.1', { 'app.js': 'var v=3;' });
    assert.equal((await u3.checkUpdate()).hasUpdate, true);
  } finally { await srv.close(); }
});

test('se puede instalar de todos modos una versión pausada (force) y deja de estar pausada', async () => {
  const srv = await fakeServer();
  try {
    const root = tmpApp({ 'app.js': 'var v=1;' });
    release(srv, '2.0.0', { 'app.js': 'var v=2;' });
    await mk(root, '1.0.0', srv).applyUpdate();
    await mk(root, '2.0.0', srv).rollback();
    const u = mk(root, '1.0.0', srv);
    assert.equal((await u.applyUpdate()).applied, 0);
    assert.equal((await u.applyUpdate({ force: true })).applied, 1);
    assert.equal(read(root, 'app.js'), 'var v=2;');
    assert.deepEqual((await mk(root, '2.0.0', srv).rollbackInfo()).paused, []);
  } finally { await srv.close(); }
});

test('conserva solo los últimos 3 respaldos y cada "volver" regresa una versión más', async () => {
  const srv = await fakeServer();
  try {
    const root = tmpApp({ 'app.js': 'v1' });
    const vs = ['1.0.0', '1.0.1', '1.0.2', '1.0.3', '1.0.4'];
    for (let i = 1; i < vs.length; i++) { release(srv, vs[i], { 'app.js': 'v' + (i + 1) }); await mk(root, vs[i - 1], srv).applyUpdate(); }
    const list = await mk(root, '1.0.4', srv).listBackups();
    assert.deepEqual(list.map(b => b.version), ['1.0.3', '1.0.2', '1.0.1']);
    assert.equal(fs.readdirSync(path.join(root, 'data', 'backups')).length, 3);
    await mk(root, '1.0.4', srv).rollback();
    assert.equal(read(root, 'app.js'), 'v4');
    await mk(root, '1.0.3', srv).rollback();
    assert.equal(read(root, 'app.js'), 'v3');
    const info = await mk(root, '1.0.2', srv).rollbackInfo();
    assert.equal(info.previous.version, '1.0.1');
    assert.deepEqual(info.paused, ['1.0.3', '1.0.4']);
  } finally { await srv.close(); }
});

test('si falla una descarga no se cambia NADA (ni se crea respaldo)', async () => {
  const srv = await fakeServer();
  try {
    const root = tmpApp({ 'server.js': '// v1', 'app.js': 'var v=1;' });
    release(srv, '1.1.0', { 'server.js': '// v2', 'app.js': 'var v=2;' });
    srv.fail.add('app.js');
    await assert.rejects(() => mk(root, '1.0.0', srv).applyUpdate(), /No se pudo descargar app\.js.*No se cambió nada/);
    assert.equal(read(root, 'server.js'), '// v1');
    assert.equal(fs.existsSync(path.join(root, 'data', 'backups')), false);
  } finally { await srv.close(); }
});

test('rechaza actualizaciones rotas: JS con error de sintaxis, require faltante o JSON dañado', async () => {
  const srv = await fakeServer();
  try {
    const root = tmpApp({ 'server.js': '// v1', 'lib/core.js': '' });
    release(srv, '1.1.0', { 'server.js': 'function (', 'lib/core.js': '' });
    await assert.rejects(() => mk(root, '1.0.0', srv).applyUpdate(), /server\.js con errores/);
    release(srv, '1.1.0', { 'server.js': "require('./lib/core');require('./lib/updater');" });
    await assert.rejects(() => mk(root, '1.0.0', srv).applyUpdate(), /necesita lib\/updater/);
    release(srv, '1.1.0', { 'server.js': "require('./lib/core');require('./lib/updater');", 'lib/updater.js': 'module.exports={}' });
    assert.equal((await mk(root, '1.0.0', srv).applyUpdate()).applied, 2, 'con el archivo incluido sí pasa');
    const root2 = tmpApp({ 'x.json': '{}' });
    release(srv, '1.1.0', { 'x.json': '{roto' });
    await assert.rejects(() => mk(root2, '1.0.0', srv).applyUpdate(), /x\.json dañado/);
    assert.equal(read(root2, 'x.json'), '{}');
    release(srv, '1.1.0', { '../fuera.js': '1' });
    await assert.rejects(() => mk(root2, '1.0.0', srv).applyUpdate(), /insegura/);
  } finally { await srv.close(); }
});

test('sin respaldos, "volver" lo explica; un respaldo incompleto no se usa', async () => {
  const srv = await fakeServer();
  try {
    const root = tmpApp({ 'app.js': '1' });
    const u = mk(root, '1.0.0', srv);
    assert.equal((await u.rollbackInfo()).previous, null);
    await assert.rejects(() => u.rollback(), /No hay una versión anterior/);
    fs.mkdirSync(path.join(root, 'data', 'backups', '0.9.0-20260101-000000', 'files'), { recursive: true }); // sin meta.json
    assert.equal((await u.rollbackInfo()).previous, null);
  } finally { await srv.close(); }
});

// De punta a punta: el server.js REAL en una copia temporal de la app, apuntando al servidor falso (EMM_UPDATE_URL).
test('server.js: /api/update/check → apply → rollback-info → rollback con servidor falso', { timeout: 60000 }, async () => {
  const repo = path.join(__dirname, '..');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'emm-e2e-'));
  for (const f of ['server.js', 'app.js', 'index.html', 'style.css', 'vision.js', 'investigar.js', 'channel_style.json', 'package.json']) fs.copyFileSync(path.join(repo, f), path.join(root, f));
  fs.cpSync(path.join(repo, 'lib'), path.join(root, 'lib'), { recursive: true });
  const current = fs.readFileSync(path.join(root, 'server.js'), 'utf8').match(/const APP_VERSION = '([^']+)'/)[1];
  const next = current.replace(/(\d+)$/, n => String(+n + 1));
  const srv = await fakeServer();
  // La "versión nueva" es una app.js distinta; server.js nuevo = el mismo con otra versión (para que siga arrancando).
  const newServer = fs.readFileSync(path.join(root, 'server.js'), 'utf8').replace(`const APP_VERSION = '${current}'`, `const APP_VERSION = '${next}'`);
  release(srv, next, { 'server.js': newServer, 'app.js': '// app nueva\n', 'lib/updater.js': fs.readFileSync(path.join(repo, 'lib/updater.js'), 'utf8') }, 'prueba');
  const port = 4300 + Math.floor(Math.random() * 500);
  const start = () => new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, EDITOR_IRL_PORT: String(port), EMM_UPDATE_URL: srv.url }, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    p.stderr.on('data', b => { err += b; });
    p.stdout.on('data', b => { if (String(b).includes('127.0.0.1:' + port)) resolve(p); });
    p.on('exit', c => reject(Error('server.js salió con ' + c + ': ' + err)));
  });
  const post = async (u, body = {}) => { const r = await fetch(`http://127.0.0.1:${port}${u}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  let proc;
  try {
    proc = await start();
    const c = await post('/api/update/check');
    assert.equal(c.body.hasUpdate, true); assert.equal(c.body.latest, next);
    assert.equal((await post('/api/update/rollback-info')).body.previous, null);
    const a = await post('/api/update/apply');
    assert.equal(a.status, 200, JSON.stringify(a.body)); assert.equal(a.body.applied, 3);
    assert.equal(fs.readFileSync(path.join(root, 'app.js'), 'utf8'), '// app nueva\n');
    assert.ok(srv.hits.every(h => !/emm-clips-repo\/main/.test(h)));
    proc.kill(); await new Promise(r => proc.once('exit', r));
    proc = await start(); // "cerrar y volver a abrir"
    const info = (await post('/api/update/rollback-info')).body;
    assert.equal(info.current, next); assert.equal(info.previous.version, current);
    const rb = await post('/api/update/rollback', { id: info.previous.id });
    assert.equal(rb.status, 200, JSON.stringify(rb.body)); assert.equal(rb.body.restored, current);
    assert.equal(fs.readFileSync(path.join(root, 'app.js'), 'utf8'), fs.readFileSync(path.join(repo, 'app.js'), 'utf8'));
    assert.equal(fs.readFileSync(path.join(root, 'server.js'), 'utf8'), fs.readFileSync(path.join(repo, 'server.js'), 'utf8'));
    proc.kill(); await new Promise(r => proc.once('exit', r));
    proc = await start();
    const c2 = (await post('/api/update/check')).body;
    assert.equal(c2.current, current); assert.equal(c2.hasUpdate, false); assert.equal(c2.paused, next);
  } finally {
    if (proc && proc.exitCode == null) proc.kill();
    await srv.close();
  }
});
