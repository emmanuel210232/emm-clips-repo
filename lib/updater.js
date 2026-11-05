'use strict';
// Actualizador de Emm Clips con RESPALDO y "Volver a la versión anterior".
//
// Cómo funciona:
// 1. checkUpdate(): lee version.json del servidor de actualizaciones. Si la versión nueva es una de la que el usuario
//    ya se regresó ("pausada"), NO se ofrece sola (solo con force desde el botón manual).
// 2. applyUpdate(): descarga TODO a memoria primero (si falla una descarga no se toca nada), revisa que los .js no
//    tengan errores de sintaxis y que sus require('./...') existan, respalda los archivos actuales en
//    data/backups/<versión>-<fecha>/ (se conservan los últimos 3) y hasta entonces reemplaza los archivos.
//    Si algo falla al escribir, se restaura el respaldo en ese momento.
// 3. rollback(): restaura el respaldo más reciente (o el que se pida), pausa la versión de la que se regresó para
//    que no se vuelva a ofrecer en seguida, y borra ese respaldo (su contenido ya es el que está en uso), así que
//    cada vez que se usa se regresa una versión más.
//
// No depende de server.js: recibe la carpeta de la app, la de datos, la versión actual y cómo descargar texto.
// También se puede usar desde la terminal si la app ya no abre:  node lib/updater.js volver
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ALLOWED_EXT = new Set(['.js', '.html', '.css', '.cmd', '.ps1', '.json']);
const KEEP_BACKUPS = 3;
const MAX_PAUSED = 10;

function cmpVer(a, b) {
  const pa = String(a).split('.').map(n => parseInt(n, 10) || 0), pb = String(b).split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) > (pb[i] || 0)) return 1; if ((pa[i] || 0) < (pb[i] || 0)) return -1; }
  return 0;
}

// Ruta relativa segura dentro de la app (sin "..", sin rutas absolutas, solo tipos de texto permitidos).
function safeRel(rel) {
  const s = String(rel || '').replace(/\\/g, '/').replace(/^\.\//, '');
  if (!s || s.split('/').includes('..') || s.startsWith('/') || /^[a-zA-Z]:/.test(s)) throw Error('Ruta insegura en la actualización: ' + rel);
  if (!ALLOWED_EXT.has(path.extname(s).toLowerCase())) throw Error('Tipo de archivo no permitido: ' + rel);
  if (/^(data|exports|tools|tools-gpu|runtime|\.git)\//i.test(s)) throw Error('La actualización no puede tocar esa carpeta: ' + rel);
  return s;
}

// "2026-11-05T14:03:09.123Z" → "20261105-140309" (en hora local, para que el usuario la reconozca).
function stamp(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// require('./algo') y require("../lib/x") en un archivo JS → rutas relativas a la app (sin resolver extensión).
function localRequires(fileRel, code) {
  const out = [];
  const re = /require\(\s*(['"])(\.{1,2}\/[^'"]+)\1\s*\)/g;
  // Sin comentarios (un ejemplo "require('./...')" en un comentario no es una dependencia real).
  const src = String(code).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[\s;{}()])\/\/.*$/gm, '$1');
  let m;
  while ((m = re.exec(src))) if (!m[2].includes('...')) out.push(path.posix.normalize(path.posix.join(path.posix.dirname(fileRel), m[2])));
  return out;
}
// Igual que Node: "lib/core" puede ser lib/core, lib/core.js, lib/core.json o lib/core/index.js.
function requireCandidates(rel) { return [rel, rel + '.js', rel + '.json', rel + '/index.js']; }

// Qué require('./...') de los archivos nuevos no van a existir después de actualizar.
// staged: Map(rel → contenido nuevo). existsOnDisk(rel) → bool.
function missingRequires(staged, existsOnDisk) {
  const missing = [];
  for (const [rel, code] of staged) {
    if (path.extname(rel).toLowerCase() !== '.js') continue;
    for (const dep of localRequires(rel, code)) {
      if (dep.startsWith('..')) continue; // fuera de la app: no es nuestro
      if (!requireCandidates(dep).some(c => staged.has(c) || existsOnDisk(c))) missing.push({ file: rel, require: dep });
    }
  }
  return missing;
}

// Revisa la sintaxis de un .js con el mismo Node que corre la app (no lo ejecuta).
function syntaxError(file) {
  const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  if (r.status === 0) return '';
  return String(r.stderr || r.error || 'error de sintaxis').split(/\r?\n/).filter(Boolean).slice(0, 4).join(' · ');
}

async function writeAtomic(dest, content) {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const tmp = dest + '.emmtmp';
  await fsp.writeFile(tmp, content);
  await fsp.rename(tmp, dest);
}

function createUpdater({ root, dataDir, currentVersion, baseUrl, fetchText, keep = KEEP_BACKUPS, now = () => new Date(), checkSyntax = true } = {}) {
  if (!root || !dataDir) throw Error('createUpdater: falta root o dataDir');
  const backupsDir = path.join(dataDir, 'backups');
  const stateFile = path.join(dataDir, 'update_state.json');
  const stagingDir = path.join(dataDir, 'update_staging');
  const base = String(baseUrl || '').replace(/\/?$/, '/');
  // Después de actualizar o regresar, el código nuevo NO corre hasta reiniciar: no dejar encadenar operaciones
  // (si no, la "versión actual" en memoria ya no corresponde a los archivos del disco).
  let pendingRestart = null;

  const readState = () => { try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')) || {}; } catch { return {}; } };
  const writeState = s => { fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(stateFile, JSON.stringify(s, null, 2), 'utf8'); };
  const pausedVersions = () => (readState().paused || []).map(p => String(p.version));
  const inside = rel => { const d = path.resolve(root, rel); if (d !== path.resolve(root) && !d.startsWith(path.resolve(root) + path.sep)) throw Error('Destino fuera de la app: ' + rel); return d; };
  const busy = () => { if (pendingRestart) throw Error(`Ya ${pendingRestart}. Cierra y vuelve a abrir la app antes de hacer otro cambio de versión.`); };

  async function fetchManifest() {
    if (!base || base === '/') throw Error('No hay servidor de actualizaciones configurado.');
    const txt = await fetchText(base + 'version.json?t=' + Date.now());
    let m; try { m = JSON.parse(txt); } catch { throw Error('El archivo de versión del servidor no es válido.'); }
    return { version: String(m.version || '0'), notes: String(m.notes || ''), files: Array.isArray(m.files) ? m.files : [] };
  }

  async function checkUpdate() {
    const m = await fetchManifest();
    const newer = cmpVer(m.version, currentVersion) > 0;
    const paused = newer && pausedVersions().includes(m.version);
    return { current: currentVersion, latest: m.version, hasUpdate: newer && !paused, paused: paused ? m.version : null, notes: m.notes, files: m.files, pendingRestart: !!pendingRestart };
  }

  async function listBackups() {
    let names = [];
    try { names = await fsp.readdir(backupsDir); } catch { return []; }
    const out = [];
    for (const id of names) {
      try {
        const meta = JSON.parse(await fsp.readFile(path.join(backupsDir, id, 'meta.json'), 'utf8'));
        if (meta && meta.version && Array.isArray(meta.files)) out.push({ id, version: String(meta.version), createdAt: String(meta.createdAt || ''), replacedBy: String(meta.replacedBy || ''), files: meta.files });
      } catch { /* carpeta incompleta: no cuenta como respaldo */ }
    }
    return out.sort((a, b) => (b.createdAt > a.createdAt ? 1 : b.createdAt < a.createdAt ? -1 : b.id.localeCompare(a.id)));
  }

  async function pruneBackups() {
    const list = await listBackups();
    for (const b of list.slice(Math.max(1, keep))) await fsp.rm(path.join(backupsDir, b.id), { recursive: true, force: true });
    // Restos de respaldos sin meta.json (p. ej. se apagó la PC a la mitad).
    try { for (const id of await fsp.readdir(backupsDir)) if (!fs.existsSync(path.join(backupsDir, id, 'meta.json'))) await fsp.rm(path.join(backupsDir, id), { recursive: true, force: true }); } catch {}
  }

  // Copia los archivos actuales (los que la actualización va a reemplazar) a data/backups/<versión>-<fecha>/.
  async function makeBackup(rels, replacedBy) {
    const d = now();
    let id = `${currentVersion}-${stamp(d)}`, n = 1;
    while (fs.existsSync(path.join(backupsDir, id))) id = `${currentVersion}-${stamp(d)}-${++n}`;
    const dir = path.join(backupsDir, id);
    const files = [], added = [];
    for (const rel of rels) {
      const src = inside(rel);
      if (!fs.existsSync(src)) { added.push(rel); continue; }
      const dest = path.join(dir, 'files', rel);
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.copyFile(src, dest);
      files.push(rel);
    }
    // meta.json AL FINAL: un respaldo sin meta.json se considera incompleto y no se usa.
    await writeAtomic(path.join(dir, 'meta.json'), JSON.stringify({ version: currentVersion, createdAt: d.toISOString(), replacedBy, files, added }, null, 2));
    return { id, dir, files, added };
  }

  async function restoreFrom(dir, files) {
    for (const rel of files) await writeAtomic(inside(rel), await fsp.readFile(path.join(dir, 'files', rel)));
  }

  async function applyUpdate({ force = false } = {}) {
    busy();
    const m = await fetchManifest();
    if (cmpVer(m.version, currentVersion) <= 0) return { applied: 0, latest: m.version, message: `Ya tienes la última versión (${currentVersion}).` };
    if (!force && pausedVersions().includes(m.version)) return { applied: 0, latest: m.version, paused: m.version, message: `La versión ${m.version} está pausada porque regresaste de ella. Si quieres probarla otra vez, búscala desde ⚙️ Configuración.` };
    const rels = [...new Set(m.files.map(safeRel))];
    if (!rels.length) throw Error('La actualización no trae archivos.');
    rels.forEach(inside);

    // 1) Descargar TODO antes de tocar algo.
    const staged = new Map();
    for (const rel of rels) {
      try { staged.set(rel, await fetchText(base + rel.split('/').map(encodeURIComponent).join('/') + '?t=' + Date.now())); }
      catch (e) { throw Error(`No se pudo descargar ${rel} (${e.message}). No se cambió nada.`); }
    }
    // 2) Revisar que lo descargado sirva (si no, la app podría ya no abrir y no habría botón para regresar).
    for (const [rel, txt] of staged) {
      if (path.extname(rel).toLowerCase() === '.json') { try { JSON.parse(txt); } catch { throw Error(`La actualización trae ${rel} dañado. No se cambió nada.`); } }
    }
    const missing = missingRequires(staged, rel => { try { return fs.statSync(inside(rel)).isFile(); } catch { return false; } });
    if (missing.length) throw Error(`La actualización está incompleta: ${missing[0].file} necesita ${missing[0].require}, que no viene en la lista de archivos. No se cambió nada.`);
    if (checkSyntax) {
      await fsp.rm(stagingDir, { recursive: true, force: true });
      try {
        for (const [rel, txt] of staged) {
          if (path.extname(rel).toLowerCase() !== '.js') continue;
          const f = path.join(stagingDir, rel);
          await fsp.mkdir(path.dirname(f), { recursive: true });
          await fsp.writeFile(f, txt, 'utf8');
          const err = syntaxError(f);
          if (err) throw Error(`La actualización trae ${rel} con errores (${err}). No se cambió nada.`);
        }
      } finally { await fsp.rm(stagingDir, { recursive: true, force: true }); }
    }
    // 3) Respaldar lo actual.
    const backup = await makeBackup(rels, m.version);
    // 4) Reemplazar. Si falla a la mitad (disco lleno, antivirus), regresar lo respaldado.
    let applied = 0;
    try {
      for (const [rel, txt] of staged) { await writeAtomic(inside(rel), Buffer.from(txt, 'utf8')); applied++; }
    } catch (e) {
      try { await restoreFrom(backup.dir, backup.files); await fsp.rm(backup.dir, { recursive: true, force: true }); } catch {}
      throw Error(`No se pudo instalar la actualización (${e.message}). Se dejó la versión ${currentVersion} como estaba.`);
    }
    // Si el usuario forzó una versión pausada, ya no está pausada.
    const st = readState();
    st.paused = (st.paused || []).filter(p => String(p.version) !== m.version);
    st.lastUpdate = { from: currentVersion, to: m.version, at: now().toISOString(), backup: backup.id };
    writeState(st);
    await pruneBackups();
    pendingRestart = `se instaló la versión ${m.version}`;
    return { applied, latest: m.version, backup: backup.id, previous: currentVersion, message: `Actualizado a la versión ${m.version}. Cierra y vuelve a abrir la app para aplicar los cambios. Si algo falla, en ⚙️ Configuración puedes volver a la ${currentVersion}.` };
  }

  // Lo que el botón "Volver a la versión anterior" necesita mostrar (funciona sin internet).
  async function rollbackInfo() {
    const list = await listBackups();
    const prev = list[0] || null;
    return { current: currentVersion, previous: prev ? { id: prev.id, version: prev.version, createdAt: prev.createdAt } : null, backups: list.map(b => ({ id: b.id, version: b.version, createdAt: b.createdAt })), paused: pausedVersions(), pendingRestart: !!pendingRestart };
  }

  async function rollback({ id } = {}) {
    busy();
    const list = await listBackups();
    const b = id ? list.find(x => x.id === String(id)) : list[0];
    if (!b) throw Error(id ? 'No encontré ese respaldo.' : 'No hay una versión anterior guardada. Los respaldos se crean cuando la app se actualiza.');
    const dir = path.join(backupsDir, b.id);
    const files = b.files.map(safeRel);
    for (const rel of files) if (!fs.existsSync(path.join(dir, 'files', rel))) throw Error(`El respaldo ${b.id} está incompleto (falta ${rel}). No se cambió nada.`);
    await restoreFrom(dir, files);
    const st = readState();
    const from = currentVersion;
    if (cmpVer(from, b.version) !== 0) {
      st.paused = [{ version: from, at: now().toISOString(), restored: b.version }, ...(st.paused || []).filter(p => String(p.version) !== from)].slice(0, MAX_PAUSED);
    }
    st.lastRollback = { from, to: b.version, at: now().toISOString(), backup: b.id };
    writeState(st);
    await fsp.rm(dir, { recursive: true, force: true });
    pendingRestart = `regresaste a la versión ${b.version}`;
    return { restored: b.version, from, files: files.length, message: `Listo: regresaste a la versión ${b.version}. Cierra y vuelve a abrir la app para usarla. La ${from} no se te volverá a ofrecer sola.` };
  }

  // Quitar la pausa de una versión (por si el usuario quiere que se le vuelva a ofrecer sola).
  function unpause(version) {
    const st = readState();
    st.paused = (st.paused || []).filter(p => String(p.version) !== String(version));
    writeState(st);
    return { paused: pausedVersions() };
  }

  return { checkUpdate, applyUpdate, rollback, rollbackInfo, listBackups, unpause, isPendingRestart: () => !!pendingRestart };
}

module.exports = { createUpdater, cmpVer, safeRel, localRequires, missingRequires, stamp, KEEP_BACKUPS };

// Uso de emergencia desde la terminal (si la versión nueva ya no deja abrir la app):
//   node lib/updater.js volver      → regresa a la versión anterior
//   node lib/updater.js respaldos   → lista los respaldos
if (require.main === module) {
  (async () => {
    const root = path.resolve(__dirname, '..');
    let current = '0';
    try { const m = fs.readFileSync(path.join(root, 'server.js'), 'utf8').match(/const APP_VERSION\s*=\s*'([^']+)'/); if (m) current = m[1]; } catch {}
    const u = createUpdater({ root, dataDir: path.join(root, 'data'), currentVersion: current, fetchText: async () => { throw Error('sin red'); } });
    const cmd = String(process.argv[2] || '').toLowerCase();
    if (cmd === 'volver' || cmd === 'rollback') {
      const r = await u.rollback({ id: process.argv[3] });
      console.log(r.message);
    } else if (cmd === 'respaldos' || cmd === 'list') {
      const info = await u.rollbackInfo();
      console.log(`Versión actual: ${info.current}`);
      if (!info.backups.length) console.log('No hay respaldos.');
      for (const b of info.backups) console.log(`  ${b.id}  (versión ${b.version}, ${b.createdAt})`);
    } else {
      console.log('Uso: node lib/updater.js volver | respaldos');
    }
  })().catch(e => { console.error('Error: ' + e.message); process.exit(1); });
}
