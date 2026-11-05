'use strict';
// Lógica PURA de la línea de tiempo profesional (sin DOM): se usa en el navegador (timeline.js) y en las pruebas (node).
// Modelo: `clips` = pedazos de la FUENTE que forman el video final, EN ORDEN DE SALIDA ({start,end,zoom,trans,join}),
// el mismo arreglo que app.js manda a /api/export como `segments`. Lo que no cae en ningún clip = parte quitada.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TimelineCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const EPS = 1e-6;
  const MIN_CLIP = 0.1; // un clip nunca queda más corto que esto (evita pedazos fantasma)
  const r3 = x => Math.round(x * 1000) / 1000;

  function copyClip(c, extra) {
    const o = { start: +c.start, end: +c.end };
    if (c.zoom) o.zoom = true; if (c.trans) o.trans = true; if (c.join) o.join = true;
    return extra ? Object.assign(o, extra) : o;
  }
  function sanitizeClips(clips, dur) {
    const out = [];
    for (const c of clips || []) {
      if (!c) continue;
      let s = Number(c.start), e = Number(c.end);
      if (!Number.isFinite(s) || !Number.isFinite(e)) continue;
      s = Math.max(0, s); if (dur > 0) e = Math.min(dur, e);
      if (e - s < 0.04) continue;
      out.push(copyClip({ ...c, start: s, end: e }));
    }
    return out;
  }

  // ---------- Índice por tiempo de FUENTE (para dibujar/buscar solo lo visible con 1000+ clips) ----------
  function buildIndex(clips) {
    const n = (clips || []).length;
    const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => clips[a].start - clips[b].start || a - b);
    const starts = new Float64Array(n), maxEnd = new Float64Array(n);
    let m = -Infinity;
    order.forEach((ci, k) => { starts[k] = clips[ci].start; m = Math.max(m, clips[ci].end); maxEnd[k] = m; });
    return { order, starts, maxEnd, n };
  }
  // primer k con maxEnd[k] > t  (búsqueda binaria)
  function firstEndingAfter(ix, t) {
    let lo = 0, hi = ix.n;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (ix.maxEnd[mid] > t) hi = mid; else lo = mid + 1; }
    return lo;
  }
  // Índices (del arreglo clips) de los clips que se ven en [t0,t1].
  function visibleClips(ix, clips, t0, t1) {
    const out = [];
    for (let k = firstEndingAfter(ix, t0); k < ix.n && ix.starts[k] < t1; k++) {
      const ci = ix.order[k]; if (clips[ci].end > t0) out.push(ci);
    }
    return out;
  }
  function clipAt(ix, clips, t) {
    for (let k = firstEndingAfter(ix, t); k < ix.n && ix.starts[k] <= t + EPS; k++) {
      const ci = ix.order[k]; if (t >= clips[ci].start - EPS && t < clips[ci].end - EPS) return ci;
    }
    // justo en el final del último
    for (let k = Math.min(ix.n - 1, firstEndingAfter(ix, t - 1e-3)); k >= 0 && k < ix.n && ix.starts[k] <= t + EPS; k++) {
      const ci = ix.order[k]; if (Math.abs(t - clips[ci].end) < 1e-3) return ci;
    }
    return -1;
  }
  // Partes QUITADAS (en tiempo de fuente): huecos que ningún clip cubre.
  function removedRanges(clips, dur) {
    const sorted = [...(clips || [])].sort((a, b) => a.start - b.start);
    const rem = []; let cur = 0;
    for (const c of sorted) { if (c.start > cur + 0.02) rem.push({ start: r3(cur), end: r3(c.start) }); cur = Math.max(cur, c.end); }
    if (dur > cur + 0.02) rem.push({ start: r3(cur), end: r3(dur) });
    return rem;
  }
  function totalOut(clips) { let a = 0; for (const c of clips || []) a += c.end - c.start; return a; }
  function isSourceOrdered(clips) { for (let i = 1; i < (clips || []).length; i++) if (clips[i].start < clips[i - 1].start - EPS) return false; return true; }
  // Puntos de corte (bordes de clips) ordenados y sin repetidos → para el "imán" (snapping).
  function edgePoints(clips, exclude) {
    const pts = [];
    (clips || []).forEach((c, i) => { if (i === exclude) return; pts.push(c.start, c.end); });
    pts.sort((a, b) => a - b);
    const out = []; for (const p of pts) if (!out.length || Math.abs(out[out.length - 1] - p) > 1e-4) out.push(p);
    return out;
  }
  // Busca el punto más cercano dentro de la tolerancia (segundos). points ordenados.
  function snapTime(t, points, tol) {
    if (!points || !points.length || !(tol > 0)) return { t, snapped: false };
    let lo = 0, hi = points.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (points[mid] < t) lo = mid + 1; else hi = mid; }
    let best = null, bd = tol + EPS;
    for (const k of [lo - 1, lo]) { if (k >= 0 && k < points.length) { const d = Math.abs(points[k] - t); if (d <= bd) { bd = d; best = points[k]; } } }
    return best == null ? { t, snapped: false } : { t: best, snapped: true, point: best };
  }

  // ---------- Operaciones de edición (devuelven un arreglo NUEVO; no mutan) ----------
  function splitAt(clips, t, minLen) {
    minLen = minLen == null ? 0.12 : minLen;
    const out = []; let idx = -1;
    clips.forEach((c, i) => {
      if (idx < 0 && t > c.start + minLen && t < c.end - minLen) {
        const tt = r3(t);
        out.push(copyClip(c, { end: tt }));
        const b = { start: tt, end: c.end }; if (c.zoom) b.zoom = true; out.push(b);
        idx = i + 1;
      } else out.push(copyClip(c));
    });
    return idx < 0 ? null : { clips: out, idx };
  }
  function deleteClips(clips, idxs) {
    const del = new Set(idxs);
    const out = clips.filter((_, i) => !del.has(i)).map(c => copyClip(c));
    return out.length ? out : null;
  }
  // Límites para recortar el clip idx sin encimarse con su vecino (en tiempo de fuente).
  function trimLimits(clips, idx, dur) {
    const c = clips[idx]; let lo = 0, hi = dur > 0 ? dur : Infinity;
    clips.forEach((o, i) => {
      if (i === idx) return;
      if (o.end <= c.start + 1e-3) lo = Math.max(lo, o.end);
      else if (o.start >= c.end - 1e-3) hi = Math.min(hi, o.start);
    });
    return { lo, hi };
  }
  // Recorta un borde. side 'L' mueve el inicio, 'R' el final. Respeta vecinos, duración mínima y snapping.
  function trimClip(clips, idx, side, t, opts) {
    opts = opts || {};
    const c = clips[idx]; if (!c) return null;
    const minLen = opts.minLen == null ? MIN_CLIP : opts.minLen;
    const lim = opts.limits || trimLimits(clips, idx, opts.dur);
    let snapped = null;
    if (opts.snapPoints && opts.snapTol > 0) { const s = snapTime(t, opts.snapPoints, opts.snapTol); if (s.snapped) { t = s.t; snapped = s.t; } }
    let v;
    if (side === 'L') v = Math.max(lim.lo, Math.min(c.end - minLen, t));
    else v = Math.min(lim.hi, Math.max(c.start + minLen, t));
    if (snapped != null && Math.abs(v - snapped) > 1e-6) snapped = null;
    const out = clips.map(x => copyClip(x));
    if (side === 'L') out[idx].start = r3(v); else out[idx].end = r3(v);
    return { clips: out, value: r3(v), snapped };
  }
  // Quita el rango [a,b] de la fuente (lo que caiga dentro de cualquier clip).
  function cutRange(clips, a, b) {
    if (b < a) [a, b] = [b, a];
    const out = [];
    for (const c of clips) {
      if (c.end <= a + 0.02 || c.start >= b - 0.02) { out.push(copyClip(c)); continue; }
      if (c.start < a - 0.02) out.push(copyClip(c, { end: r3(a) }));
      if (c.end > b + 0.02) { const p = { start: r3(b), end: c.end }; if (c.zoom) p.zoom = true; out.push(p); }
    }
    const kept = out.filter(c => c.end - c.start > 0.05);
    return kept.length ? kept : null;
  }
  // Devuelve a la edición el rango [a,b] (solo las partes que estaban quitadas). Se inserta por orden de fuente.
  function restoreRange(clips, a, b, dur) {
    if (b < a) [a, b] = [b, a];
    a = Math.max(0, a); if (dur > 0) b = Math.min(dur, b);
    const holes = removedRanges(clips, dur > 0 ? dur : Math.max(b, ...clips.map(c => c.end)))
      .map(h => ({ start: Math.max(h.start, a), end: Math.min(h.end, b) })).filter(h => h.end - h.start > 0.05);
    if (!holes.length) return null;
    let out = clips.map(c => copyClip(c));
    for (const h of holes) {
      // se pega al clip vecino si toca (mismo orden en el arreglo) → no deja divisiones innecesarias
      const before = out.findIndex(c => Math.abs(c.end - h.start) < 0.03);
      const after = out.findIndex(c => Math.abs(c.start - h.end) < 0.03);
      if (before >= 0 && after === before + 1 && !out[after].trans && !out[after].join && !!out[after].zoom === !!out[before].zoom) {
        out[before].end = out[after].end; out.splice(after, 1);
      } else if (before >= 0) out[before].end = r3(h.end);
      else if (after >= 0) out[after].start = r3(h.start);
      else {
        let ins = out.findIndex(c => c.start > h.start); if (ins < 0) ins = out.length;
        out.splice(ins, 0, { start: r3(h.start), end: r3(h.end) });
      }
    }
    return out;
  }

  // ---------- Tiempo de SALIDA ⇄ fuente ----------
  function outMap(clips) { const acc = new Float64Array(clips.length + 1); clips.forEach((c, i) => { acc[i + 1] = acc[i] + (c.end - c.start); }); return acc; }
  function outToSource(clips, acc, o) {
    if (!clips.length) return 0;
    let lo = 0, hi = clips.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (acc[mid + 1] < o) lo = mid + 1; else hi = mid; }
    const c = clips[lo]; return c.start + Math.max(0, Math.min(c.end - c.start, o - acc[lo]));
  }

  // ---------- Vista de la edición (reproducir como quedará) ----------
  // Dado el clip actual y el tiempo de fuente del reproductor, decide si hay que saltar.
  // Devuelve {idx, seek?:t, end?:true}. lead = cuánto antes del final se salta (compensa la latencia del tick).
  function previewStep(clips, idx, t, lead) {
    lead = lead || 0;
    if (!clips.length) return { idx: -1, end: true };
    if (idx >= 0 && idx < clips.length) {
      const c = clips[idx];
      if (t >= c.start - 0.25 && t < c.end - lead) return { idx };
      if (t >= c.end - lead && t < c.end + 1.5) return idx + 1 < clips.length ? { idx: idx + 1, seek: clips[idx + 1].start } : { idx, end: true };
    }
    // sin clip actual (se movió el cursor): el clip que contiene t, o el siguiente en la fuente
    let best = -1;
    for (let i = 0; i < clips.length; i++) if (t >= clips[i].start - EPS && t < clips[i].end - lead) return { idx: i };
    for (let i = 0; i < clips.length; i++) if (clips[i].start >= t && (best < 0 || clips[i].start < clips[best].start)) best = i;
    return best >= 0 ? { idx: best, seek: clips[best].start } : { idx: -1, end: true };
  }
  // Une rangos (con margen) y los ordena → para silenciar groserías al vuelo.
  function mergeRanges(ranges, pad, dur) {
    pad = pad || 0;
    const v = (ranges || []).map(r => ({ start: Math.max(0, +r.start - pad), end: +r.end + pad }))
      .map(r => (dur > 0 ? { start: r.start, end: Math.min(dur, r.end) } : r))
      .filter(r => Number.isFinite(r.start) && Number.isFinite(r.end) && r.end > r.start).sort((a, b) => a.start - b.start);
    const out = [];
    for (const r of v) { if (out.length && r.start <= out[out.length - 1].end + 1e-3) out[out.length - 1].end = Math.max(out[out.length - 1].end, r.end); else out.push({ ...r }); }
    return out;
  }
  function inRanges(sorted, t) {
    let lo = 0, hi = sorted.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid].end <= t) lo = mid + 1; else hi = mid; }
    return lo < sorted.length && sorted[lo].start <= t;
  }

  // ---------- Historial (deshacer / rehacer) ----------
  function encodeClips(clips) { return (clips || []).map(c => [r3(c.start), r3(c.end), (c.zoom ? 1 : 0) | (c.trans ? 2 : 0) | (c.join ? 4 : 0)]); }
  function decodeClips(arr) { return (arr || []).map(a => { const c = { start: a[0], end: a[1] }; if (a[2] & 1) c.zoom = true; if (a[2] & 2) c.trans = true; if (a[2] & 4) c.join = true; return c; }); }
  function encodeSnapshot(s) { return { c: encodeClips(s.clips), s: [...(s.selectedIds || [])].sort(), p: [...(s.selectedPauseIds || [])].sort(), l: s.label || '' }; }
  function decodeSnapshot(e) { return { clips: decodeClips(e.c), selectedIds: e.s || [], selectedPauseIds: e.p || [], label: e.l || '' }; }
  function sameSnapshot(a, b) { return !!a && !!b && JSON.stringify([a.c, a.s, a.p]) === JSON.stringify([b.c, b.s, b.p]); }
  function createHistory(opts) {
    const limit = (opts && opts.limit) || 150;
    let past = [], future = [];
    return {
      // Guarda el estado ANTES de una edición. Ignora duplicados seguidos.
      record(snap) { const e = encodeSnapshot(snap); if (past.length && sameSnapshot(past[past.length - 1], e)) return false; past.push(e); if (past.length > limit) past.splice(0, past.length - limit); future = []; return true; },
      undo(current) { if (!past.length) return null; const prev = past.pop(); future.push(encodeSnapshot(current)); if (future.length > limit) future.shift(); return decodeSnapshot(prev); },
      redo(current) { if (!future.length) return null; const next = future.pop(); past.push(encodeSnapshot(current)); return decodeSnapshot(next); },
      canUndo() { return past.length > 0; }, canRedo() { return future.length > 0; },
      peekUndoLabel() { return past.length ? past[past.length - 1].l : ''; },
      peekRedoLabel() { return future.length ? future[future.length - 1].l : ''; },
      size() { return { undo: past.length, redo: future.length }; },
      clear() { past = []; future = []; },
      toJSON() { return { v: 1, past, future }; },
      load(data) { if (data && data.v === 1 && Array.isArray(data.past) && Array.isArray(data.future)) { past = data.past.slice(-limit); future = data.future.slice(-limit); return true; } return false; },
    };
  }

  // ---------- Vista (zoom / desplazamiento) ----------
  const MAX_PX_PER_SEC = 900; // ~15 px por frame a 60 fps
  function fitView(dur, width) { return { start: 0, pps: dur > 0 ? width / dur : 1 }; }
  function clampView(v, dur, width) {
    const minP = dur > 0 ? width / dur : 1e-6;
    const pps = Math.max(minP, Math.min(MAX_PX_PER_SEC, v.pps));
    const visible = width / pps;
    const start = Math.max(0, Math.min(Math.max(0, dur - visible), v.start));
    return { start, pps };
  }
  // Zoom con ancla: el tiempo bajo el cursor (anchorPx) se queda en su lugar.
  function zoomAt(v, factor, anchorPx, dur, width) {
    const tAnchor = v.start + anchorPx / v.pps;
    const pps = v.pps * factor;
    return clampView({ pps, start: tAnchor - anchorPx / pps }, dur, width);
  }
  const TICK_STEPS = [1 / 60, 1 / 30, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200];
  function tickStep(pps, minPx) { minPx = minPx || 90; for (const s of TICK_STEPS) if (s * pps >= minPx) return s; return 7200; }
  function fmtTC(t, withFrac) {
    t = Math.max(0, t || 0);
    const h = Math.floor(t / 3600), m = Math.floor(t % 3600 / 60), s = Math.floor(t % 60);
    const base = (h ? h + ':' + String(m).padStart(2, '0') : String(m)) + ':' + String(s).padStart(2, '0');
    if (!withFrac) return base;
    return base + '.' + String(Math.floor((t % 1) * 100)).padStart(2, '0');
  }

  // ---------- Onda de audio ----------
  // PCM s16 mono → picos 0..255 (uno por bucket).
  function peaksFromPcm(samples, perBucket) {
    const n = Math.ceil(samples.length / perBucket), out = new Uint8Array(n);
    for (let b = 0; b < n; b++) {
      let m = 0; const end = Math.min(samples.length, (b + 1) * perBucket);
      for (let i = b * perBucket; i < end; i++) { const v = samples[i] < 0 ? -samples[i] : samples[i]; if (v > m) m = v; }
      out[b] = Math.min(255, Math.round(Math.sqrt(m / 32768) * 255)); // raíz → se ven también las partes bajas (voz)
    }
    return out;
  }
  // Niveles reducidos (máximo de cada par) para dibujar rápido cualquier zoom.
  function peakLevels(peaks) {
    const levels = [peaks];
    while (levels[levels.length - 1].length > 2048) {
      const p = levels[levels.length - 1], q = new Uint8Array(Math.ceil(p.length / 2));
      for (let i = 0; i < q.length; i++) q[i] = Math.max(p[2 * i], p[2 * i + 1] || 0);
      levels.push(q);
    }
    return levels;
  }

  // ---------- Atajos de teclado ----------
  function keyAction(e) {
    const k = e.key, ctrl = !!(e.ctrlKey || e.metaKey), shift = !!e.shiftKey, low = (k || '').toLowerCase();
    if (ctrl && low === 'z') return shift ? 'redo' : 'undo';
    if (ctrl && low === 'y') return 'redo';
    if (ctrl) return null;
    if (k === ' ' || e.code === 'Space') return 'playPause';
    if (low === 'j') return 'shuttleBack';
    if (low === 'k') return 'shuttleStop';
    if (low === 'l') return 'shuttleFwd';
    if (k === 'ArrowLeft') return shift ? 'back1s' : 'backFrame';
    if (k === 'ArrowRight') return shift ? 'fwd1s' : 'fwdFrame';
    if (low === 'i') return 'markIn';
    if (low === 'o') return 'markOut';
    if (low === 's') return 'split';
    if (k === 'Delete' || k === 'Backspace') return 'delete';
    if (k === '+' || k === '=' || e.code === 'NumpadAdd') return 'zoomIn';
    if (k === '-' || k === '_' || e.code === 'NumpadSubtract') return 'zoomOut';
    if (low === 'f' && shift) return 'zoomFit';
    if (k === '?' || (shift && e.code === 'Slash')) return 'help';
    if (k === 'Escape') return 'escape';
    if (k === 'Home') return 'home';
    if (k === 'End') return 'end';
    return null;
  }
  // J/K/L: cada toque acelera en esa dirección (1×, 2×, 4×, 8×); K detiene.
  function shuttle(rate, action) {
    if (action === 'shuttleStop') return 0;
    if (action === 'shuttleFwd') return rate > 0 ? Math.min(8, rate * 2) : 1;
    if (action === 'shuttleBack') return rate < 0 ? Math.max(-8, rate * 2) : -1;
    return rate;
  }

  return { EPS, MIN_CLIP, sanitizeClips, buildIndex, visibleClips, clipAt, removedRanges, totalOut, isSourceOrdered, edgePoints, snapTime,
    splitAt, deleteClips, trimLimits, trimClip, cutRange, restoreRange, outMap, outToSource, previewStep, mergeRanges, inRanges,
    encodeClips, decodeClips, createHistory, MAX_PX_PER_SEC, fitView, clampView, zoomAt, tickStep, fmtTC, peaksFromPcm, peakLevels, keyAction, shuttle };
});
