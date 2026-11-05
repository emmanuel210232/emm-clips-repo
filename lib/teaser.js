'use strict';
// "INTRO DE AVANCE": el video empieza con un avance de ~1 min hecho con ~6 fragmentos de ~10 s de los MEJORES momentos
// del directo, en blanco y negro, con fundidos cortos entre fragmentos, el audio original de cada fragmento (con
// micro-fundidos en las uniones) y el letrero "PRÓXIMAMENTE..." abajo a la izquierda. Después sigue el video normal.
// Aquí va SOLO la lógica pura (elegir momentos, la ventana más fuerte, y armar el filtro de ffmpeg) → se prueba sin ffmpeg.

const DEFAULTS = { count: 6, fragLen: 10, xfade: 0.5, afade: 0.05, fadeIn: 0.3, fadeOut: 0.45, text: 'PRÓXIMAMENTE...' };

const overlap = (a, b) => Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const r3 = x => Number(x).toFixed(3);

// Palabras/expresiones que suelen marcar un momento fuerte en un directo IRL (risas, gritos, sorpresa).
const HYPE = /\b(ja(ja)+|js(js)+|xd+|no mames|wey|g[üu]ey|chingue|verga|madres|a[hy]+ cabr[oó]n|aguas|corre|mira|qu[eé] pedo|n[oó]mbre|no manches|alv|banda|chat)\b/gi;

// Puntúa ventanas de la transcripción (cuando no hay "Resumen del directo"): densidad de habla + exclamaciones + risas.
function transcriptMoments(transcript, duration, { win = 60, step = 20, avoid = [] } = {}) {
  const segs = (transcript || []).filter(s => Number.isFinite(+s.start) && Number.isFinite(+s.end) && String(s.text || '').trim());
  const total = duration || (segs.length ? +segs[segs.length - 1].end : 0);
  if (!segs.length || total < 20) return [];
  const w = Math.min(win, total);
  const out = [];
  for (let s = 0; s + w <= total + 0.001; s += step) {
    const e = s + w; let words = 0, excl = 0, hype = 0;
    for (const g of segs) {
      if (+g.end <= s || +g.start >= e) continue;
      const t = String(g.text);
      words += t.split(/\s+/).filter(Boolean).length;
      excl += (t.match(/[!¡?¿]/g) || []).length;
      hype += (t.match(HYPE) || []).length;
    }
    if (!words) continue;
    const blocked = avoid.reduce((a, r) => a + overlap({ start: s, end: e }, r), 0) / w;
    const score = (words / w) * 2 + excl * 0.6 + hype * 1.2 - blocked * 10;
    out.push({ start: +s.toFixed(2), end: +e.toFixed(2), score: +score.toFixed(3), source: 'transcript', label: '' });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

// Elige los momentos (más que `count` no hace falta). Prioridad: candidatos del Resumen del directo por score; si faltan,
// se completa con ventanas de la transcripción. Los momentos quedan repartidos (separados al menos `minGap` s).
function pickMoments({ candidates = [], transcript = [], duration = 0, count = DEFAULTS.count, fragLen = DEFAULTS.fragLen, avoid = [], minGap = 30 } = {}) {
  const chosen = [];
  const free = m => chosen.every(c => m.start >= c.end + minGap || m.end <= c.start - minGap);
  const usable = m => m.end - m.start >= fragLen * 0.6 && overlap(m, { start: 0, end: duration || Infinity }) > 0
    && avoid.reduce((a, r) => a + overlap(m, r), 0) < (m.end - m.start) - fragLen; // queda al menos un fragmento libre
  const cands = (candidates || []).map(c => ({ start: +c.start, end: +c.end, score: Number(c.score) || 0, energia: Number(c.energia) || 0, label: String(c.gancho || c.label || ''), source: 'bestof' }))
    .filter(c => Number.isFinite(c.start) && Number.isFinite(c.end) && c.end > c.start)
    .sort((a, b) => b.score - a.score || b.energia - a.energia);
  for (const c of cands) { if (chosen.length >= count) break; if (usable(c) && free(c)) chosen.push(c); }
  if (chosen.length < count) {
    for (const m of transcriptMoments(transcript, duration, { avoid })) { if (chosen.length >= count) break; if (usable(m) && free(m)) chosen.push(m); }
  }
  return chosen;
}

// Dentro de un momento [start,end], la ventana de `len` s con MÁS energía de audio (potencia lineal sumada, no dB:
// un grito/risa pesa más que muchos segundos de murmullo). energy = [{t, db}] por segundo. Evita rangos `avoid`.
function strongestWindow(energy, start, end, len = DEFAULTS.fragLen, avoid = []) {
  const L = Math.min(len, end - start);
  if (L <= 0) return { start, end: start };
  const pts = (energy || []).filter(e => Number.isFinite(+e.t) && e.t >= start - 1 && e.t < end + 1);
  const pw = e => Math.pow(10, (Number.isFinite(+e.db) ? +e.db : -120) / 10);
  const wins = [];
  for (let s = start; pts.length && s + L <= end + 1e-6; s += 0.5) {
    const w = { start: s, end: s + L };
    if (avoid.some(r => overlap(w, r) > 0.25)) continue;
    let p = 0, n = 0, peak = null;
    for (const e of pts) if (e.t >= s - 0.001 && e.t < s + L - 0.001) { const q = pw(e); p += q; n++; if (!peak || q > peak.q) peak = { t: e.t + 0.5, q }; }
    wins.push({ start: s, score: n ? p / n : 0, peak });
  }
  // Entre ventanas casi igual de fuertes, la que deja el pico más al CENTRO (el momento no empieza ni acaba de golpe).
  const top = wins.reduce((m, w) => Math.max(m, w.score), 0);
  let best = null;
  for (const w of wins) if (w.score >= top * 0.98) { const c = w.peak ? Math.abs(w.peak.t - (w.start + L / 2)) : 0; if (!best || c < best.c - 1e-9) best = { ...w, c }; }
  if (!best) { const c = start + (end - start - L) / 2; return { start: +c.toFixed(2), end: +(c + L).toFixed(2), energy: 0 }; }
  return { start: +best.start.toFixed(2), end: +(best.start + L).toFixed(2), energy: best.score };
}

// Ajusta el inicio para que el fragmento arranque al empezar una frase (si hay una a ≤ maxShift s), sin salirse del momento.
function snapToSpeech(frag, transcript, moment, maxShift = 1.5) {
  const L = frag.end - frag.start; let best = null;
  for (const s of transcript || []) {
    const t = +s.start; if (!Number.isFinite(t)) continue;
    const d = t - frag.start; if (Math.abs(d) > maxShift) continue;
    if (t < moment.start || t + L > moment.end + 0.001) continue;
    if (best == null || Math.abs(d) < Math.abs(best - frag.start)) best = t;
  }
  return best == null ? frag : { ...frag, start: +best.toFixed(2), end: +(best + L).toFixed(2) };
}

// Plan completo: momentos → fragmento más fuerte de cada uno → orden cronológico (no revela el orden de importancia).
function planTeaser({ moments, energyOf = () => [], transcript = [], fragLen = DEFAULTS.fragLen, count = DEFAULTS.count, xfade = DEFAULTS.xfade, avoid = [], duration = Infinity } = {}) {
  const frags = [];
  for (const m of (moments || []).slice(0, count)) {
    const mm = { start: Math.max(0, m.start), end: Math.min(duration, m.end) };
    if (mm.end - mm.start < 2) continue;
    let f = strongestWindow(energyOf(m), mm.start, mm.end, fragLen, avoid);
    f = snapToSpeech(f, transcript, mm);
    frags.push({ start: f.start, end: f.end, label: m.label || '', score: m.score, source: m.source, moment: { start: m.start, end: m.end } });
  }
  frags.sort((a, b) => a.start - b.start);
  frags.forEach((f, i) => { f.id = i; });
  return { fragments: frags, duration: teaserDuration(frags, xfade) };
}

function fragXfade(frags, xfade) { // el fundido no puede pasar de 1/3 del fragmento más corto
  const shortest = Math.min(...frags.map(f => f.end - f.start));
  return frags.length > 1 ? Math.max(0, Math.min(xfade, shortest / 3)) : 0;
}
function teaserDuration(frags, xfade = DEFAULTS.xfade) {
  if (!frags || !frags.length) return 0;
  const d = fragXfade(frags, xfade);
  return +(frags.reduce((a, f) => a + (f.end - f.start), 0) - d * (frags.length - 1)).toFixed(3);
}

// Escape para texto dentro de drawtext (comillas simples en el script de filtros).
function drawtextEscape(s) { return String(s).replace(/\\/g, '\\\\').replace(/'/g, '’').replace(/:/g, '\\:').replace(/%/g, '\\%'); }
function fontPathForFilter(p) { return String(p).replace(/\\/g, '/').replace(/:/g, '\\:'); }

// Arma el filtro del avance (TODO en la misma pasada que el video principal = una sola codificación).
// - frags: [{start,end}] en tiempo del original. Cada fragmento es una ENTRADA propia de ffmpeg (inputArgs) abierta con
//   salto PRE s antes y cortada con trim/atrim sobre los tiempos (misma técnica de sincronía que el export normal).
// - Video: blanco y negro (hue=s=0), xfade de `xfade` s entre fragmentos, fundido desde/hacia negro, letrero.
// - Audio: cada fragmento con su audio original; para que la imagen y el audio sigan alineados con el xfade (que
//   traslapa `xfade` s), al audio de cada fragmento (menos el último) se le quitan esos `xfade` s del FINAL y se
//   unen con micro-fundidos de `afade` s → cada fragmento suena exactamente cuando aparece.
// - muteOf(start,end) → texto de filtros de volumen (groserías) relativos al fragmento ('' si no hay).
// - audioPost: cadena extra de audio (mejora de voz) para que suene igual que el video principal.
function buildTeaserGraph({ frags, firstInput, videoPath, fps, width, height, fontFile, text = DEFAULTS.text, xfade = DEFAULTS.xfade, afade = DEFAULTS.afade, fadeIn = DEFAULTS.fadeIn, fadeOut = DEFAULTS.fadeOut, pre = 15, muteOf = () => '', audioPost = '', inputPrefix = [], tag = 'tz' } = {}) {
  if (!frags || !frags.length) throw Error('El avance no tiene fragmentos.');
  const d = fragXfade(frags, xfade);
  const inputs = [], filters = [];
  const total = teaserDuration(frags, xfade);
  frags.forEach((f, i) => {
    const len = f.end - f.start, p = Math.min(pre, f.start), idx = firstInput + i;
    inputs.push(...inputPrefix, '-ss', r3(f.start - p), '-t', r3(len + p), '-i', videoPath);
    filters.push(`[${idx}:v]trim=start=${r3(p)}:end=${r3(p + len)},setpts=PTS-STARTPTS,settb=AVTB,fps=${fps},scale=${width}:${height},format=yuv420p,hue=s=0,setsar=1[${tag}v${i}]`);
    const aLen = i < frags.length - 1 ? len - d : len;
    const fa = Math.min(afade, aLen / 4);
    filters.push(`[${idx}:a]atrim=start=${r3(p)}:end=${r3(p + aLen)},asetpts=PTS-STARTPTS${muteOf(f.start, f.start + aLen) || ''},aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,afade=t=in:st=0:d=${r3(fa)},afade=t=out:st=${r3(aLen - fa)}:d=${r3(fa)}[${tag}a${i}]`);
  });
  let vp = `[${tag}v0]`, L = frags[0].end - frags[0].start;
  for (let i = 1; i < frags.length; i++) {
    filters.push(`${vp}[${tag}v${i}]xfade=transition=fade:duration=${r3(d)}:offset=${r3(L - d)}[${tag}x${i}]`);
    vp = `[${tag}x${i}]`; L += (frags[i].end - frags[i].start) - d;
  }
  const fs = Math.max(24, Math.round(height * 0.068));
  const mx = Math.round(width * 0.045), my = Math.round(height * 0.075), sh = Math.max(2, Math.round(height / 360));
  const font = fontFile ? `fontfile='${fontPathForFilter(fontFile)}':` : '';
  const dt = `drawtext=${font}text='${drawtextEscape(text)}':fontcolor=white:fontsize=${fs}:x=${mx}:y=h-text_h-${my}:shadowcolor=black@0.75:shadowx=${sh}:shadowy=${sh}:borderw=${Math.max(1, Math.round(sh / 2))}:bordercolor=black@0.55:alpha='min(1,t/0.6)'`;
  filters.push(`${vp}${dt},fade=t=in:st=0:d=${r3(fadeIn)},fade=t=out:st=${r3(total - fadeOut)}:d=${r3(fadeOut)}[${tag}v]`);
  filters.push(`${frags.map((_, i) => `[${tag}a${i}]`).join('')}concat=n=${frags.length}:v=0:a=1,afade=t=out:st=${r3(total - fadeOut)}:d=${r3(fadeOut)}${audioPost ? ',' + audioPost : ''}[${tag}a]`);
  return { inputs, filters, v: `[${tag}v]`, a: `[${tag}a]`, duration: total, nextInput: firstInput + frags.length };
}

// Une el avance ANTES del video principal (mismo tamaño). mainV/mainA son las etiquetas del video ya armado.
function prependFilter(teaser, mainV, mainA, out = 'tzo') {
  return [`${mainV}setsar=1[${out}mv]`, `${mainA}aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[${out}ma]`,
    `${teaser.v}${teaser.a}[${out}mv][${out}ma]concat=n=2:v=1:a=1[${out}v][${out}a]`];
}

// Valida/normaliza fragmentos que manda la interfaz (el usuario puede cambiar uno): dentro del video, sin traslapes.
function sanitizeFragments(list, duration, fragLen = DEFAULTS.fragLen) {
  const out = [];
  for (const f of Array.isArray(list) ? list : []) {
    let s = Number(f && f.start), e = Number(f && f.end);
    if (!Number.isFinite(s)) continue;
    s = clamp(s, 0, Math.max(0, duration - 1));
    if (!Number.isFinite(e) || e <= s) e = s + fragLen;
    e = clamp(Math.min(e, s + 20), s + 1, duration);
    if (e - s < 1.5) continue;
    if (out.some(o => overlap(o, { start: s, end: e }) > 0)) continue;
    out.push({ start: +s.toFixed(2), end: +e.toFixed(2), label: String(f.label || '').slice(0, 70) });
    if (out.length >= 10) break;
  }
  return out.sort((a, b) => a.start - b.start);
}

module.exports = { DEFAULTS, transcriptMoments, pickMoments, strongestWindow, snapToSpeech, planTeaser, teaserDuration, buildTeaserGraph, prependFilter, sanitizeFragments, drawtextEscape, fontPathForFilter };
