'use strict';
// ZOOM AUTOMÁTICO EN LOS CORTES (estilo "jump cut"): cuando se quitan silencios, cada corte se ve como un brinco.
// Si en el corte se alterna el encuadre (abierto 1.00× ↔ cerrado 1.10×), el brinco parece cambio de cámara.
// Reglas (docs/investigacion.md §5.3, rama nube/investigacion):
// - Alternar 1.00× / Z en cada corte (Suave 1.06 · Normal 1.10 · Fuerte 1.15).
// - Cada encuadre dura ≥ 4 s; los clips de < 2.5 s heredan el zoom anterior (evita parpadeo).
// - Promedio de ≥ ~6 s entre cambios (máx. ~1 cambio cada 6–8 s).
// - Si pasan > 25 s sin cambio, se parte el clip en el siguiente inicio de frase y ahí cambia (nunca a media palabra).
// - Golpe 1.18× (tope 1.25×) en picos fuertes de energía de la voz.
// - Centro en la cara (cx, cy entre 0 y 1) sin salirse del cuadro; si no hay cara, tercio superior central.
// - Lo que el usuario puso o quitó a mano (zoomManual) no se toca.
// Funciona en Node (pruebas, server.js) y en el navegador (window.AutoZoom).
(function (root) {
  const LEVELS = { suave: 1.06, normal: 1.10, fuerte: 1.15 };
  const PUNCH = 1.18, MAX_Z = 1.25, OLD_Z = 1.12;
  const MIN_HOLD = 4, SHORT = 2.5, AVG_GAP = 6, LONG = 25, MIN_TAIL = 4;
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const r3 = x => +Number(x).toFixed(3);

  // Zoom de un clip en número (compatibilidad: zoom:true de versiones viejas = 1.12×; false/0 = sin zoom).
  function zoomValue(c) {
    if (!c || !c.zoom) return 1;
    if (c.zoom === true) return OLD_Z;
    const z = Number(c.zoom);
    if (!Number.isFinite(z)) return OLD_Z; // valor viejo no numérico pero truthy
    return z > 1.001 ? clamp(z, 1.01, MAX_Z) : 1;
  }

  // Centro válido para que el recorte de tamaño 1/Z no se salga del cuadro.
  function clampCenter(z, cx, cy) {
    const h = 0.5 / Math.max(1, z);
    const x = Number.isFinite(+cx) ? +cx : 0.5, y = Number.isFinite(+cy) ? +cy : 1 / 3;
    return { cx: r3(clamp(x, h, 1 - h)), cy: r3(clamp(y, h, 1 - h)) };
  }

  // Inicios de frase: inicio de palabra después de una pausa ≥ 0.25 s (o inicios de segmento de la transcripción).
  function phraseStarts(words, segments) {
    const out = [];
    const ws = (words || []).filter(w => Number.isFinite(+w.start) && Number.isFinite(+w.end)).sort((a, b) => a.start - b.start);
    for (let i = 0; i < ws.length; i++) if (i === 0 || +ws[i].start - +ws[i - 1].end >= 0.25) out.push(+ws[i].start);
    for (const s of segments || []) if (Number.isFinite(+s.start)) out.push(+s.start);
    return [...new Set(out.map(r3))].sort((a, b) => a - b);
  }

  // ¿Hay un pico fuerte de voz dentro de [a, b]? energy = [{t, db}] por segundo.
  function makePeakTest(energy) {
    const pts = (energy || []).filter(e => Number.isFinite(+e.t) && Number.isFinite(+e.db) && e.db > -90);
    if (pts.length < 8) return () => false;
    const dbs = pts.map(p => +p.db).sort((a, b) => a - b);
    const med = dbs[Math.floor(dbs.length / 2)];
    const p95 = dbs[Math.floor(dbs.length * 0.95)];
    const thr = Math.max(med + 9, p95);
    return (a, b) => pts.some(p => p.t >= a && p.t < b && p.db >= thr);
  }

  // Parte clips largos en inicios de frase para que no pasen > 25 s sin cambio (en tiempo de SALIDA).
  function splitLong(clips, phrases) {
    const out = [];
    for (const c of clips) {
      if (c.zoomManual) { out.push({ ...c }); continue; }
      let a = +c.start;
      const b = +c.end;
      while (b - a > LONG + MIN_TAIL) {
        let t = phrases.find(p => p >= a + LONG && p <= b - MIN_TAIL);
        if (t == null && !phrases.length) t = a + LONG; // sin transcripción: corte a los 25 s
        if (t == null) break;
        out.push({ ...c, start: r3(a), end: r3(t) });
        a = t;
        out.push(null); // marca: el siguiente pedazo es un corte agregado por el zoom automático
      }
      out.push({ ...c, start: r3(a), end: r3(b) });
    }
    // Convierte las marcas en autoSplit:true en el pedazo que sigue.
    const res = [];
    for (let i = 0; i < out.length; i++) { if (out[i] === null) { out[i + 1].autoSplit = true; continue; } res.push(out[i]); }
    return res;
  }

  // Plan completo. clips en orden de la línea del tiempo (tiempos de la fuente). Regresa clips NUEVOS.
  // opts: level ('suave'|'normal'|'fuerte' o número), words/segments (transcripción), energy [{t,db}],
  //       faceOf(clip) → {cx, cy} | null.
  function planAutoZoom(clips, { level = 'normal', words = [], segments = [], energy = [], faceOf = null } = {}) {
    const Z = clamp(typeof level === 'number' ? level : (LEVELS[String(level).toLowerCase()] || LEVELS.normal), 1.01, MAX_Z);
    const punchZ = clamp(Math.max(PUNCH, Z + 0.04), 1.01, MAX_Z);
    const base = removeAutoZoom(clips || []);
    const pieces = splitLong(base, phraseStarts(words, segments));
    const isPeak = makePeakTest(energy);
    let cur = 1, outT = 0, lastChange = 0, changes = 0;
    const res = [];
    pieces.forEach((c, i) => {
      const len = c.end - c.start;
      if (c.zoomManual) { cur = zoomValue(c); lastChange = outT; res.push({ ...c }); outT += len; return; }
      let z = cur;
      if (i > 0 && len >= SHORT && outT - lastChange >= MIN_HOLD && (changes + 1) * AVG_GAP <= outT + AVG_GAP) {
        z = isPeak(c.start, c.end) ? punchZ : (cur > 1.001 ? 1 : Z);
        if (Math.abs(z - cur) < 0.001) z = cur > 1.001 ? 1 : Z;
      }
      if (Math.abs(z - cur) > 0.001) { changes++; lastChange = outT; cur = z; }
      const n = { ...c, zoomAuto: true };
      if (z > 1.001) {
        const f = (faceOf && faceOf(c)) || null;
        const ctr = clampCenter(z, f ? f.cx : 0.5, f ? f.cy : 1 / 3);
        Object.assign(n, { zoom: r3(z), zoomCx: ctr.cx, zoomCy: ctr.cy });
      } else { n.zoom = false; delete n.zoomCx; delete n.zoomCy; }
      res.push(n);
      outT += len;
    });
    return res;
  }

  // Quita lo que puso el zoom automático: zooms y cortes que agregó (une pedazos contiguos marcados autoSplit).
  function removeAutoZoom(clips) {
    const out = [];
    for (const c0 of clips || []) {
      const c = { ...c0 };
      if (c.zoomAuto) { c.zoom = false; delete c.zoomCx; delete c.zoomCy; delete c.zoomAuto; }
      const prev = out[out.length - 1];
      // Nunca unir si alguno de los dos pedazos tiene zoom puesto a mano (se perdería ese zoom).
      if (c.autoSplit && prev && !c.zoomManual && !prev.zoomManual && Math.abs(prev.end - c.start) < 0.002) { prev.end = c.end; continue; }
      delete c.autoSplit;
      out.push(c);
    }
    return out;
  }

  // Filtro de ffmpeg del zoom de un clip: recorte 1/Z centrado en (cx, cy) sin salirse del cuadro y reescalado de
  // vuelta al tamaño original con lanczos (el mejor reescalado de ffmpeg). Tope 1.25× para no perder nitidez en 1080p.
  function cropZoomFilter(c, W, H) {
    const z = zoomValue(c);
    if (z <= 1.001 || !W || !H) return '';
    const ctr = clampCenter(z, c.zoomCx != null ? c.zoomCx : 0.5, c.zoomCy != null ? c.zoomCy : 0.5);
    const cw = Math.floor(W / z / 2) * 2, ch = Math.floor(H / z / 2) * 2;
    const x = Math.round(clamp(ctr.cx * W - cw / 2, 0, W - cw)), y = Math.round(clamp(ctr.cy * H - ch / 2, 0, H - ch));
    return `,crop=${cw}:${ch}:${x}:${y},scale=${W}:${H}:flags=lanczos,setsar=1`;
  }

  // Cómo se ve en el reproductor (vista previa sin exportar): transform de CSS equivalente al recorte.
  function previewTransform(c) {
    const z = zoomValue(c);
    if (z <= 1.001) return { transform: '', origin: '' };
    const ctr = clampCenter(z, c.zoomCx != null ? c.zoomCx : 0.5, c.zoomCy != null ? c.zoomCy : 0.5);
    // Con transform-origin (ox, oy) y escala z, el centro visible queda en ctr cuando o = (z·c − 0.5)/(z − 1).
    const o = v => clamp((z * v - 0.5) / (z - 1), 0, 1) * 100;
    return { transform: `scale(${z})`, origin: `${o(ctr.cx).toFixed(1)}% ${o(ctr.cy).toFixed(1)}%` };
  }

  // Normaliza lo que manda la interfaz al exportar (número o true/false + centro).
  function sanitizeSegmentZoom(s) {
    const z = zoomValue(s);
    if (z <= 1.001) return { zoom: 0 };
    const ctr = clampCenter(z, s.zoomCx != null ? s.zoomCx : 0.5, s.zoomCy != null ? s.zoomCy : 0.5);
    return { zoom: z, zoomCx: ctr.cx, zoomCy: ctr.cy };
  }

  const api = { LEVELS, PUNCH, MAX_Z, OLD_Z, zoomValue, clampCenter, phraseStarts, planAutoZoom, removeAutoZoom, cropZoomFilter, previewTransform, sanitizeSegmentZoom };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.AutoZoom = api;
})(typeof window !== 'undefined' ? window : globalThis);
