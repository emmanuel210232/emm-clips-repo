'use strict';
// Herramientas de medición para pruebas de exportación (NO las usa la app; solo pruebas/benchmark).
// - makeSyncSource: video sintético tipo Kick (MPEG-TS, 1080p60 H.264 + AAC) con un fotograma BLANCO y un BEEP
//   de 1 kHz exactamente en cada segundo entero → permite medir la sincronía A/V después de exportar.
// - measureSync: encuentra los destellos (luma) y los beeps (silencedetect) del archivo y empareja cada destello con
//   el beep más cercano. offset = beep - destello (ms). Debe quedar dentro de ±1 fotograma (16.7 ms a 60 fps).
// - quality: PSNR/SSIM de B contra A (mismo número de fotogramas).
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

function findTool(name) {
  const cands = [process.env.FFMPEG_DIR && path.join(process.env.FFMPEG_DIR, name + '.exe'), path.join(__dirname, '..', 'tools', name + '.exe'), path.join(__dirname, '..', 'tools', name)].filter(Boolean);
  for (const c of cands) if (fs.existsSync(c)) return c;
  return name; // en el PATH
}
const FFMPEG = findTool('ffmpeg'), FFPROBE = findTool('ffprobe');

function sh(exe, args, { capture = 'stderr' } = {}) {
  return new Promise((resolve, reject) => {
    const c = spawn(exe, args, { windowsHide: true }); let out = '', err = '';
    c.stdout.on('data', b => { out += b; }); c.stderr.on('data', b => { err += b; if (err.length > 8e6) err = err.slice(-4e6); });
    c.on('error', reject);
    c.on('close', code => code === 0 ? resolve(capture === 'stdout' ? out : err + out) : reject(Error(`${path.basename(exe)} salió con ${code}: ${err.slice(-1500)}`)));
  });
}

async function makeSyncSource(out, { seconds = 240, encoder = 'libx264' } = {}) {
  const v = "testsrc2=s=1920x1080:r=60,drawbox=c=white:t=fill:enable='lt(mod(n\\,60)\\,1)',noise=alls=8:allf=t";
  const ch = 'if(lt(mod(t\\,1)\\,0.02)\\,0.5*sin(2*PI*1000*t)\\,0.003*sin(2*PI*220*t))';
  const enc = encoder === 'h264_nvenc' ? ['-c:v', 'h264_nvenc', '-preset', 'p4', '-profile:v', 'high', '-g', '120', '-bf', '2', '-b:v', '8M']
    : ['-c:v', 'libx264', '-preset', 'veryfast', '-profile:v', 'high', '-g', '120', '-bf', '2', '-b:v', '8M', '-maxrate', '10M', '-bufsize', '16M'];
  await sh(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', v, '-f', 'lavfi', '-i', `aevalsrc='${ch}|${ch}':s=48000`, '-t', String(seconds), ...enc, '-c:a', 'aac', '-b:a', '160k', '-f', 'mpegts', out]);
  return out;
}

async function measureSync(file, { fps = 60, threshold = 200 } = {}) {
  const vlog = await sh(FFMPEG, ['-hide_banner', '-i', file, '-map', '0:v:0', '-vf', 'scale=64:36,signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-', '-f', 'null', '-'], { capture: 'stdout' });
  const flashes = []; let t = null;
  for (const line of vlog.split(/\r?\n/)) {
    const m = line.match(/pts_time:([\d.]+)/); if (m) { t = +m[1]; continue; }
    const y = line.match(/YAVG=([\d.]+)/); if (y && t != null) { if (+y[1] > threshold && (!flashes.length || t - flashes[flashes.length - 1] > 0.5)) flashes.push(t); t = null; }
  }
  const alog = await sh(FFMPEG, ['-hide_banner', '-i', file, '-map', '0:a:0', '-af', 'highpass=f=600,silencedetect=n=-30dB:d=0.1', '-f', 'null', '-']);
  const beeps = [...alog.matchAll(/silence_end:\s*([\d.]+)/g)].map(m => +m[1]);
  const offsets = [], pairs = [], unpaired = [];
  for (const f of flashes) { let best = null; for (const b of beeps) if (best == null || Math.abs(b - f) < Math.abs(best - f)) best = b; if (best != null && Math.abs(best - f) < 0.3) { const ms = +((best - f) * 1000).toFixed(1); offsets.push(ms); pairs.push({ t: f, ms }); } else unpaired.push(f); }
  const abs = offsets.map(Math.abs); const maxAbs = abs.length ? Math.max(...abs) : null;
  return { flashes: flashes.length, beeps: beeps.length, paired: offsets.length, maxAbsMs: maxAbs, meanMs: offsets.length ? +(offsets.reduce((a, b) => a + b, 0) / offsets.length).toFixed(1) : null, withinOneFrame: maxAbs != null && maxAbs <= 1000 / fps + 0.5, offsets, pairs, unpaired, flashTimes: flashes, beepTimes: beeps };
}

async function probe(file) {
  const j = JSON.parse(await sh(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,nb_frames,width,height,r_frame_rate', '-of', 'json', file], { capture: 'stdout' }));
  return { duration: +j.format.duration, streams: j.streams };
}

// PSNR/SSIM de `test` contra `ref` (se comparan fotograma a fotograma desde el inicio).
async function quality(ref, test) {
  const log = await sh(FFMPEG, ['-hide_banner', '-i', test, '-i', ref, '-lavfi', '[0:v]settb=AVTB,setpts=PTS-STARTPTS[a];[1:v]settb=AVTB,setpts=PTS-STARTPTS[b];[a][b]ssim;[0:v]settb=AVTB,setpts=PTS-STARTPTS[c];[1:v]settb=AVTB,setpts=PTS-STARTPTS[d];[c][d]psnr', '-f', 'null', '-']);
  const ssim = log.match(/SSIM .*All:([\d.]+)/), psnr = log.match(/PSNR .*average:([\d.inf]+)/);
  return { ssim: ssim ? +ssim[1] : null, psnr: psnr ? (psnr[1] === 'inf' ? Infinity : +psnr[1]) : null };
}

// Decodifica todo el archivo y cuenta errores del decodificador (para verificar uniones con copia de stream).
async function decodeErrors(file) {
  const log = await sh(FFMPEG, ['-hide_banner', '-v', 'error', '-i', file, '-f', 'null', '-']);
  return log.split(/\r?\n/).filter(l => l.trim()).length;
}

module.exports = { FFMPEG, FFPROBE, sh, makeSyncSource, measureSync, probe, quality, decodeErrors };

if (require.main === module) {
  (async () => { const f = process.argv[2]; console.log(JSON.stringify({ ...(await probe(f)), sync: await measureSync(f) }, (k, v) => ['offsets', 'pairs', 'flashTimes', 'beepTimes'].includes(k) ? undefined : v, 1)); })().catch(e => { console.error(e.message); process.exit(1); });
}
