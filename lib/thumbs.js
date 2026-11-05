// MINIATURAS: lógica pura (sin ffmpeg ni MediaPipe). La usan el servidor (Node) y el navegador (mismo archivo,
// servido en /lib/thumbs.js → window.EmmThumbs), así lo que se prueba es exactamente lo que corre.
// - sampleTimes: qué fotogramas mostrar en la galería (todo el video / alrededor del momento actual / mejores momentos).
// - expressionScore / faceScore / frameScore: qué tan expresiva es una cara según los "blendshapes" de MediaPipe
//   (boca abierta, sonrisa, cejas arriba, ojos muy abiertos), penalizando ojos cerrados, caras chiquitas y fotos movidas.
// - rankFrames: las mejores sugerencias sin repetir casi el mismo momento.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.EmmThumbs = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const r3 = x => Math.round(x * 1000) / 1000;
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

  // Tiempos (s) a mostrar. Nunca el primer/último 1 % (suelen ser pantallas de "empezando"/"terminando").
  function sampleTimes({ duration, count = 24, mode = 'all', around = 0, window = 6, bestof = [], perMoment = 4, fps = 60 } = {}) {
    const D = Number(duration);
    if (mode === 'bestof') mode = 'best'; // el select de miniaturas.js manda 'bestof'
    const wanted = mode;
    if (!Number.isFinite(D) || D <= 0) return { times: [], mode };
    const n = clamp(Math.round(count) || 24, 1, 120);
    const frame = 1 / (Number(fps) > 0 ? Number(fps) : 60);
    const lo = D > 30 ? D * 0.01 : 0, hi = Math.max(lo, D - (D > 30 ? D * 0.01 : frame));
    const snap = t => r3(clamp(t, lo, hi));
    const uniq = arr => [...new Set(arr.map(snap))].sort((a, b) => a - b);
    if (mode === 'around') {
      const c = clamp(Number(around) || 0, lo, hi), w = Math.max(frame * 2, Number(window) || 6);
      if (n === 1) return { times: [snap(c)], mode };
      const s = Math.max(lo, c - w), e = Math.min(hi, c + w), step = (e - s) / (n - 1);
      return { times: uniq(Array.from({ length: n }, (_, i) => s + i * step)), mode };
    }
    if (mode === 'best') {
      const moments = (Array.isArray(bestof) ? bestof : [])
        .map(m => ({ start: +m.start, end: +m.end, score: Number(m.score) || 0 }))
        .filter(m => Number.isFinite(m.start) && Number.isFinite(m.end) && m.end > m.start)
        .sort((a, b) => b.score - a.score);
      if (moments.length) {
        const k = clamp(Math.round(perMoment) || 4, 1, 12), out = [];
        for (const m of moments) {
          if (out.length >= n) break;
          for (let i = 0; i < k && out.length < n; i++) out.push(m.start + (i + 0.5) * (m.end - m.start) / k);
        }
        return { times: uniq(out), mode };
      }
      mode = 'all'; // sin "Resumen del directo": se reparte en todo el video
    }
    const step = (hi - lo) / n;
    return { times: uniq(Array.from({ length: n }, (_, i) => lo + (i + 0.5) * step)), mode: 'all', fallback: wanted !== 'all' };
  }

  // Un cuadro antes/después (para afinar la miniatura).
  function stepFrame(t, frames, fps = 60, duration = Infinity) { return r3(clamp(Number(t) + frames / (Number(fps) > 0 ? Number(fps) : 60), 0, Math.max(0, duration - 1 / (fps || 60)))); }

  // "1:02:03.25" para mostrar y "1h02m03s250" para nombres de archivo.
  function fmtTime(t) {
    t = Math.max(0, Number(t) || 0);
    const h = Math.floor(t / 3600), m = Math.floor(t % 3600 / 60), s = t % 60;
    const ss = s.toFixed(2).padStart(5, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
  }
  function fileStamp(t) {
    t = Math.max(0, Number(t) || 0);
    const ms = Math.round(t * 1000), h = Math.floor(ms / 3600000), m = Math.floor(ms % 3600000 / 60000), s = Math.floor(ms % 60000 / 1000), f = ms % 1000;
    return `${h}h${String(m).padStart(2, '0')}m${String(s).padStart(2, '0')}s${String(f).padStart(3, '0')}`;
  }

  // Blendshapes de MediaPipe (0..1). Acepta {jawOpen:0.4,...} o [{categoryName,score}].
  function blendMap(b) {
    if (Array.isArray(b)) { const o = {}; for (const c of b) if (c && c.categoryName) o[c.categoryName] = +c.score || 0; return o; }
    return b && typeof b === 'object' ? b : {};
  }
  const avg = (...xs) => xs.reduce((a, x) => a + (Number(x) || 0), 0) / xs.length;

  // Qué tan expresiva es la cara (0..~1.3). Pesos pensados para miniaturas de YouTube de directos IRL:
  // sorpresa (boca abierta + cejas + ojos abiertos) y risa pesan más; ojos cerrados (parpadeo) la arruinan.
  const W = { jawOpen: 1.0, smile: 0.8, browUp: 0.55, eyeWide: 0.6, funnel: 0.25 };
  function expressionScore(blend) {
    const b = blendMap(blend);
    const parts = {
      jawOpen: clamp(+b.jawOpen || 0, 0, 1),
      smile: clamp(avg(b.mouthSmileLeft, b.mouthSmileRight), 0, 1),
      browUp: clamp(Math.max(+b.browInnerUp || 0, avg(b.browOuterUpLeft, b.browOuterUpRight)), 0, 1),
      eyeWide: clamp(avg(b.eyeWideLeft, b.eyeWideRight), 0, 1),
      funnel: clamp(Math.max(+b.mouthFunnel || 0, +b.mouthPucker || 0), 0, 1),
    };
    const blink = clamp(avg(b.eyeBlinkLeft, b.eyeBlinkRight), 0, 1);
    let score = 0;
    for (const k in W) score += W[k] * parts[k];
    // Una expresión fuerte (lo que más llama en una miniatura) vale más que varias a medias.
    score = 0.6 * score / 1.6 + 0.6 * Math.max(parts.jawOpen, parts.smile, parts.browUp * 0.9, parts.eyeWide * 0.9);
    const eyesClosed = blink > 0.5 ? (blink - 0.5) * 2 : 0; // 0 con ojos normales, 1 con ojos cerrados
    score *= 1 - 0.75 * eyesClosed;
    return { score: r3(score), parts: Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, r3(v)])), blink: r3(blink) };
  }

  // face = {blend, w, h, cx, cy} (w/h = tamaño de la cara relativo al cuadro 0..1, cx/cy = centro 0..1).
  function faceScore(face) {
    const e = expressionScore(face && face.blend);
    const w = Number(face && face.w) || 0, h = Number(face && face.h) || w;
    const size = Math.sqrt(Math.max(0, w * h)); // ~0.1 cara lejana, ~0.3 cerca de la cámara
    const sizeF = clamp((size - 0.04) / 0.16, 0, 1); // ≤4 % no sirve; ≥20 % ya es buena
    // Cara muy pegada a la orilla = se corta en la miniatura.
    const cx = Number.isFinite(+face?.cx) ? +face.cx : 0.5, cy = Number.isFinite(+face?.cy) ? +face.cy : 0.5;
    const edge = Math.min(cx, 1 - cx, cy, 1 - cy);
    const edgeF = edge < 0.06 ? 0.6 : 1;
    return { score: r3(e.score * (0.35 + 0.65 * sizeF) * edgeF), expression: e.score, size: r3(size), parts: e.parts, blink: e.blink };
  }

  // Nitidez: varianza del laplaciano en escala de grises (foto movida/borrosa → número bajo).
  function laplacianVariance(gray, w, h) {
    if (!gray || w < 3 || h < 3) return 0;
    let n = 0, sum = 0, sum2 = 0;
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const v = 4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - w] - gray[i + w];
      sum += v; sum2 += v * v; n++;
    }
    const m = sum / n;
    return r3(sum2 / n - m * m);
  }
  // Gris (luma BT.709) desde RGBA de un canvas.
  function grayFromRGBA(rgba, w, h) {
    const g = new Float32Array(w * h);
    for (let i = 0, j = 0; i < g.length; i++, j += 4) g[i] = 0.2126 * rgba[j] + 0.7152 * rgba[j + 1] + 0.0722 * rgba[j + 2];
    return g;
  }
  // 0..1: por debajo de ~40 (en 320 px de ancho) ya se ve movida; arriba de ~250 está nítida.
  function sharpFactor(lapVar) { if (!Number.isFinite(+lapVar)) return 1; return r3(clamp((Math.log10(Math.max(1, +lapVar)) - Math.log10(40)) / (Math.log10(250) - Math.log10(40)), 0, 1)); }

  // frame = {t, faces:[face...], sharp:lapVar}. La mejor cara del cuadro manda; la nitidez la multiplica.
  function frameScore(frame) {
    const faces = (frame && frame.faces || []).map(faceScore).sort((a, b) => b.score - a.score);
    if (!faces.length) return { score: 0, faces: 0, best: null };
    const sf = sharpFactor(frame.sharp);
    return { score: r3(faces[0].score * (0.4 + 0.6 * sf)), faces: faces.length, best: faces[0], sharp: sf };
  }

  // Las `top` mejores con al menos `minGap` s entre ellas (si no, salen 5 cuadros casi iguales del mismo grito).
  function rankFrames(frames, { top = 6, minGap = 2, minScore = 0.08 } = {}) {
    const scored = (frames || []).map(f => ({ t: +f.t, ...frameScore(f) })).filter(f => Number.isFinite(f.t) && f.score >= minScore).sort((a, b) => b.score - a.score || a.t - b.t);
    const out = [];
    for (const f of scored) { if (out.length >= top) break; if (out.every(o => Math.abs(o.t - f.t) >= minGap)) out.push(f); }
    return out;
  }

  return { sampleTimes, stepFrame, fmtTime, fileStamp, blendMap, expressionScore, faceScore, laplacianVariance, grayFromRGBA, sharpFactor, frameScore, rankFrames };
});
