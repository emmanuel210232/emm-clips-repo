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
  const level = el('select', 'tl-sel'); level.id = 'azLevel'; level.title = 'Qué tanto se acerca';
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
      say(`🎥 Puse ${n} acercamiento(s) alternados en los cortes (${level.options[level.selectedIndex].text}). Se ven al exportar; quita los que no quieras con 🔍 o Ctrl+Z.`);
    } catch (e) { say(e.message, true); }
  };
  off.onclick = () => {
    try {
      ensureClips();
      if (!clips.some(c => c.zoomAuto || c.autoSplit)) throw Error('No hay zooms automáticos que quitar.');
      pushUndo('Quitar zooms automáticos');
      clips = AZ.removeAutoZoom(clips);
      resetSel(); saveClips(); syncRemoved(); buildTimeline();
      say('Zooms automáticos quitados (los que pusiste a mano se quedan).');
    } catch (e) { say(e.message, true); }
  };
})();
