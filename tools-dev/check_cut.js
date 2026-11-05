'use strict';
// ¿El corte cae en el CUADRO pedido? Compara el método actual del export (abrir con -ss unos segundos antes y cortar
// con trim relativo) contra -copyts + trim en tiempo absoluto, usando como referencia el cuadro decodificado desde el
// inicio del archivo (sin saltos). Solo mide; no cambia nada de la app.
// Uso:
//   node tools-dev/check_cut.js                          → crea una fuente sintética MPEG-TS y la mide
//   node tools-dev/check_cut.js --src "D:\directo.mpg"   → mide un directo real (con el ffmpeg de tools/)
//   opciones: --times 37.5,61.25,88.9  --pre 15  --window 200 (cuadros a cada lado para buscar)
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function tool(name) {
  for (const c of [process.env.FFMPEG_DIR && path.join(process.env.FFMPEG_DIR, name + '.exe'), path.join(__dirname, '..', 'tools', name + '.exe')]) if (c && fs.existsSync(c)) return c;
  return name;
}
const FFMPEG = tool('ffmpeg'), FFPROBE = tool('ffprobe');
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
function run(bin, args) { const r = spawnSync(bin, args, { maxBuffer: 1 << 30, windowsHide: true }); if (r.status !== 0) throw Error(`${path.basename(bin)}: ${String(r.stderr).slice(-600)}`); return r.stdout; }
const W = 160, H = 90, FB = W * H; // comparar en chico y gris: suficiente para distinguir cuadros

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'emm-cut-'));
let src = arg('src');
if (!src) {
  src = path.join(tmp, 'src.ts');
  run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=60', '-f', 'lavfi', '-i', 'sine=f=440:sample_rate=48000', '-t', '120', '-c:v', 'libx264', '-preset', 'veryfast', '-g', '120', '-bf', '2', '-c:a', 'aac', '-f', 'mpegts', src]);
}
const probe = JSON.parse(String(run(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'format=start_time,duration:stream=r_frame_rate,start_time', '-of', 'json', src])));
const fmtStart = +probe.format.start_time || 0, vStart = +probe.streams[0].start_time || fmtStart;
const [fn, fd] = String(probe.streams[0].r_frame_rate).split('/').map(Number); const fps = fn / (fd || 1);
const dur = +probe.format.duration;
const times = String(arg('times', [0.25, 0.5, 0.75].map(f => +(dur * f).toFixed(2)).join(','))).split(',').map(Number);
const PRE = +arg('pre', 15), WIN = +arg('window', 200);
const vf = `scale=${W}:${H},format=gray`;
const frameAt = extra => run(FFMPEG, ['-hide_banner', '-loglevel', 'error', ...extra, '-frames:v', '1', '-f', 'rawvideo', '-']);

console.log(`Archivo: ${src}\nstart_time formato ${fmtStart.toFixed(3)} s · video ${vStart.toFixed(3)} s · ${fps.toFixed(2)} fps · ${dur.toFixed(1)} s`);
const rows = [];
for (const t of times) {
  // Cuadro que se ve en el reproductor en el tiempo t (tiempo relativo al inicio del archivo, como en la app).
  const n = Math.ceil((t - (vStart - fmtStart)) * fps - 1e-6);
  const a = Math.max(0, n - WIN);
  const win = run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-i', src, '-vf', `select=between(n\\,${a}\\,${n + WIN}),${vf}`, '-fps_mode', 'passthrough', '-f', 'rawvideo', '-']);
  const find = buf => { for (let i = 0; i * FB < win.length; i++) if (win.subarray(i * FB, (i + 1) * FB).equals(buf.subarray(0, FB))) return a + i - n; return null; };
  const p = Math.min(PRE, t), s = t - p;
  const actual = frameAt(['-ss', s.toFixed(3), '-t', (p + 2).toFixed(3), '-i', src, '-vf', `trim=start=${p.toFixed(3)},setpts=PTS-STARTPTS,${vf}`]);
  const abs = frameAt(['-copyts', '-ss', s.toFixed(3), '-t', (p + 2).toFixed(3), '-i', src, '-vf', `trim=start=${(fmtStart + t).toFixed(4)},setpts=PTS-STARTPTS,${vf}`]);
  rows.push({ t, cuadro: n, actual: find(actual), copyts: find(abs) });
}
console.log('\n  tiempo   cuadro   método actual   -copyts + trim absoluto   (diferencia en cuadros; 0 = exacto)');
for (const r of rows) console.log(`  ${String(r.t).padStart(7)}  ${String(r.cuadro).padStart(7)}  ${String(r.actual ?? 'fuera').padStart(14)}  ${String(r.copyts ?? 'fuera').padStart(24)}`);
fs.rmSync(tmp, { recursive: true, force: true });
const bad = rows.some(r => r.actual !== 0);
console.log(bad ? '\n⚠️ El método actual NO cae en el cuadro pedido en al menos un tiempo.' : '\n✅ El método actual cae en el cuadro pedido.');
process.exitCode = bad ? 1 : 0;
