'use strict';
// CORTE EXACTO en MPEG-TS (y cualquier contenedor).
// Problema medido (tools-dev/check_cut.js, docs/REPORTE_corte-exacto.md): con `-ss <s> -i` + `trim=start=<pre>` RELATIVO,
// ffmpeg pone el tiempo 0 donde realmente cayó el salto, que en MPEG-TS varía → el pedazo empezaba hasta ~1.4 s antes.
// Solución: `-copyts` (cada stream conserva su marca de tiempo REAL) y trim/atrim sobre el tiempo ABSOLUTO
// (start_time del formato + tiempo del pedazo). Así el corte cae en el cuadro exacto sin importar dónde quedó el salto,
// y audio y video se cortan en el mismo instante real.
//
// Reglas para usarlo en un comando de ffmpeg:
// - Poner COPYTS (['-copyts']) UNA vez, antes de las entradas, SOLO en comandos donde TODAS las entradas de video se
//   cortan con trim/atrim de este módulo (o son lavfi/imágenes, que empiezan en 0 de todos modos).
// - Cada cadena ya termina en setpts/asetpts=PTS-STARTPTS, así la salida empieza en 0.
// - NO usar en comandos que copian streams sin filtros (-c:v copy): conservarían las marcas absolutas.
// - fmtStart = start_time del FORMATO (ffprobe format=start_time); es el mismo origen que usa el reproductor de la app.
const { spawnSync } = require('node:child_process');

const PRE = 15;      // segundos que se abre antes (el salto puede caer tarde)
const TAIL = 0.5;    // margen al final de -t para que trim tenga el último cuadro
const COPYTS = ['-copyts'];
const f3 = x => Number(x).toFixed(3), f4 = x => Number(x).toFixed(4);

const cache = new Map();
// start_time del formato (puede ser negativo); 0 si no se puede leer (mp4 normal casi siempre es 0).
function startTimeOf(ffprobeBin, file) {
  const key = String(file);
  if (cache.has(key)) return cache.get(key);
  let st = 0;
  try {
    const r = spawnSync(ffprobeBin, ['-v', 'error', '-show_entries', 'format=start_time', '-of', 'default=nw=1:nk=1', file], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
    const v = parseFloat(String(r.stdout).trim());
    if (r.status === 0 && Number.isFinite(v)) st = v; // puede ser NEGATIVO (MPEG-TS cerca de la vuelta de 33 bits, mp4 con priming): usar 0 ahí deja el corte vacío
  } catch {}
  cache.set(key, st);
  return st;
}

// Plan de una entrada exacta para el pedazo [start, end) del video (tiempos de la app, desde el inicio del archivo).
// Regresa los args de entrada (sin -copyts) y los filtros de trim de video y audio.
function exactInput(file, start, end, { pre = PRE, fmtStart = 0, tail = TAIL } = {}) {
  start = Math.max(0, Number(start)); end = Number(end);
  if (!(end > start)) throw Error('Pedazo inválido: ' + start + '–' + end);
  const p = Math.min(pre, start), ss = start - p;
  const a = fmtStart + start, b = fmtStart + end;
  const input = ss > 0 ? ['-ss', f3(ss), '-t', f3(p + (end - start) + tail), '-i', file] : ['-t', f3(end + tail), '-i', file];
  return {
    input,
    vtrim: `trim=start=${f4(a)}:end=${f4(b)},setpts=PTS-STARTPTS`,
    atrim: `atrim=start=${f4(a)}:end=${f4(b)},asetpts=PTS-STARTPTS`,
    absStart: a, absEnd: b,
  };
}

// Para un comando con UNA sola entrada del video completo (sin -ss) y -copyts: trims absolutos de varios pedazos.
function absTrims(start, end, fmtStart = 0) {
  const a = fmtStart + Number(start), b = fmtStart + Number(end);
  return { vtrim: `trim=start=${f4(a)}:end=${f4(b)},setpts=PTS-STARTPTS`, atrim: `atrim=start=${f4(a)}:end=${f4(b)},asetpts=PTS-STARTPTS` };
}

module.exports = { PRE, TAIL, COPYTS, startTimeOf, exactInput, absTrims };
