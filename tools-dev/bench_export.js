'use strict';
// Benchmark de exportación: tiempo, velocidad, calidad (PSNR/SSIM) y sincronía A/V, con y sin decodificación por GPU.
// NO lo usa la app; es para medir en la PC del usuario (RTX 3070) antes de activar cambios de exportación.
//
// Export representativo = el método de exportVideo en server.js: cada pedazo se abre con -ss PRE (15 s) ANTES y se
// corta exacto con trim/atrim; luego concat y una sola codificación (NVENC si hay, si no libx264 como la caída a CPU).
//
// Uso:
//   node tools-dev/bench_export.js                         (fuente sintética de 60 s, 1 corrida)
//   node tools-dev/bench_export.js --seconds 240 --runs 3
//   node tools-dev/bench_export.js --src "D:\directos\shifu.mpg" --clips 8 --clip-len 20
//   node tools-dev/bench_export.js --encoder libx264       (forzar CPU para comparar)
//   node tools-dev/bench_export.js --json resultado.json
// Con --src de un directo real la sincronía no se puede medir (no tiene destellos/beeps): sale "n/a".
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const AV = require('./avsync');
const { withHwaccel, probeCuda, isHwaccelFailure } = require('../lib/hwaccel');

function parseArgs(argv) {
  const o = { src: '', seconds: 60, encoder: 'auto', runs: 1, clips: 5, clipLen: 0, json: '', keep: false, pre: 15 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i], v = argv[i + 1];
    if (a === '--src') { o.src = v; i++; } else if (a === '--seconds') { o.seconds = +v; i++; } else if (a === '--encoder') { o.encoder = v; i++; }
    else if (a === '--runs') { o.runs = Math.max(1, +v | 0); i++; } else if (a === '--clips') { o.clips = Math.max(1, +v | 0); i++; }
    else if (a === '--clip-len') { o.clipLen = +v; i++; } else if (a === '--json') { o.json = v; i++; } else if (a === '--keep') o.keep = true;
    else if (a === '--help' || a === '-h') { console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 15).join('\n')); process.exit(0); }
  }
  return o;
}

// Pedazos repartidos en el video, con inicios NO enteros (como cortes reales) y lejos del inicio para que use el pre-roll.
function planClips(duration, n, len) {
  const L = len || Math.max(2, Math.min(20, duration / (n * 2)));
  const out = [], step = (duration - 1) / n;
  for (let i = 0; i < n; i++) {
    const s = +(Math.min(duration - L - 0.5, i * step + step * 0.3 + 0.37)).toFixed(3);
    if (s >= 0 && s + L <= duration) out.push({ start: s, end: +(s + L).toFixed(3) });
  }
  return out;
}

function exportArgs(src, clips, enc, pre, out) {
  const ins = clips.flatMap(k => { const p = Math.min(pre, k.start); return ['-ss', (k.start - p).toFixed(3), '-t', (k.end - k.start + p).toFixed(3), '-i', src]; });
  const f = [];
  clips.forEach((k, i) => {
    const p = Math.min(pre, k.start), L = k.end - k.start, fade = Math.min(0.03, L / 3);
    f.push(`[${i}:v]trim=start=${p.toFixed(3)}:end=${(p + L).toFixed(3)},setpts=PTS-STARTPTS[v${i}]`);
    f.push(`[${i}:a]atrim=start=${p.toFixed(3)}:end=${(p + L).toFixed(3)},asetpts=PTS-STARTPTS,afade=t=in:st=0:d=${fade.toFixed(3)},afade=t=out:st=${(L - fade).toFixed(3)}:d=${fade.toFixed(3)}[a${i}]`);
  });
  f.push(clips.map((_, i) => `[v${i}][a${i}]`).join('') + `concat=n=${clips.length}:v=1:a=1[v][a]`);
  return ['-hide_banner', '-y', ...ins, '-filter_complex', f.join(';'), '-map', '[v]', '-map', '[a]', ...enc, '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', out];
}

// Mismos parámetros que server.js (cutVnvenc / cutVx264 sin "render rápido"); "ref" = sin pérdida para medir calidad.
const ENC = {
  h264_nvenc: ['-c:v', 'h264_nvenc', '-pix_fmt', 'yuv420p', '-preset', 'p5', '-rc', 'vbr', '-cq', '18', '-b:v', '0'],
  libx264: ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'medium', '-crf', '18'],
  ref: ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'ultrafast', '-qp', '0'],
};

async function nvencWorks() {
  try { await AV.sh(AV.FFMPEG, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=256x144:d=0.2', ...ENC.h264_nvenc, '-f', 'null', '-']); return true; } catch { return false; }
}

async function timed(fn) { const t = process.hrtime.bigint(); await fn(); return Number(process.hrtime.bigint() - t) / 1e9; }
const median = a => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

async function main() {
  const o = parseArgs(process.argv);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'emm-bench-'));
  let src = o.src, synthetic = !src;
  if (synthetic) {
    src = path.join(dir, 'fuente.ts');
    process.stdout.write(`Generando fuente sintética MPEG-TS 1080p60 H.264+AAC de ${o.seconds} s… `);
    await AV.makeSyncSource(src, { seconds: o.seconds });
    console.log('listo.');
  }
  const info = await AV.probe(src);
  const clips = planClips(info.duration, o.clips, o.clipLen);
  const outLen = clips.reduce((a, k) => a + k.end - k.start, 0);
  const fps = (() => { const v = info.streams.find(s => s.codec_type === 'video'); const [n, d] = String(v && v.r_frame_rate || '60/1').split('/'); return (+n / (+d || 1)) || 60; })();
  const encName = o.encoder === 'auto' ? ((await nvencWorks()) ? 'h264_nvenc' : 'libx264') : o.encoder;
  if (!ENC[encName]) throw Error('Encoder desconocido: ' + encName);
  const cuda = await probeCuda(AV.FFMPEG);
  console.log(`Fuente: ${path.basename(src)} · ${info.duration.toFixed(1)} s · ${fps} fps · ${clips.length} pedazos = ${outLen.toFixed(1)} s de salida`);
  console.log(`Encoder: ${encName} · Decodificación GPU (CUDA/NVDEC): ${cuda ? 'disponible' : 'NO disponible → se omite esa variante'}`);

  const ref = path.join(dir, 'ref.mkv');
  await AV.sh(AV.FFMPEG, exportArgs(src, clips, ENC.ref, o.pre, ref).map(a => a === '-movflags' ? '-metadata' : a === '+faststart' ? 'comment=ref' : a));

  const variants = [{ name: `decodifica CPU + ${encName}`, gpu: false }];
  if (cuda) variants.push({ name: `decodifica GPU + ${encName}`, gpu: true });
  else variants.push({ name: `decodifica GPU + ${encName}`, gpu: true, skipped: 'sin CUDA/NVDEC en esta PC' });

  const results = [];
  for (const v of variants) {
    if (v.skipped) { results.push({ variant: v.name, skipped: v.skipped }); continue; }
    const out = path.join(dir, (v.gpu ? 'gpu' : 'cpu') + '.mp4');
    const times = [];
    let note = '';
    for (let r = 0; r < o.runs; r++) {
      const args = exportArgs(src, clips, ENC[encName], o.pre, out);
      try { times.push(await timed(() => AV.sh(AV.FFMPEG, v.gpu ? withHwaccel(args, { gpu: true }) : args))); }
      catch (e) { if (v.gpu && isHwaccelFailure(e.message)) { note = 'NVDEC falló → la app caería sola a CPU'; break; } throw e; }
    }
    if (!times.length) { results.push({ variant: v.name, skipped: note }); continue; }
    const t = median(times);
    const q = await AV.quality(ref, out);
    const sync = synthetic ? await AV.measureSync(out, { fps }) : null;
    const p = await AV.probe(out);
    results.push({
      variant: v.name, seconds: +t.toFixed(2), runs: times.map(x => +x.toFixed(2)), speed: +(outLen / t).toFixed(2), fps: +((outLen * fps) / t).toFixed(1),
      psnr: q.psnr === Infinity ? 'inf' : q.psnr, ssim: q.ssim, durationOut: +p.duration.toFixed(3), expected: +outLen.toFixed(3),
      syncMaxMs: sync ? sync.maxAbsMs : 'n/a', syncPairs: sync ? sync.paired : 'n/a', syncOk: sync ? sync.withinOneFrame : 'n/a', note,
    });
  }
  // CPU vs GPU directamente: la decodificación es exacta, así que deben salir prácticamente idénticos.
  if (results.length === 2 && results.every(r => !r.skipped)) {
    const q = await AV.quality(path.join(dir, 'cpu.mp4'), path.join(dir, 'gpu.mp4'));
    results.push({ variant: 'GPU vs CPU (mismo encoder)', psnr: q.psnr === Infinity ? 'inf' : q.psnr, ssim: q.ssim });
  }

  console.log('\n| Variante | Tiempo (s) | Velocidad (× tiempo real) | fps | PSNR (dB) | SSIM | Duración salida / esperada | Sincronía máx (ms) | ±1 cuadro |');
  console.log('|---|---|---|---|---|---|---|---|---|');
  for (const r of results) {
    if (r.skipped) { console.log(`| ${r.variant} | omitida: ${r.skipped} |||||||| `); continue; }
    console.log(`| ${r.variant} | ${r.seconds ?? ''} | ${r.speed ?? ''} | ${r.fps ?? ''} | ${r.psnr} | ${r.ssim} | ${r.durationOut != null ? r.durationOut + ' / ' + r.expected : ''} | ${r.syncMaxMs ?? ''} | ${r.syncOk === true ? 'sí' : r.syncOk === false ? 'NO' : r.syncOk ?? ''} |`);
  }
  const report = { date: new Date().toISOString(), host: os.hostname(), cpus: os.cpus()[0]?.model, src: synthetic ? `sintética ${o.seconds} s` : src, fps, encoder: encName, cuda, clips, results };
  if (o.json) { fs.writeFileSync(o.json, JSON.stringify(report, null, 2)); console.log(`\nJSON: ${o.json}`); }
  else console.log('\n' + JSON.stringify(report));
  if (!o.keep) fs.rmSync(dir, { recursive: true, force: true }); else console.log('Archivos en: ' + dir);
  const bad = results.some(r => r.syncOk === false);
  process.exit(bad ? 2 : 0);
}

module.exports = { planClips, exportArgs, ENC };
if (require.main === module) main().catch(e => { console.error('Error: ' + e.message); process.exit(1); });
