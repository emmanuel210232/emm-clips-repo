'use strict';
// De punta a punta con ffmpeg real: el PNG de "Guardar miniatura" (/api/thumbs/save) y el JPG de la galería
// (/api/thumbs/frame) deben ser EXACTAMENTE el cuadro que muestra el reproductor en ese tiempo, en un MPEG-TS
// (como las descargas de Kick), donde `-ss` solo no cae donde se pide. Referencia: el cuadro decodificado desde
// el inicio del archivo, sin saltos. Se salta si no hay ffmpeg en el PATH.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0;
const W = 160, H = 90, FB = W * H;
const gray = (input, extra = []) => spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...extra, '-i', input, '-vf', `scale=${W}:${H}:flags=bicubic,format=gray`, '-f', 'rawvideo', '-'], { maxBuffer: 1 << 30 }).stdout;
const mad = (a, b) => { let s = 0; for (let i = 0; i < FB; i++) s += Math.abs(a[i] - b[i]); return s / FB; };

test('miniaturas: el PNG y el JPG de la galería son el cuadro exacto del tiempo pedido (MPEG-TS)', { skip: !hasFfmpeg && 'sin ffmpeg en el PATH', timeout: 180000 }, async () => {
  const repo = path.join(__dirname, '..');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'emm-thumbs-'));
  for (const f of ['server.js', 'app.js', 'index.html', 'style.css', 'vision.js', 'investigar.js', 'channel_style.json', 'package.json']) fs.copyFileSync(path.join(repo, f), path.join(root, f));
  fs.cpSync(path.join(repo, 'lib'), path.join(root, 'lib'), { recursive: true });
  for (const f of ['miniaturas.js', 'cola.js']) if (fs.existsSync(path.join(repo, f))) fs.copyFileSync(path.join(repo, f), path.join(root, f));
  // Fuente tipo Kick: MPEG-TS con extensión .mpg, 60 fps, GOP de 2 s, B-frames, start_time ≠ 0.
  const src = path.join(root, 'directo.mpg');
  const mk = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=60', '-f', 'lavfi', '-i', 'sine=f=440:sample_rate=48000',
    '-t', '75', '-c:v', 'libx264', '-preset', 'veryfast', '-g', '120', '-bf', '2', '-c:a', 'aac', '-f', 'mpegts', src]);
  assert.equal(mk.status, 0, String(mk.stderr));
  const fmtStart = parseFloat(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=start_time', '-of', 'default=nw=1:nk=1', src], { encoding: 'utf8' }).stdout);
  const vStart = parseFloat(spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=start_time', '-of', 'default=nw=1:nk=1', src], { encoding: 'utf8' }).stdout);
  assert.ok(fmtStart > 0.5, 'la fuente tiene start_time como un MPEG-TS real');
  const all = gray(src); // todos los cuadros, decodificados desde el inicio
  const nFrames = all.length / FB;

  const port = 4700 + Math.floor(Math.random() * 400);
  const proc = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, EDITOR_IRL_PORT: String(port), EMM_UPDATE_URL: 'http://127.0.0.1:9/' }, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await new Promise((res, rej) => { proc.stdout.on('data', b => { if (String(b).includes(':' + port)) res(); }); proc.on('exit', c => rej(Error('server.js salió con ' + c))); });
    const post = async (u, body = {}) => { const r = await fetch(`http://127.0.0.1:${port}${u}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); const j = await r.json(); assert.equal(r.status, 200, JSON.stringify(j)); return j; };
    await post('/api/project/open', { path: src });
    for (const t of [3.5, 20.25, 37.5, 52.1, 70.0]) {
      // Cuadro que muestra el reproductor en t (tiempo desde el inicio del archivo): el primero con pts ≥ t.
      const n = Math.ceil((t - (vStart - fmtStart)) * 60 - 1e-6);
      const closest = buf => { if (buf.length < FB) throw Error(`imagen vacía (${buf.length} bytes); cuadros ${nFrames}`); let best = null; for (let i = Math.max(0, n - 150); i < Math.min(nFrames, n + 150); i++) { const d = mad(buf, all.subarray(i * FB, (i + 1) * FB)); if (!best || d < best.d) best = { i, d }; } return best.i - n; };
      const saved = await post('/api/thumbs/save', { t });
      const png = path.join(root, 'exports', saved.name);
      const probe = JSON.parse(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height,pix_fmt', '-of', 'json', png], { encoding: 'utf8' }).stdout).streams[0];
      assert.deepEqual([probe.width, probe.height], [640, 360], 'PNG a resolución completa');
      assert.equal(closest(gray(png)), 0, `PNG en t=${t} debe ser el cuadro ${n}`);
      const r = await fetch(`http://127.0.0.1:${port}/api/thumbs/frame?t=${t}&w=320`);
      assert.equal(r.status, 200);
      const jpg = path.join(root, `g_${t}.jpg`); fs.writeFileSync(jpg, Buffer.from(await r.arrayBuffer()));
      assert.equal(closest(gray(jpg)), 0, `JPG de la galería en t=${t} debe ser el cuadro ${n}`);
    }
  } finally { proc.kill(); }
});
