'use strict';
// RITMO Y MÁRGENES para "quitar silencios" (investigación §3.3).
// El audio se analiza UNA sola vez con el umbral más sensible (silencios ≥ 0.2 s) y se guardan TODOS los silencios.
// Este módulo, puro y sin dependencias, decide en el navegador (al instante, sin volver a analizar) qué se conserva:
// - ritmo   = pausa mínima que se quita (0.20–2.0 s); Infinity = "Dejar todas las pausas".
// - margen antes   = cuánto silencio se deja ANTES de que empiece a hablar (por defecto 80 ms).
// - margen después = cuánto silencio se deja DESPUÉS de que termina de hablar (por defecto 150 ms; las colas de las
//   palabras en español se cortan más fácil que los ataques).
// - Nunca deja pedazos de menos de minClip (≈0.15 s): si un pedazo de voz quedaría así de chico, ese corte no se hace.
// - Si hay tiempos por palabra confiables, el corte no se come ninguna palabra (se recorre el borde).
// Funciona en Node (require) y en el navegador (window.Pace).
(function (root) {
  const RHYTHM_STEPS = [0.2, 0.25, 0.3, 0.35, 0.4, 0.5, 0.6, 0.7, 0.8, 1.0, 1.2, 1.5, 2.0, Infinity];
  const DEFAULTS = { minPause: 0.6, padBefore: 0.08, padAfter: 0.15, minClip: 0.15, minCut: 0.12 };
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const r3 = x => +Number(x).toFixed(3);

  // Lee la salida de ffmpeg silencedetect → [{start,end}] ordenados, dentro de [0,duration].
  function parseSilenceLog(log, duration = Infinity) {
    const out = []; let start = null;
    for (const line of String(log || '').split(/\r?\n/)) {
      const a = line.match(/silence_start:\s*(-?[\d.]+)/), b = line.match(/silence_end:\s*(-?[\d.]+)/);
      if (a) start = Math.max(0, Number(a[1]));
      if (b && start !== null) { const end = Math.min(duration, Number(b[1])); if (end > start) out.push({ start: r3(start), end: r3(end) }); start = null; }
    }
    // Silencio que llega hasta el final del archivo (ffmpeg no imprime silence_end).
    if (start !== null && Number.isFinite(duration) && duration > start) out.push({ start: r3(start), end: r3(duration) });
    return out.sort((x, y) => x.start - y.start);
  }

  // Palabras confiables a partir de la transcripción: solo segmentos de UNA palabra (tiempos reales, no repartidos).
  function reliableWords(segments) {
    const w = [];
    for (const s of segments || []) {
      const a = Number(s && s.start), b = Number(s && s.end);
      if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a || b - a > 1.5) continue;
      if (String(s.text || '').trim().split(/\s+/).filter(Boolean).length !== 1) continue;
      w.push({ start: a, end: b });
    }
    return w.sort((x, y) => x.start - y.start);
  }

  // Encoge un corte para no comerse ninguna palabra (las palabras están ordenadas por inicio).
  function protectWords(cut, words) {
    if (!words || !words.length) return cut;
    let { start, end } = cut;
    let lo = 0, hi = words.length; // primera palabra que termina después del inicio del corte
    while (lo < hi) { const m = (lo + hi) >> 1; if (words[m].end <= start) lo = m + 1; else hi = m; }
    for (let i = Math.max(0, lo - 1); i < words.length && words[i].start < end; i++) {
      const w = words[i];
      if (w.end <= start || w.start >= end) continue;
      const mid = (start + end) / 2;
      if ((w.start + w.end) / 2 < mid) start = Math.max(start, w.end); else end = Math.min(end, w.start);
      if (end <= start) break;
    }
    return { start, end };
  }

  // Calcula los cortes y los pedazos a conservar.
  function plan({ silences = [], duration = 0, minPause = DEFAULTS.minPause, padBefore = DEFAULTS.padBefore, padAfter = DEFAULTS.padAfter, words = [], minClip = DEFAULTS.minClip, minCut = DEFAULTS.minCut } = {}) {
    duration = Math.max(0, Number(duration) || 0);
    const full = { keep: duration > 0 ? [{ start: 0, end: r3(duration) }] : [], cuts: [], total: r3(duration), kept: r3(duration), removed: 0 };
    if (!duration || !(minPause < Infinity)) return full;
    minPause = clamp(Number(minPause) || DEFAULTS.minPause, 0.05, 30);
    padBefore = clamp(Number(padBefore) || 0, 0, 0.5);
    padAfter = clamp(Number(padAfter) || 0, 0, 0.5);
    const cuts = [];
    for (const s of silences) {
      const a = Number(s.start), b = Math.min(duration, Number(s.end));
      if (!Number.isFinite(a) || !Number.isFinite(b) || b - a < minPause) continue;
      // Al inicio/final del video no hace falta dejar margen hacia "afuera".
      let c = { start: a <= 0.001 ? 0 : a + padAfter, end: b >= duration - 0.001 ? duration : b - padBefore };
      c = protectWords(c, words);
      if (c.end - c.start >= minCut) cuts.push(c);
    }
    cuts.sort((x, y) => x.start - y.start);
    const keep = [], done = [];
    let cur = 0;
    for (const c of cuts) {
      if (c.start < cur) continue; // traslape (no debería pasar)
      const piece = c.start - cur;
      if (piece > 0 && piece < minClip) {
        if (cur === 0) { cur = c.end; done.push(c); continue; } // pedacito al inicio del video: se va con el corte
        continue; // pedazo de voz demasiado chico: mejor no hacer este corte
      }
      if (piece > 0) keep.push({ start: r3(cur), end: r3(c.start) });
      done.push(c); cur = c.end;
    }
    if (duration - cur >= minClip || !keep.length) { if (duration > cur) keep.push({ start: r3(cur), end: r3(duration) }); }
    const kept = keep.reduce((a, k) => a + (k.end - k.start), 0);
    return { keep, cuts: done.map(c => ({ start: r3(c.start), end: r3(c.end) })), total: r3(duration), kept: r3(kept), removed: r3(duration - kept) };
  }

  // "4:12:00" o "12:05"
  function fmtDur(s) {
    s = Math.max(0, Math.round(Number(s) || 0));
    const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}` : `${m}:${String(x).padStart(2, '0')}`;
  }
  function summary(p) {
    if (!p || !p.total) return '';
    if (!p.cuts.length) return `No se quita ninguna pausa · el video queda de ${fmtDur(p.total)}`;
    return `El video pasa de ${fmtDur(p.total)} a ${fmtDur(p.kept)} · ${p.cuts.length} ${p.cuts.length === 1 ? 'corte' : 'cortes'} (−${fmtDur(p.removed)})`;
  }
  function rhythmLabel(v) { return v === Infinity ? 'Dejar todas las pausas' : `Quitar pausas de ${String(+Number(v).toFixed(2))} s o más`; }

  const api = { RHYTHM_STEPS, DEFAULTS, parseSilenceLog, reliableWords, protectWords, plan, fmtDur, summary, rhythmLabel };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Pace = api;
})(typeof window !== 'undefined' ? window : globalThis);
