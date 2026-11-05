'use strict';
// ===== MINIATURAS =====
// Galería de fotogramas del ORIGINAL (no de la vista previa) para elegir la miniatura del video:
// - a lo largo de todo el video, alrededor del momento actual del reproductor o en los mejores momentos del Resumen;
// - ◀ ▶ mueve un cuadro exacto; "Guardar PNG" guarda el cuadro a resolución completa y sin pérdida (exports + Descargas);
// - "✨ Sugerir caras expresivas": MediaPipe (FaceLandmarker con blendshapes) puntúa boca abierta, sonrisa, cejas, ojos
//   (lib/thumbs.js, el mismo código que se prueba en tests/thumbs.test.js). Sin internet la galería funciona igual.
(function () {
  const T = window.EmmThumbs;
  const $m = id => document.getElementById(id);
  const post = async (url, data) => { const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data || {}) }); const b = await r.json(); if (!r.ok) throw Error(b.error || 'Error inesperado'); return b; };
  const say = (m, bad) => { if (typeof notice === 'function') notice(m, bad); };
  const frameUrl = (t, w) => `/api/thumbs/frame?t=${(+t).toFixed(3)}&w=${w}`;
  const panel = $m('thumbsPanel'), body = $m('thumbsBody');
  if (!panel || !body || !T) return;

  let plan = null, times = [], cur = null, scores = new Map(), loadedFor = '';
  function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

  // ---- armado de la interfaz ----
  const bar = el('div', 'row wrap thumbsBar');
  const mode = el('select'); mode.id = 'thumbsMode';
  [['all', 'Todo el video'], ['around', 'Alrededor del momento actual'], ['bestof', 'Mejores momentos (Resumen)']].forEach(([v, t]) => { const o = el('option', null, t); o.value = v; mode.append(o); });
  const count = el('select'); count.id = 'thumbsCount';
  [12, 24, 48].forEach(n => { const o = el('option', null, n + ' cuadros'); o.value = n; if (n === 24) o.selected = true; count.append(o); });
  const load = el('button', 'secondary', '🖼️ Ver galería'); load.type = 'button'; load.id = 'thumbsLoad';
  const suggest = el('button', 'secondary', '✨ Sugerir caras expresivas'); suggest.type = 'button'; suggest.id = 'thumbsSuggest'; suggest.disabled = true;
  const info = el('span', 'muted'); info.id = 'thumbsInfo';
  bar.append(mode, count, load, suggest, info);
  const view = el('div', 'thumbsView'); view.hidden = true;
  const big = el('img', 'thumbsBig'); big.alt = 'Fotograma elegido'; big.id = 'thumbsBig';
  const ctl = el('div', 'row wrap thumbsCtl');
  const prev = el('button', 'secondary compact', '◀ 1 cuadro'); prev.type = 'button';
  const next = el('button', 'secondary compact', '1 cuadro ▶'); next.type = 'button';
  const when = el('span', 'thumbsWhen');
  const go = el('button', 'secondary compact', '⏯ Ir a este momento'); go.type = 'button';
  const save = el('button', 'primary compact', '💾 Guardar PNG'); save.type = 'button'; save.id = 'thumbsSave';
  ctl.append(prev, when, next, go, save);
  view.append(big, ctl);
  const grid = el('div', 'thumbsGrid'); grid.id = 'thumbsGrid';
  body.append(el('p', 'hint', 'Fotogramas del video original. Elige uno, afínalo cuadro por cuadro y guárdalo en PNG a resolución completa (se copia a Descargas).'), bar, view, grid);

  function select(t) {
    cur = +(+t).toFixed(3);
    view.hidden = false;
    big.src = frameUrl(cur, 1280);
    when.textContent = T.fmtTime(cur);
    grid.querySelectorAll('.thumbCell').forEach(c => c.classList.toggle('sel', Math.abs(+c.dataset.t - cur) < 1e-3));
  }
  function cell(t) {
    const c = el('button', 'thumbCell'); c.type = 'button'; c.dataset.t = t;
    const img = el('img'); img.loading = 'lazy'; img.decoding = 'async'; img.alt = 'Fotograma en ' + T.fmtTime(t); img.src = frameUrl(t, 320);
    const lab = el('span', 'thumbTime', T.fmtTime(t));
    c.append(img, lab);
    const sc = scores.get(+t);
    if (sc && sc.rank) { const b = el('span', 'thumbBadge', '✨ ' + sc.rank); b.title = `Expresión ${Math.round(sc.score * 100)}/100`; c.append(b); c.classList.add('suggested'); }
    c.onclick = () => select(t);
    return c;
  }
  function draw() {
    grid.replaceChildren();
    const order = [...times];
    if (scores.size) order.sort((a, b) => ((scores.get(a) || {}).rank || 99) - ((scores.get(b) || {}).rank || 99) || a - b);
    order.forEach(t => grid.append(cell(t)));
  }

  async function loadGallery() {
    const v = $m('video');
    plan = await post('/api/thumbs/plan', { mode: mode.value, count: +count.value, around: v ? v.currentTime || 0 : 0 });
    times = (plan.times || []).map(Number).filter(Number.isFinite);
    scores = new Map();
    loadedFor = String((window.state && state.project && state.project.videoPath) || '');
    info.textContent = `${times.length} cuadros · original ${plan.width}×${plan.height} a ${Math.round(plan.fps)} fps` + (mode.value === 'bestof' && !plan.hasBestof ? ' · (sin Resumen del directo: se usa todo el video)' : '');
    suggest.disabled = !times.length;
    draw();
    if (times.length && cur == null) select(times[0]);
  }
  load.onclick = async () => { load.disabled = true; try { await loadGallery(); } catch (e) { say(e.message, true); } finally { load.disabled = false; } };
  const step = n => { if (cur == null || !plan) return; select(T.stepFrame(cur, n, plan.fps, plan.duration)); };
  prev.onclick = () => step(-1); next.onclick = () => step(1);
  go.onclick = () => { const v = $m('video'); if (v && cur != null) { v.currentTime = cur; v.pause(); } };
  save.onclick = async () => {
    if (cur == null) return;
    save.disabled = true; save.textContent = 'Guardando…';
    try { const r = await post('/api/thumbs/save', { t: cur }); say(r.message); if (typeof refresh === 'function') refresh().catch(() => {}); }
    catch (e) { say('No se pudo guardar: ' + e.message, true); }
    finally { save.disabled = false; save.textContent = '💾 Guardar PNG'; }
  };

  // ---- sugerencias con MediaPipe (FaceLandmarker con blendshapes) ----
  let faceLm = null;
  async function loadFace() {
    if (faceLm) return faceLm;
    if (typeof MP_BASE === 'undefined' || typeof MP_MODELS === 'undefined') throw Error('no cargó vision.js');
    faceLm = (async () => {
      const V = await import(`${MP_BASE}/vision_bundle.mjs`);
      const files = await V.FilesetResolver.forVisionTasks(`${MP_BASE}/wasm`);
      const make = delegate => V.FaceLandmarker.createFromOptions(files, { baseOptions: { modelAssetPath: MP_MODELS.face, delegate }, runningMode: 'IMAGE', numFaces: 4, outputFaceBlendshapes: true, minFaceDetectionConfidence: 0.3, minFacePresenceConfidence: 0.3 });
      try { return await make('GPU'); } catch { return await make('CPU'); }
    })();
    faceLm.catch(() => { faceLm = null; });
    return faceLm;
  }
  const loadImg = src => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(Error('imagen')); i.src = src; });
  function analyze(lm, img) {
    const r = lm.detect(img);
    const faces = (r.faceLandmarks || []).map((pts, k) => {
      let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
      for (const p of pts) { if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x; if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y; }
      const bs = r.faceBlendshapes && r.faceBlendshapes[k] ? r.faceBlendshapes[k].categories : [];
      return { blend: T.blendMap(bs), w: x1 - x0, h: y1 - y0, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
    });
    // Nitidez en 320 px de ancho (la misma escala con la que se calibró sharpFactor).
    const W = 320, H = Math.max(1, Math.round(img.naturalHeight * W / img.naturalWidth));
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const cx = cv.getContext('2d', { willReadFrequently: true }); cx.drawImage(img, 0, 0, W, H);
    const sharp = T.laplacianVariance(T.grayFromRGBA(cx.getImageData(0, 0, W, H).data, W, H), W, H);
    return { faces, sharp };
  }
  suggest.onclick = async () => {
    if (!times.length) return;
    suggest.disabled = true; const label = suggest.textContent;
    try {
      suggest.textContent = 'Cargando detector de caras…';
      let lm;
      try { lm = await loadFace(); }
      catch { throw Error('No se pudo cargar el detector de caras (la primera vez necesita internet). La galería y "Guardar PNG" siguen funcionando.'); }
      const frames = [];
      for (let i = 0; i < times.length; i++) {
        suggest.textContent = `Revisando caras ${i + 1}/${times.length}…`;
        try { const img = await loadImg(frameUrl(times[i], 480)); frames.push({ t: times[i], ...analyze(lm, img) }); } catch {}
      }
      const top = T.rankFrames(frames, { top: 6, minGap: Math.max(1, (plan.duration || 60) / 400) });
      scores = new Map(top.map((f, i) => [f.t, { score: f.score, rank: i + 1 }]));
      draw();
      if (top.length) { select(top[0].t); say(`✨ Encontré ${top.length} cuadros con caras expresivas: van primero en la galería.`); }
      else say('No encontré caras claras en estos cuadros. Prueba “Alrededor del momento actual” en un momento con la cara de frente.');
    } catch (e) { say(e.message, true); }
    finally { suggest.disabled = false; suggest.textContent = label; }
  };
  // Si cambia el video, la galería anterior ya no sirve.
  setInterval(() => { const vp = String((window.state && state.project && state.project.videoPath) || ''); if (loadedFor && vp !== loadedFor) { loadedFor = ''; times = []; scores = new Map(); cur = null; grid.replaceChildren(); view.hidden = true; info.textContent = ''; suggest.disabled = true; } }, 3000);
})();
