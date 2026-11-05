'use strict';
// DECODIFICACIÓN POR GPU (NVDEC) para los exports, con respaldo automático a CPU.
//
// ¿Cambia la calidad? NO. Decodificar H.264 es exacto (el estándar define bit a bit el resultado): el cuadro que sale de
// NVDEC es idéntico al que sale del CPU. Solo cambia QUIÉN hace el trabajo; el CPU queda libre para los filtros
// (trim, concat, xfade, crop, audio) y NVENC sigue codificando con los mismos parámetros.
//
// ¿Por qué SIN "-hwaccel_output_format cuda"? Con esa opción los cuadros se quedan en memoria de video y los filtros de
// CPU que usa la app (trim/setpts/concat/xfade/crop/drawtext/hue) ya no funcionarían sin reescribir todo con filtros
// *_cuda. Además, en exportBatched cada tanda abre hasta ~100 entradas ("tramos"); con superficies en GPU cada entrada
// reserva su propio pool de cuadros 1080p en VRAM (decenas de MB por entrada) → en una RTX 3070 (8 GB) puede acabarse
// la memoria. Sin esa opción NVDEC decodifica y copia cada cuadro a memoria normal: cero cambios en los filtros y
// memoria de video acotada.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

function decodeArgs({ gpu = false } = {}) { return gpu ? ['-hwaccel', 'cuda'] : []; }

// Entradas que NO son un video para decodificar (no llevan -hwaccel).
const NON_VIDEO_EXT = /\.(png|jpe?g|bmp|gif|webp|ass|ssa|srt|txt|wav|mp3|m4a|aac|flac|ogg|opus|json)$/i;
// Opciones de ffmpeg que toman un valor (para saber dónde empieza el bloque de opciones de cada entrada).
const INPUT_OPTS_WITH_VALUE = new Set(['-ss', '-t', '-to', '-sseof', '-itsoffset', '-f', '-r', '-c', '-c:v', '-c:a', '-codec', '-vcodec', '-acodec', '-safe', '-stream_loop', '-thread_queue_size', '-hwaccel', '-hwaccel_device', '-hwaccel_output_format', '-framerate', '-video_size', '-pix_fmt', '-analyzeduration', '-probesize', '-fflags', '-loop']);

// Inserta los args de decodificación antes del bloque de opciones de CADA "-i <video>".
// No toca: entradas con "-f lavfi" / "-f concat" (generadores y listas), imágenes, subtítulos ni audio suelto,
// ni entradas que ya traen su propio -hwaccel.
function withHwaccel(args, opts = {}) {
  const dec = decodeArgs(opts);
  if (!dec.length) return args.slice();
  const out = [];
  let blockStart = 0; // índice en `out` donde empiezan las opciones de la entrada actual
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-i' && i + 1 < args.length) {
      const file = String(args[i + 1]);
      const block = out.slice(blockStart);
      const fIdx = block.lastIndexOf('-f');
      const fmt = fIdx >= 0 ? String(block[fIdx + 1]) : '';
      const skip = fmt === 'lavfi' || fmt === 'concat' || /^(anullsrc|color|testsrc|sine|aevalsrc)/.test(file)
        || NON_VIDEO_EXT.test(file) || block.includes('-hwaccel');
      if (!skip) out.splice(blockStart, 0, ...dec);
      out.push(a, args[i + 1]);
      i++;
      blockStart = out.length;
      continue;
    }
    // Opciones de SALIDA o globales (-y, -filter_complex, -map…) cierran el bloque: lo que siga ya no es de una entrada.
    if (a.startsWith('-') && !INPUT_OPTS_WITH_VALUE.has(a)) {
      // -y / -hide_banner / -loglevel x van ANTES de las entradas: no son parte del bloque de la siguiente entrada.
      out.push(a);
      if (a === '-loglevel' || a === '-v') { out.push(args[++i]); }
      blockStart = out.length;
      continue;
    }
    out.push(a);
    if (INPUT_OPTS_WITH_VALUE.has(a) && i + 1 < args.length) out.push(args[++i]);
  }
  return out;
}

// Errores típicos cuando NVDEC/CUDA no se puede usar → reintentar el MISMO comando sin -hwaccel.
const HW_FAIL = [
  /Failed setup for format cuda/i,
  /No device available for decoder/i,
  /Cannot load (nvcuda\.dll|libcuda\.so)/i,
  /CUDA_ERROR_[A-Z_]+/,
  /hwaccel initiali[sz]ation returned error/i,
  /Device creation failed/i,
  /Failed to (create|initiali[sz]e) (the )?(CUDA|hardware) (device|context|frames)/i,
  /cuvid|nvdec.*(error|fail)/i,
  /Hardware is lacking required capabilities/i,
  /Error while decoding.*(cuda|hwaccel)/i,
];
function isHwaccelFailure(stderr) { const s = String(stderr || ''); return HW_FAIL.some(r => r.test(s)); }

// ¿Sirve -hwaccel cuda en esta PC? Lista hwaccels + decodifica de verdad un video mínimo. Nunca lanza; se guarda en cache.
const cache = new Map();
function sh(bin, args, timeout = 20000) {
  return new Promise(resolve => {
    let err = '', out = '';
    let c; try { c = spawn(bin, args, { windowsHide: true }); } catch (e) { return resolve({ code: -1, out: '', err: String(e) }); }
    const t = setTimeout(() => { try { c.kill(); } catch {} }, timeout);
    c.stdout.on('data', b => { out += b; }); c.stderr.on('data', b => { err += b; });
    c.on('error', e => { clearTimeout(t); resolve({ code: -1, out, err: err + String(e) }); });
    c.on('close', code => { clearTimeout(t); resolve({ code, out, err }); });
  });
}
function probeCuda(ffmpegBin) {
  const key = String(ffmpegBin || 'ffmpeg');
  if (!cache.has(key)) cache.set(key, (async () => {
    try {
      const list = await sh(key, ['-hide_banner', '-hwaccels']);
      if (list.code !== 0 || !/^\s*cuda\s*$/m.test(list.out + list.err)) return false;
      const tmp = path.join(os.tmpdir(), `emm_hw_${process.pid}_${Date.now()}.mp4`);
      try {
        const mk = await sh(key, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=256x144:d=0.2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', tmp]);
        if (mk.code !== 0) return false;
        const dec = await sh(key, ['-hide_banner', '-loglevel', 'error', '-hwaccel', 'cuda', '-i', tmp, '-f', 'null', '-']);
        // Algunas compilaciones caen solas a CPU con solo un aviso: si hubo errores de CUDA, cuenta como NO.
        return dec.code === 0 && !isHwaccelFailure(dec.err);
      } finally { fs.unlink(tmp, () => {}); }
    } catch { return false; }
  })());
  return cache.get(key);
}
function _clearCache() { cache.clear(); }

// Corre `runFn(args)` con GPU si se pidió; si falla por NVDEC, reintenta igual pero sin -hwaccel.
// runFn debe rechazar con un Error cuyo message incluya el stderr (como hace `run` en server.js).
async function runWithHwFallback(runFn, args, { gpu = false, onFallback = () => {} } = {}) {
  if (!gpu) return runFn(args);
  try { return await runFn(withHwaccel(args, { gpu: true })); }
  catch (e) {
    if (!isHwaccelFailure(e && (e.stderr || e.message))) throw e;
    onFallback(e);
    return runFn(args);
  }
}

module.exports = { decodeArgs, withHwaccel, isHwaccelFailure, probeCuda, runWithHwFallback, _clearCache };
