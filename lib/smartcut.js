'use strict';
// CORTE INTELIGENTE (beta): en vez de recodificar TODO el video, los tramos que no se tocan se COPIAN del original
// (GOPs completos, de cuadro clave a cuadro clave: calidad idéntica, sin recodificar) y solo se recodifica lo que está
// alrededor de cada corte: el pedazo entre el corte y el siguiente cuadro clave, los fundidos de entrada/salida, las
// transiciones entre clips (crossfade) y los clips con zoom.
// Todo se cuenta en CUADROS del original (cuadro i en v0 + i/fps): cada pedazo sale con el número exacto de cuadros,
// así la imagen queda en su lugar y el audio (que se arma aparte con los mismos límites) va sincronizado.
// Medido con un directo real de Kick: 1443/1443 cuadros exactos, 0 errores de decodificación, 83 % copiado.

// Cuadros [fs, fe) que deja un corte [start, end) (los mismos que trim=start:end).
function frameRange(start, end, v0, fps) {
  return { fs: Math.ceil((start - v0) * fps - 1e-6), fe: Math.ceil((end - v0) * fps - 1e-6) };
}

// Plan: piezas en orden de salida.
//  { type: 'copy', a, b }                      → copiar cuadros [a,b) (a es cuadro clave; b es cuadro clave o el final)
//  { type: 'enc', ranges: [{a,b,seg}], xfades: [cuadros entre rango r y r+1], fadeIn, fadeOut }
// segs: [{start,end,zoom?,trans?,join?}] · keys: cuadros clave (índices, ordenados) · opts:
//   xfadeFrames(i) → cuadros de transición entre el clip i-1 y el i (0 = corte seco) · fadeInFrames/fadeOutFrames ·
//   minCore = mínimo de cuadros para que valga la pena copiar (por defecto 1 s) · noCore(seg) → true si el clip lleva
//   efecto en la imagen (zoom) y debe recodificarse completo.
function plan(segs, keys, v0, fps, opts = {}) {
  const xf = opts.xfadeFrames || (() => 0);
  const minCore = opts.minCore != null ? opts.minCore : Math.round(fps);
  const noCore = opts.noCore || (s => !!(s && s.zoom && Number(s.zoom) !== 0));
  const fin = Math.max(0, opts.fadeInFrames || 0), fout = Math.max(0, opts.fadeOutFrames || 0);
  const K = [...new Set(keys)].sort((x, y) => x - y);
  const firstKeyAtOrAfter = f => { let lo = 0, hi = K.length; while (lo < hi) { const m = (lo + hi) >> 1; if (K[m] < f) lo = m + 1; else hi = m; } return lo < K.length ? K[lo] : null; };
  const lastKeyAtOrBefore = f => { let lo = 0, hi = K.length; while (lo < hi) { const m = (lo + hi) >> 1; if (K[m] <= f) lo = m + 1; else hi = m; } return lo > 0 ? K[lo - 1] : null; };
  const n = segs.length, R = segs.map(s => frameRange(s.start, s.end, v0, fps));
  const pieces = []; let run = null, totalFrames = 0, copied = 0;
  const pushRange = (a, b, seg, xfBefore) => {
    if (b <= a) return;
    if (!run) run = { type: 'enc', ranges: [], xfades: [], fadeIn: false, fadeOut: false };
    if (run.ranges.length) run.xfades.push(xfBefore || 0);
    run.ranges.push({ a, b, seg });
  };
  const flush = () => { if (run && run.ranges.length) pieces.push(run); run = null; };
  for (let i = 0; i < n; i++) {
    const { fs, fe } = R[i];
    if (fe <= fs) continue;
    const xBefore = i > 0 ? Math.max(0, Math.round(xf(i))) : 0;
    const xAfter = i < n - 1 ? Math.max(0, Math.round(xf(i + 1))) : 0;
    const headNeed = (i === 0 ? fin : 0) + xBefore, tailNeed = (i === n - 1 ? fout : 0) + xAfter;
    let k1 = noCore(segs[i]) ? null : firstKeyAtOrAfter(fs + headNeed);
    let k2 = noCore(segs[i]) ? null : lastKeyAtOrBefore(fe - tailNeed);
    if (k1 == null || k2 == null || k2 - k1 < minCore) { pushRange(fs, fe, i, xBefore); continue; }
    // Una transición necesita cuadros recodificados de los DOS lados del corte (el núcleo no puede tocar el corte).
    if (xBefore > 0 && k1 === fs) k1 = firstKeyAtOrAfter(fs + 1);
    if (k1 == null || k2 - k1 < minCore) { pushRange(fs, fe, i, xBefore); continue; }
    pushRange(fs, k1, i, xBefore);
    if (run && i === 0 && fin) run.fadeIn = true;
    flush();
    pieces.push({ type: 'copy', a: k1, b: k2, seg: i }); copied += k2 - k1;
    pushRange(k2, fe, i, 0);
  }
  flush();
  // Fundidos: el de entrada va en la primera pieza recodificada si arranca el video; el de salida en la última.
  if (fin) { const p = pieces[0]; if (p && p.type === 'enc') p.fadeIn = true; }
  if (fout) { const p = pieces[pieces.length - 1]; if (p && p.type === 'enc') p.fadeOut = true; }
  for (const p of pieces) totalFrames += p.type === 'copy' ? p.b - p.a : p.ranges.reduce((s, r) => s + r.b - r.a, 0) - p.xfades.reduce((s, x) => s + x, 0);
  return { pieces, frames: R, totalFrames, copiedFrames: copied };
}

// Cuadros clave a partir de la lista de paquetes de ffprobe ("pts_time,flags" por línea). Revisa que el video sea de
// cuadros constantes (si no, el corte inteligente no se usa).
function parseKeyframes(csv, fps) {
  const pk = String(csv || '').split(/\r?\n/).filter(Boolean).map(l => { const [t, f] = l.split(','); return { t: Number(t), k: String(f || '').includes('K') }; }).filter(p => Number.isFinite(p.t));
  if (!pk.length) return { ok: false, reason: 'sin cuadros' };
  const v0 = Math.min(...pk.map(p => p.t));
  let worst = 0; for (const p of pk) { const x = (p.t - v0) * fps; worst = Math.max(worst, Math.abs(x - Math.round(x))); }
  const keys = pk.filter(p => p.k).map(p => Math.round((p.t - v0) * fps)).sort((a, b) => a - b);
  // GOP ABIERTO: después de un cuadro clave (en orden de decodificación) viene un cuadro que se MUESTRA antes que él →
  // ese cuadro depende del GOP anterior y no se puede copiar empezando en el cuadro clave. Entonces no se usa.
  let open = false, lastKey = -Infinity;
  for (const p of pk) { if (p.k) lastKey = p.t; else if (p.t < lastKey - 1e-6) { open = true; break; } }
  // Kick guarda los tiempos redondeados al milisegundo (cuadros de 16/17 ms): eso es normal (±0.03 cuadro). Solo un
  // desfase de un cuarto de cuadro o más indica video de cuadros variables de verdad.
  const reason = worst >= 0.25 ? 'cuadros irregulares (VFR)' : open ? 'GOP abierto' : '';
  return { ok: !reason && keys.length > 0, reason, v0, keys, frames: pk.length, worst, open };
}

module.exports = { frameRange, plan, parseKeyframes };
