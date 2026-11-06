'use strict';
// ===== ZOOM AUTOMÁTICO EN LOS CORTES (estilo editor de YouTube) =====
// Alterna encuadre normal / acercado en cada corte (Suave 1.06×, Normal 1.10×, Fuerte 1.15×), sostiene cada encuadre
// ≥ 4 s, no cambia en clips < 2.5 s y en tramos largos sin cortes parte el clip al inicio de una frase.
// La lógica está en lib/autozoom.js; el export hace el recorte centrado y reescala con lanczos (máx. 1.25×).
// Los zooms puestos a mano con 🔍 se respetan; "Quitar zooms automáticos" solo quita los que puso este botón.
// Usa del app.js: state, clips, ensureClips, pushUndo, saveClips, syncRemoved, buildTimeline, notice, selectedClipIdx, multiSel.
(function () {
  const AZ = window.AutoZoom;
  const anchor = document.getElementById('tlZoomAuto');
  if (!AZ || !anchor) return;
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const say = (m, bad) => { if (typeof notice === 'function') notice(m, bad); };
  const level = el('select', 'tl-zsel'); level.id = 'azLevel'; level.title = 'Qué tanto se acerca';
  [['suave', 'Suave'], ['normal', 'Normal'], ['fuerte', 'Fuerte']].forEach(([v, t]) => { const o = el('option', null, t); o.value = v; if (v === 'normal') o.selected = true; level.append(o); });
  const go = el('button', 'tl-btn', '🎥 Zoom en los cortes'); go.type = 'button'; go.id = 'azApply';
  go.title = 'Alterna un encuadre normal y uno acercado en cada corte, como los editores de YouTube (puedes quitar cualquiera con 🔍)';
  const off = el('button', 'tl-btn', '✖ Quitar zooms automáticos'); off.type = 'button'; off.id = 'azRemove';
  off.title = 'Quita solo los zooms que puso "Zoom en los cortes" (los que pusiste a mano se quedan)';
  anchor.after(go, level, off);
  const words = () => {
    const segs = (typeof state !== 'undefined' && state && state.transcript) || [];
    return segs.filter(s => Number.isFinite(+s.start) && Number.isFinite(+s.end) && String(s.text || '').trim().split(/\s+/).length === 1).map(s => ({ start: +s.start, end: +s.end }));
  };
  const resetSel = () => { try { selectedClipIdx = -1; if (multiSel) multiSel.clear(); } catch {} };
  go.onclick = () => {
    try {
      if (typeof state === 'undefined' || !state || !state.project) throw Error('Abre un video primero.');
      ensureClips();
      if (!clips.length) throw Error('No hay clips en la línea del tiempo.');
      pushUndo('Zoom en los cortes');
      clips = AZ.planAutoZoom(clips, { level: level.value, words: words(), segments: (state.transcript || []) });
      resetSel(); saveClips(); syncRemoved(); buildTimeline();
      const n = clips.filter(c => c.zoomAuto && AZ.zoomValue(c) > 1).length;
      say(`🎥 Puse ${n} acercamiento(s) alternados en los cortes (${level.options[level.selectedIndex].text}). Ahora los centro en las caras… (puedes seguir editando)`);
      centerOnFaces();
    } catch (e) { say(e.message, true); }
  };
  // CENTRAR EN LAS CARAS: un cuadro del ORIGINAL a la mitad de cada clip con zoom automático → MediaPipe (el mismo
  // FaceLandmarker de los Shorts, vision.js) → centro del grupo de caras, con la cara un poco arriba del centro.
  // En segundo plano; si no hay internet o no hay caras, el zoom se queda al centro. Solo toca clips que no cambiaron.
  let centering = 0;
  async function centerOnFaces() {
    const run = ++centering;
    if (typeof loadVision !== 'function') return;
    let vision; try { vision = await loadVision(); } catch { return say('No pude cargar el detector de caras (¿sin internet?). Los zooms quedan al centro.', true); }
    const todo = clips.filter(c => c.zoomAuto && AZ.zoomValue(c) > 1).map(c => ({ start: c.start, end: c.end }));
    let done = 0, centered = 0;
    const one = async k => {
      const t = (k.start + k.end) / 2;
      const img = new Image(); img.crossOrigin = 'anonymous';
      img.src = `/api/thumbs/frame?t=${t.toFixed(3)}&w=640`;
      // onload (no img.decode(): con la ventana minimizada el navegador lo deja esperando para siempre)
      await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(Error('frame')); setTimeout(() => rej(Error('timeout')), 20000); });
      // Personas primero (pose: ubica la cabeza aunque esté lejos o de perfil, como en los Shorts); si no hay, caras.
      let faces = [];
      try { faces = ((vision.pose.detect(img).landmarks) || []).map(lm => { const p = personOf(lm); return { cx: p.hx, cy: p.hy, w: Math.max(0.02, p.sw) }; }); } catch {}
      if (!faces.length) faces = ((vision.face.detect(img).faceLandmarks) || []).map(lm => { let x0 = 1, x1 = 0, y0 = 1, y1 = 0; for (const p of lm) { if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x; if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y; } return { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, w: x1 - x0 }; });
      if (!faces.length) return;
      const W = faces.reduce((a, f) => a + f.w, 0) || 1; // caras más grandes (más cerca) pesan más
      const cx = faces.reduce((a, f) => a + f.cx * f.w, 0) / W, cy = faces.reduce((a, f) => a + f.cy * f.w, 0) / W;
      if (run !== centering) return;
      const c = clips.find(x => Math.abs(x.start - k.start) < 1e-3 && Math.abs(x.end - k.end) < 1e-3 && x.zoomAuto);
      if (!c) return;
      const ctr = AZ.clampCenter(AZ.zoomValue(c), cx, cy + 0.06);
      c.zoomCx = ctr.cx; c.zoomCy = ctr.cy; centered++;
    };
    for (let i = 0; i < todo.length; i += 2) { // 2 a la vez (el servidor saca 2 cuadros en paralelo)
      if (run !== centering) return;
      await Promise.all(todo.slice(i, i + 2).map(k => one(k).catch(() => {})));
      done = Math.min(todo.length, i + 2);
      if (done % 10 === 0 || done === todo.length) { saveClips(); buildTimeline(); }
    }
    if (run === centering) say(`🎯 Centré ${centered} de ${todo.length} zooms en las caras. Velos con ▶ o "Vista de la edición".`);
  }
  // VISTA PREVIA del zoom en el reproductor: mientras el video pasa por un clip con zoom (automático o a mano), el
  // reproductor se acerca igual que el export (aproximado: mismo factor y centro), sin tener que exportar.
  const video = document.getElementById('video');
  if (video) {
    let lastKey = '';
    const apply = () => {
      const t = video.currentTime;
      const list = (typeof clips !== 'undefined' && clips) || [];
      const c = list.find(k => t >= k.start && t < k.end);
      const pt = c ? AZ.previewTransform(c) : { transform: '', origin: '' };
      const key = pt.transform + '|' + pt.origin;
      if (key === lastKey) return;
      lastKey = key;
      video.style.transition = 'transform .12s ease-out';
      video.style.transformOrigin = pt.origin || '';
      video.style.transform = pt.transform || '';
    };
    video.addEventListener('timeupdate', apply);
    video.addEventListener('seeked', apply);
    video.addEventListener('emptied', () => { lastKey = ''; video.style.transform = ''; });
  }
  off.onclick = () => {
    try {
      ensureClips();
      if (!clips.some(c => c.zoomAuto || c.autoSplit)) throw Error('No hay zooms automáticos que quitar.');
      centering++; // detiene un centrado en curso
      pushUndo('Quitar zooms automáticos');
      clips = AZ.removeAutoZoom(clips);
      resetSel(); saveClips(); syncRemoved(); buildTimeline();
      say('Zooms automáticos quitados (los que pusiste a mano se quedan).');
    } catch (e) { say(e.message, true); }
  };
})();
