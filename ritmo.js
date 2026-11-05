'use strict';
// ===== RITMO: quitar silencios con control fino (debajo de "Quitar silencios") =====
// 1) "Analizar pausas" corre silencedetect UNA vez (todas las pausas ≥ 0.2 s, data/pace_silences.json).
// 2) Mover "Ritmo" (qué pausas se quitan) y los márgenes antes/después muestra el resultado AL INSTANTE (lib/pace.js),
//    sin volver a leer el audio. 3) "Aplicar" convierte el plan en clips de la línea del tiempo (se puede deshacer).
// Usa del app.js: state, clips, ensureClips, pushUndo, saveClips, syncRemoved, buildTimeline, tlDuration, notice.
(function () {
  const P = window.Pace;
  const row = document.querySelector('.silenceRow');
  if (!P || !row) return;
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const post = async (url, data) => { const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data || {}) }); const b = await r.json(); if (!r.ok) throw Error(b.error || 'Error inesperado'); return b; };
  const say = (m, bad) => { if (typeof notice === 'function') notice(m, bad); };

  const box = el('details', 'paceBox'); box.id = 'paceBox';
  box.append(el('summary', null, '🎚️ Ritmo y márgenes (ajuste fino de los silencios)'));
  const hint = el('p', 'hint', 'Analiza las pausas una sola vez y luego mueve los controles: ves al momento cuánto dura el video. "Aplicar" se puede deshacer con Ctrl+Z.');
  const top = el('div', 'row wrap'); const scanBtn = el('button', 'secondary compact', '🔎 Analizar pausas'); scanBtn.type = 'button';
  const noiseSel = el('select'); noiseSel.title = 'Qué tan bajo debe ser el audio para contar como pausa';
  [['35', 'Ambiente tranquilo'], ['30', 'Normal'], ['26', 'Calle / ruido de fondo']].forEach(([v, t]) => { const o = el('option', null, t); o.value = v; if (v === '30') o.selected = true; noiseSel.append(o); });
  const noiseLbl = el('label', null, 'Ruido '); noiseLbl.append(noiseSel);
  const status = el('span', 'muted', 'Todavía no se han analizado las pausas.');
  top.append(scanBtn, noiseLbl, status);

  const ctl = el('div', 'paceCtl'); ctl.hidden = true;
  const mk = (label, min, max, step, val) => { const w = el('label', 'paceSlider'); const t = el('span', 'paceLbl', label); const r = el('input'); r.type = 'range'; r.min = min; r.max = max; r.step = step; r.value = val; const v = el('b', 'paceVal'); w.append(t, r, v); return { w, r, v }; };
  const steps = P.RHYTHM_STEPS;
  const rhythm = mk('Ritmo', 0, steps.length - 1, 1, steps.indexOf(0.6) >= 0 ? steps.indexOf(0.6) : 6);
  const before = mk('Margen antes', 0, 300, 10, Math.round(P.DEFAULTS.padBefore * 1000));
  const after = mk('Margen después', 0, 300, 10, Math.round(P.DEFAULTS.padAfter * 1000));
  const lockW = el('label', 'inlineCheck mini'); const lock = el('input'); lock.type = 'checkbox'; lockW.append(lock, document.createTextNode(' 🔒 mismos márgenes'));
  // Whisper estira el tiempo de cada palabra sobre la pausa que le sigue: protegerlas casi no deja cortar (medido en un
  // directo real: a 0.6 s quitaba 5 s en vez de 31 s). Por defecto manda el AUDIO (como "Quitar silencios").
  const protW = el('label', 'inlineCheck mini'); const prot = el('input'); prot.type = 'checkbox'; protW.append(prot, document.createTextNode(' Proteger palabras de la transcripción (corta mucho menos)'));
  prot.onchange = () => refresh();
  const summary = el('div', 'paceSummary', '');
  const actions = el('div', 'row wrap'); const applyBtn = el('button', 'primary compact', '✅ Aplicar a la línea del tiempo'); applyBtn.type = 'button';
  const resetBtn = el('button', 'secondary compact', 'Valores normales'); resetBtn.type = 'button';
  actions.append(applyBtn, resetBtn);
  ctl.append(rhythm.w, before.w, after.w, lockW, protW, summary, actions);
  box.append(hint, top, ctl);
  row.after(box);

  let data = null, lastPlan = null, scanning = false;
  const words = () => !prot.checked ? [] : P.reliableWords((typeof state !== 'undefined' && state && state.transcript) || []);
  function opts() { return { minPause: steps[+rhythm.r.value], padBefore: +before.r.value / 1000, padAfter: +after.r.value / 1000 }; }
  function refresh() {
    rhythm.v.textContent = P.rhythmLabel(steps[+rhythm.r.value]);
    before.v.textContent = before.r.value + ' ms'; after.v.textContent = after.r.value + ' ms';
    if (!data) return;
    const dur = Number(data.total) || (typeof tlDuration === 'function' ? tlDuration() : 0);
    lastPlan = P.plan({ silences: data.silences, duration: dur, words: words(), ...opts() });
    summary.textContent = P.summary(lastPlan);
    applyBtn.disabled = !lastPlan || !lastPlan.keep.length;
  }
  rhythm.r.oninput = refresh;
  before.r.oninput = () => { if (lock.checked) after.r.value = before.r.value; refresh(); };
  after.r.oninput = () => { if (lock.checked) before.r.value = after.r.value; refresh(); };
  lock.onchange = () => { if (lock.checked) { after.r.value = before.r.value; refresh(); } };
  resetBtn.onclick = () => { rhythm.r.value = steps.indexOf(0.6); before.r.value = Math.round(P.DEFAULTS.padBefore * 1000); after.r.value = Math.round(P.DEFAULTS.padAfter * 1000); lock.checked = false; refresh(); };

  async function load() {
    try {
      const r = await fetch('/api/pace/silences'); const d = await r.json();
      if (d && Array.isArray(d.silences)) { data = d; ctl.hidden = false; status.textContent = `${d.silences.length} pausas analizadas.`; refresh(); }
      else { data = null; ctl.hidden = true; status.textContent = 'Todavía no se han analizado las pausas.'; }
    } catch { /* sin servidor: se queda como estaba */ }
  }
  scanBtn.onclick = async () => {
    try {
      if (typeof state === 'undefined' || !state || !state.project) throw Error('Abre un video primero.');
      await post('/api/pace/scan', { noise: +noiseSel.value });
      scanning = true; status.textContent = 'Analizando las pausas… (mira la barra de arriba)';
      say('🔎 Analizando las pausas del audio una sola vez. Después mueves el Ritmo al instante.');
    } catch (e) { say(e.message, true); }
  };
  applyBtn.onclick = () => {
    try {
      if (!lastPlan || !lastPlan.keep.length) throw Error('Primero analiza las pausas.');
      ensureClips(); pushUndo('Ritmo'); clips = lastPlan.keep.map(k => ({ start: k.start, end: k.end })); saveClips();
      syncRemoved(); buildTimeline();
      say(`🎚️ ${P.summary(lastPlan)}. Revisa y exporta (puedes deshacer con Ctrl+Z).`);
    } catch (e) { say(e.message, true); }
  };
  // Al abrir otro video o al terminar el análisis, recargar las pausas.
  let lastVideo = null;
  setInterval(() => {
    const st = typeof state !== 'undefined' ? state : null;
    const v = st && st.project ? st.project.videoPath : null;
    if (v !== lastVideo) { lastVideo = v; data = null; ctl.hidden = true; if (v) load(); }
    if (scanning && st && st.job && st.job.status !== 'running') { scanning = false; load(); }
  }, 1000);
  refresh();
})();
