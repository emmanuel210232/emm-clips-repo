'use strict';
const seek = require('./seek');
// "INTRO DE AVANCE": el video empieza con un avance de ~1 min hecho con ~6 fragmentos de ~10 s de los MEJORES momentos
// del directo, en blanco y negro, con fundidos cortos entre fragmentos, el audio original de cada fragmento (con
// micro-fundidos en las uniones y las groserías SILENCIADAS) y el letrero "PRÓXIMAMENTE..." abajo a la izquierda.
// Después sigue el video normal.
// Aquí va SOLO la lógica pura (elegir momentos, la ventana más fuerte, y armar el filtro de ffmpeg) → se prueba sin ffmpeg.

const DEFAULTS = { count: 6, fragLen: 10, xfade: 0.5, afade: 0.05, fadeIn: 0.3, fadeOut: 0.45, text: 'PRÓXIMAMENTE...', pad: 0.15, minGap: 30, avoidGap: 1.5 };

const overlap = (a, b) => Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const r3 = x => Number(x).toFixed(3);
const finiteRange = r => r && Number.isFinite(+r.start) && Number.isFinite(+r.end) && +r.end > +r.start;

// Palabras/expresiones que suelen marcar un momento fuerte en un directo IRL (risas, gritos, sorpresa).
const HYPE = /\b(ja(ja)+|js(js)+|xd+|no mames|wey|g[üu]ey|chingue|verga|madres|a[hy]+ cabr[oó]n|aguas|corre|mira|qu[eé] pedo|n[oó]mbre|no manches|alv|banda|chat)\b/gi;

// Lee la salida de ffmpeg `astats ... ametadata=print:key=lavfi.astats.Overall.RMS_level` → [{t, db}] (1 por segundo).
function parseEnergyLog(text) {
  const out = []; let t = null;
  for (const line of String(text || '').split(/\r?\n/)) {
    const mt = line.match(/pts_time:([\d.]+)/); if (mt) { t = Number(mt[1]); continue; }
    const mr = line.match(/RMS_level=(-?[\d.]+|-?inf|nan)/i);
    if (mr && t != null) { let db = Number(mr[1]); if (!Number.isFinite(db)) db = -120; out.push({ t, db }); t = null; }
  }
  return out;
}

// Rangos que NO están en el video final (huecos entre los pedazos que se conservan), solo los de al menos `minLen` s:
// un fragmento del avance no debe enseñar algo que luego no sale. Los huecos chicos (silencios o una grosería cortada)
// no se evitan: se SILENCIAN dentro del avance (ver removedRanges).
function removedRanges(keep, duration) {
  const ks = (keep || []).filter(finiteRange).map(k => ({ start: +k.start, end: +k.end })).sort((a, b) => a.start - b.start);
  const out = []; let t = 0;
  for (const k of ks) { if (k.start > t + 1e-3) out.push({ start: +t.toFixed(3), end: +k.start.toFixed(3) }); t = Math.max(t, k.end); }
  if (Number.isFinite(duration) && duration > t + 1e-3) out.push({ start: +t.toFixed(3), end: +(+duration).toFixed(3) });
  return out;
}
function avoidRanges(keep, duration, minLen = DEFAULTS.avoidGap) { return removedRanges(keep, duration).filter(r => r.end - r.start >= minLen); }

// Une rangos que se tocan o se enciman (para silenciar sin repetir filtros).
function mergeRanges(list) {
  const rs = (list || []).filter(finiteRange).map(r => ({ start: +r.start, end: +r.end })).sort((a, b) => a.start - b.start);
  const out = [];
  for (const r of rs) { const l = out[out.length - 1]; if (l && r.start <= l.end + 1e-3) l.end = Math.max(l.end, r.end); else out.push({ ...r }); }
  return out;
}

// Filtro de SILENCIO (sin bip) para un fragmento [s, e] del original: mismos rangos y el MISMO margen (0.15 s) que el
// export normal, en tiempos relativos al inicio del fragmento (asetpts lo reinicia a 0). Grupos de 20 por filtro para
// que ffmpeg no se quede sin memoria con muchas groserías. Devuelve '' si no hay nada que silenciar en el fragmento.
function muteFilter(ranges, s, e, pad = DEFAULTS.pad) {
  const hits = (ranges || []).filter(finiteRange).filter(r => +r.end + pad > s && +r.start - pad < e);
  if (!hits.length) return '';
  const terms = hits.map(r => `between(t,${r3(Math.max(0, +r.start - pad - s))},${r3(Math.min(e - s, +r.end + pad - s))})`);
  let out = ''; for (let i = 0; i < terms.length; i += 20) out += `,volume=enable='${terms.slice(i, i + 20).join('+')}':volume=0`;
  return out;
}

// Puntúa ventanas de la transcripción: densidad de habla + exclamaciones + risas (último recurso).
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

// Momentos por ENERGÍA del audio (cuando no hay "Resumen del directo"): ventanas de `win` s ordenadas por potencia
// media (lineal, no dB: gritos y risas pesan más que murmullo largo). energy = [{t, db}] por segundo.
function energyMoments(energy, duration, { win = 30, step = 5, avoid = [] } = {}) {
  const pts = (energy || []).filter(e => Number.isFinite(+e.t)).map(e => ({ t: +e.t, p: Math.pow(10, (Number.isFinite(+e.db) ? +e.db : -120) / 10) })).sort((a, b) => a.t - b.t);
  const total = duration || (pts.length ? pts[pts.length - 1].t + 1 : 0);
  if (pts.length < 5 || total < 15) return [];
  const w = Math.min(win, total);
  // Suma acumulada para que un directo de 6 h (21 600 puntos) no sea cuadrático.
  const acc = [0]; for (const q of pts) acc.push(acc[acc.length - 1] + q.p);
  const idx = t => { let lo = 0, hi = pts.length; while (lo < hi) { const m = (lo + hi) >> 1; if (pts[m].t < t) lo = m + 1; else hi = m; } return lo; };
  const all = [];
  for (let s = 0; s + w <= total + 0.001; s += step) {
    const a = idx(s), b = idx(s + w); const n = b - a; if (n < 1) continue;
    all.push({ start: +s.toFixed(2), end: +(s + w).toFixed(2), score: (acc[b] - acc[a]) / n });
  }
  if (!all.length) return [];
  const top = all.reduce((m, x) => Math.max(m, x.score), 0) || 1;
  const out = all.map(x => {
    const blocked = avoid.reduce((q, r) => q + overlap(x, r), 0) / w;
    return { start: x.start, end: x.end, score: +(10 * x.score / top - blocked * 10).toFixed(3), source: 'energy', label: '' };
  });
  out.sort((a, b) => b.score - a.score || a.start - b.start);
  return out;
}

// ===== Fragmento de avance propuesto por la IA (Resumen del directo) =====
// El modelo devuelve por momento `avance: {inicio, fin, por_que}`: 6–10 s, lo más fuerte SIN el remate.
// La IA a veces se equivoca: tiempos como texto ("1:02:03", "83.5 s"), relativos al momento en vez de absolutos,
// fuera del momento o demasiado largos. Este lector lo valida y, si no sirve, devuelve null (se usa la energía).
const AVANCE_MIN = 4, AVANCE_MAX = 12, AVANCE_TOL = 1.5;
function toSeconds(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
  const t = String(v == null ? '' : v).trim().replace(/\s*(s|seg|segundos)$/i, '').replace(',', '.');
  if (!t) return NaN;
  if (/^\d+(\.\d+)?$/.test(t)) return parseFloat(t);
  const m = t.match(/^(\d+):(\d{1,2})(?::(\d{1,2}(?:\.\d+)?))?$/);
  if (!m) return NaN;
  return m[3] != null ? (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) : (+m[1]) * 60 + (+m[2]);
}
function readAvance(raw, moment) {
  if (!raw || typeof raw !== 'object' || !moment) return null;
  const ms = Number(moment.start), me = Number(moment.end);
  if (!Number.isFinite(ms) || !Number.isFinite(me) || me - ms < AVANCE_MIN) return null;
  let a = toSeconds(raw.inicio ?? raw.ini ?? raw.start), b = toSeconds(raw.fin ?? raw.end);
  const dur = toSeconds(raw.dur ?? raw.duracion);
  if (!Number.isFinite(b) && Number.isFinite(a) && Number.isFinite(dur)) b = a + dur;
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return null;
  // ¿Vinieron relativos al inicio del momento? (p. ej. inicio 12 en un momento que empieza en 3600)
  // Solo si AMBOS quedan antes del inicio y, sumado el inicio, caen dentro del momento. Si no, son absolutos
  // (p. ej. momento 30–120 con avance 25–33: es absoluto y se recorta/rechaza, no se vuelve 55–63).
  if (b < ms - AVANCE_TOL && a + ms >= ms - AVANCE_TOL && b + ms <= me + AVANCE_TOL) { a += ms; b += ms; }
  if (a < ms - AVANCE_TOL || b > me + AVANCE_TOL) return null;
  a = Math.max(a, ms); b = Math.min(b, me);
  if (b - a < AVANCE_MIN || b - a > AVANCE_MAX) return null;
  const why = String(raw.por_que ?? raw.porque ?? raw.por ?? raw.why ?? '').replace(/\s+/g, ' ').trim().slice(0, 140);
  return { start: +a.toFixed(2), end: +b.toFixed(2), why };
}

// Afina el avance con la transcripción: el modelo solo ve bloques de 12–30 s, así que sus tiempos son aproximados.
// - `hasta` = últimas palabras EXACTAS antes del remate (las pide el prompt): el final se pone al terminar ese segmento.
// - El inicio se pega al inicio de una frase cercana. Duración final 4–12 s; si no se puede, regresa el avance original.
const normTxt = t => String(t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9ñ ]+/g, ' ').replace(/\s+/g, ' ').trim();
function refineAvance(av, transcript, moment, hasta = '') {
  if (!av) return null;
  const segs = (transcript || []).filter(g => Number.isFinite(+g.start) && Number.isFinite(+g.end) && +g.end > moment.start && +g.start < moment.end);
  if (!segs.length) return av;
  let end = av.end;
  const h = normTxt(hasta).split(' ').filter(Boolean);
  if (h.length) {
    const tries = [h.join(' '), h.slice(-3).join(' '), h.slice(-2).join(' ')].filter((x, i, a) => x && a.indexOf(x) === i);
    let best = null;
    for (const q of tries) {
      for (const g of segs) {
        if (+g.end < av.start - 6 || +g.start > av.end + 6) continue;
        if (!(' ' + normTxt(g.text) + ' ').includes(' ' + q + ' ')) continue;
        const d = Math.abs(+g.end - av.end);
        if (!best || d < best.d) best = { end: Math.min(+g.end, moment.end), d };
      }
      if (best) break;
    }
    if (best) end = best.end;
  }
  // Inicio: el de la frase más cercana al que propuso el modelo, dejando 4–12 s.
  let start = av.start;
  if (end - start > AVANCE_MAX) start = end - 10;
  if (end - start < AVANCE_MIN) start = end - 6;
  let bs = null;
  for (const g of segs) {
    const t = +g.start;
    if (t < moment.start || Math.abs(t - start) > 3) continue;
    if (end - t < AVANCE_MIN || end - t > AVANCE_MAX) continue;
    if (bs == null || Math.abs(t - start) < Math.abs(bs - start)) bs = t;
  }
  if (bs != null) start = bs;
  start = Math.max(start, moment.start);
  if (end - start < AVANCE_MIN || end - start > AVANCE_MAX) return av;
  return { start: +start.toFixed(2), end: +end.toFixed(2), why: av.why };
}

// Elige los momentos. Prioridad: candidatos del Resumen del directo (data/bestof.json) por score; si faltan, se completa
// con la ENERGÍA del audio y, si tampoco hay, con la transcripción. Los momentos quedan separados al menos `minGap` s.
function pickMoments({ candidates = [], energy = [], transcript = [], duration = 0, count = DEFAULTS.count, fragLen = DEFAULTS.fragLen, avoid = [], minGap = DEFAULTS.minGap } = {}) {
  const chosen = [];
  const free = m => chosen.every(c => m.start >= c.end + minGap || m.end <= c.start - minGap);
  const usable = m => m.end - m.start >= fragLen * 0.6 && overlap(m, { start: 0, end: duration || Infinity }) > 0
    && avoid.reduce((a, r) => a + overlap(m, r), 0) <= Math.max(0, (m.end - m.start) - fragLen); // queda al menos un fragmento libre
  const cands = (candidates || []).map(c => ({ start: +c.start, end: +c.end, score: Number(c.score) || 0, energia: Number(c.energia) || 0, label: String(c.gancho || c.label || ''), source: 'bestof', avance: readAvance(c.avance, { start: +c.start, end: +c.end }) }))
    .filter(finiteRange)
    .sort((a, b) => b.score - a.score || b.energia - a.energia);
  const take = list => { for (const m of list) { if (chosen.length >= count) break; if (usable(m) && free(m)) chosen.push(m); } };
  take(cands);
  if (chosen.length < count) take(energyMoments(energy, duration, { avoid }));
  if (chosen.length < count) take(transcriptMoments(transcript, duration, { avoid }));
  return chosen;
}

// Dentro de un momento [start,end], la ventana de `len` s con MÁS energía de audio (potencia lineal). Evita rangos
// `avoid` (lo que no sale en el video). Sin datos de energía: la ventana libre más cercana al centro del momento.
// Devuelve null si ninguna ventana del momento queda libre.
function strongestWindow(energy, start, end, len = DEFAULTS.fragLen, avoid = []) {
  const L = Math.min(len, end - start);
  if (L <= 0) return null;
  const pts = (energy || []).filter(e => Number.isFinite(+e.t) && e.t >= start - 1 && e.t < end + 1);
  const pw = e => Math.pow(10, (Number.isFinite(+e.db) ? +e.db : -120) / 10);
  const center = start + (end - start - L) / 2;
  const wins = [];
  const starts = []; for (let s = start; s + L <= end + 1e-6; s += 0.5) starts.push(s);
  if (!starts.some(s => Math.abs(s - center) < 1e-6)) starts.push(center);
  for (const s of starts) {
    const w = { start: s, end: s + L };
    if (avoid.some(r => overlap(w, r) > 0.25)) continue;
    let p = 0, n = 0, peak = null;
    for (const e of pts) if (e.t >= s - 0.001 && e.t < s + L - 0.001) { const q = pw(e); p += q; n++; if (!peak || q > peak.q) peak = { t: e.t + 0.5, q }; }
    wins.push({ start: s, score: n ? p / n : 0, peak });
  }
  if (!wins.length) return null;
  const fin = s => ({ start: +s.toFixed(2), end: +(s + L).toFixed(2) });
  if (!pts.length) { const w = wins.reduce((b, x) => Math.abs(x.start - center) < Math.abs(b.start - center) ? x : b); return { ...fin(w.start), energy: 0 }; }
  // Entre ventanas casi igual de fuertes, la que deja el pico más al CENTRO (el momento no empieza ni acaba de golpe).
  const top = wins.reduce((m, w) => Math.max(m, w.score), 0);
  let best = null;
  for (const w of wins) if (w.score >= top * 0.98) { const c = w.peak ? Math.abs(w.peak.t - (w.start + L / 2)) : 0; if (!best || c < best.c - 1e-9) best = { ...w, c }; }
  return { ...fin(best.start), energy: best.score };
}

// Ajusta el inicio para que el fragmento arranque al empezar una frase (si hay una a ≤ maxShift s), sin salirse del
// momento ni meterse en un rango a evitar.
function snapToSpeech(frag, transcript, moment, maxShift = 1.5, avoid = []) {
  const L = frag.end - frag.start; let best = null;
  for (const s of transcript || []) {
    const t = +s.start; if (!Number.isFinite(t)) continue;
    const d = t - frag.start; if (Math.abs(d) > maxShift) continue;
    if (t < moment.start || t + L > moment.end + 0.001) continue;
    if (avoid.some(r => overlap({ start: t, end: t + L }, r) > 0.25)) continue;
    if (best == null || Math.abs(d) < Math.abs(best - frag.start)) best = t;
  }
  return best == null ? frag : { ...frag, start: +best.toFixed(2), end: +(best + L).toFixed(2) };
}

// Plan completo: momentos → fragmento más fuerte de cada uno → orden cronológico (no revela el orden de importancia).
function planTeaser({ moments, energyOf = () => [], transcript = [], fragLen = DEFAULTS.fragLen, count = DEFAULTS.count, xfade = DEFAULTS.xfade, avoid = [], duration = Infinity } = {}) {
  const frags = [];
  for (const m of moments || []) {
    if (frags.length >= count) break;
    const mm = { start: Math.max(0, m.start), end: Math.min(duration, m.end) };
    if (mm.end - mm.start < 2) continue;
    // 1) Lo que propuso la IA (sin el remate), si es válido y no cae en algo que el video quitó.
    const ia = m.avance && readAvance(m.avance, mm);
    if (ia && !avoid.some(r => overlap(ia, r) > 0.25) && !frags.some(o => overlap(o, ia) > 0)) {
      frags.push({ start: ia.start, end: ia.end, label: m.label || '', score: m.score, source: 'ia', why: ia.why, moment: { start: m.start, end: m.end } });
      continue;
    }
    // 2) Si no: la ventana con más energía del audio, ajustada al inicio de una frase.
    let f = strongestWindow(energyOf(m), mm.start, mm.end, fragLen, avoid);
    if (!f) continue;
    f = snapToSpeech(f, transcript, mm, 1.5, avoid);
    if (frags.some(o => overlap(o, f) > 0)) continue;
    frags.push({ start: f.start, end: f.end, label: m.label || '', score: m.score, source: m.source, moment: { start: m.start, end: m.end } });
  }
  frags.sort((a, b) => a.start - b.start);
  frags.forEach((f, i) => { f.id = i; });
  return { fragments: frags, duration: teaserDuration(frags, xfade) };
}

// Atajo para el servidor: bestof + energía + transcripción + lo que se conserva del video → plan del avance.
function buildPlan({ candidates = [], energy = [], transcript = [], duration = 0, keep = null, count = DEFAULTS.count, fragLen = DEFAULTS.fragLen, xfade = DEFAULTS.xfade } = {}) {
  const avoid = keep ? avoidRanges(keep, duration) : [];
  const moments = pickMoments({ candidates, energy, transcript, duration, count: count + 4, fragLen, avoid }); // de sobra por si alguno no cabe
  const energyOf = m => (energy || []).filter(e => e.t >= m.start - 1 && e.t < m.end + 1);
  return planTeaser({ moments, energyOf, transcript, fragLen, count, xfade, avoid, duration });
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

// Arma el filtro del avance (en la MISMA pasada que el video principal = una sola codificación).
// - frags: [{start,end}] en tiempo del original. Cada fragmento es una ENTRADA propia de ffmpeg (inputs) abierta con
//   salto PRE s antes y cortada con trim/atrim sobre los tiempos (misma técnica de sincronía que el export normal:
//   en MPEG-TS el -ss puede caer hasta 1.3 s tarde; trim/atrim cuentan desde el punto PEDIDO).
// - Video: blanco y negro (hue=s=0), xfade de `xfade` s entre fragmentos, fundido desde/hacia negro, letrero.
// - Audio: cada fragmento con su audio original; como el xfade traslapa `xfade` s, al audio de cada fragmento (menos
//   el último) se le quitan esos s del FINAL y se unen con micro-fundidos de `afade` s → cada fragmento suena
//   exactamente cuando aparece.
// - muteOf(start,end) → filtros de volumen (groserías) relativos al fragmento ('' si no hay).
// - audioPost: cadena extra de audio (mejora de voz) para que suene igual que el video principal.
// - sampleRate/layout: frecuencia y canales de salida del audio (la del video principal, para poder unir sin sorpresas).
function buildTeaserGraph({ frags, firstInput, videoPath, fps, width, height, fontFile, text = DEFAULTS.text, xfade = DEFAULTS.xfade, afade = DEFAULTS.afade, fadeIn = DEFAULTS.fadeIn, fadeOut = DEFAULTS.fadeOut, pre = 15, fmtStart = 0, muteOf = () => '', audioPost = '', sampleRate = 48000, layout = 'stereo', inputPrefix = [], tag = 'tz' } = {}) {
  if (!frags || !frags.length) throw Error('El avance no tiene fragmentos.');
  const d = fragXfade(frags, xfade);
  const inputs = [], filters = [];
  const total = teaserDuration(frags, xfade);
  frags.forEach((f, i) => {
    // CORTE EXACTO (lib/seek.js): el comando debe llevar -copyts; trims sobre el tiempo absoluto del archivo.
    const len = f.end - f.start, idx = firstInput + i;
    const ex = seek.exactInput(videoPath, f.start, f.end, { pre, fmtStart });
    inputs.push(...inputPrefix, ...ex.input);
    filters.push(`[${idx}:v]${ex.vtrim},settb=AVTB,fps=${fps},scale=${width}:${height},format=yuv420p,hue=s=0,setsar=1[${tag}v${i}]`);
    const aLen = i < frags.length - 1 ? len - d : len;
    const fa = Math.min(afade, aLen / 4);
    filters.push(`[${idx}:a]${seek.absTrims(f.start, f.start + aLen, fmtStart).atrim}${muteOf(f.start, f.start + aLen) || ''},aresample=${sampleRate},aformat=sample_fmts=fltp:channel_layouts=${layout},afade=t=in:st=0:d=${r3(fa)},afade=t=out:st=${r3(aLen - fa)}:d=${r3(fa)}[${tag}a${i}]`);
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
  // apad+atrim: el audio del avance dura EXACTAMENTE lo mismo que su imagen (si quedara corto, lo que sigue se adelantaría).
  filters.push(`${frags.map((_, i) => `[${tag}a${i}]`).join('')}concat=n=${frags.length}:v=0:a=1,afade=t=out:st=${r3(total - fadeOut)}:d=${r3(fadeOut)}${audioPost ? ',' + audioPost : ''},aresample=${sampleRate},aformat=sample_fmts=fltp:channel_layouts=${layout},apad,atrim=end=${r3(total)}[${tag}a]`);
  return { inputs, filters, v: `[${tag}v]`, a: `[${tag}a]`, duration: total, nextInput: firstInput + frags.length, needsCopyts: true };
}

// Une el avance ANTES del video principal (mismo tamaño). mainV/mainA son las etiquetas del video ya armado.
// El video principal se normaliza igual que el avance (base de tiempo, fps, formato) para que concat no falle.
function prependFilter(teaser, mainV, mainA, { out = 'tzo', fps = null, sampleRate = 48000, layout = 'stereo' } = {}) {
  const norm = fps ? `settb=AVTB,fps=${fps},format=yuv420p,` : '';
  return [`${mainV}${norm}setsar=1[${out}mv]`, `${mainA}aresample=${sampleRate},aformat=sample_fmts=fltp:channel_layouts=${layout}[${out}ma]`,
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

module.exports = { DEFAULTS, readAvance, refineAvance, toSeconds, parseEnergyLog, removedRanges, avoidRanges, mergeRanges, muteFilter, transcriptMoments, energyMoments, pickMoments, strongestWindow, snapToSpeech, planTeaser, buildPlan, teaserDuration, buildTeaserGraph, prependFilter, sanitizeFragments, drawtextEscape, fontPathForFilter };
