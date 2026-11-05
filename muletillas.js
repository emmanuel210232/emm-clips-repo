'use strict';
// ===== MULETILLAS ("eh", "este…", "o sea", "¿no?"): revisar y quitar las que el usuario marque =====
// La lógica (qué cuenta como muletilla y el tramo a quitar sin dejar hueco raro) está en lib/fillers.js.
// Solo se marcan solas las "seguras" con tiempo confiable; el resto se lista para que el usuario decida.
// "Quitar las marcadas" las quita de la línea del tiempo en UN paso (Ctrl+Z lo regresa).
// Usa del app.js: state, clips, ensureClips, pushUndo, saveClips, syncRemoved, buildTimeline, playAt, notice, fmt.
(function () {
  const F = window.EmmFillers;
  const host = document.getElementById('fillersBody');
  if (!F || !host) return;
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const say = (m, bad) => { if (typeof notice === 'function') notice(m, bad); };
  const tfmt = s => (typeof fmt === 'function' ? fmt(s) : (Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0')));
  const LS = 'eirl_fillers_custom';
  const loadCustom = () => { try { return JSON.parse(localStorage.getItem(LS) || '[]').filter(x => x && x.term); } catch { return []; } };
  const saveCustom = l => { try { localStorage.setItem(LS, JSON.stringify(l)); } catch {} };

  const bar = el('div', 'row wrap');
  const findBtn = el('button', 'secondary compact', '🔎 Buscar muletillas'); findBtn.type = 'button';
  const safeBtn = el('button', 'secondary compact', 'Marcar solo las seguras'); safeBtn.type = 'button';
  const noneBtn = el('button', 'secondary compact', 'Desmarcar todas'); noneBtn.type = 'button';
  const applyBtn = el('button', 'primary compact', '✂️ Quitar las marcadas'); applyBtn.type = 'button';
  const info = el('span', 'muted', '');
  bar.append(findBtn, safeBtn, noneBtn, applyBtn, info);
  const list = el('div', 'fillersList');
  const custom = el('details', 'fillersCustom'); custom.append(el('summary', null, 'Mis muletillas (propias)'));
  const cRow = el('div', 'row wrap'); const cIn = el('input'); cIn.type = 'text'; cIn.maxLength = 40; cIn.placeholder = 'Palabra o frase, p. ej. "la neta"';
  const cAdd = el('button', 'secondary compact', 'Agregar'); cAdd.type = 'button'; const cList = el('div', 'fillersChips');
  cRow.append(cIn, cAdd); custom.append(el('p', 'hint', 'Solo se detectan si van seguidas de una pausa (para no cortar frases normales). Se listan para revisar.'), cRow, cList);
  host.append(bar, list, custom);

  let items = [], marked = new Set(), forVideo = '';
  function renderCustom() {
    cList.replaceChildren();
    for (const c of loadCustom()) {
      const chip = el('span', 'fillerChip', c.term); const x = el('button', 'tl-btn', '✕'); x.type = 'button'; x.title = 'Quitar';
      x.onclick = () => { saveCustom(loadCustom().filter(y => y.term !== c.term)); renderCustom(); };
      chip.append(x); cList.append(chip);
    }
  }
  cAdd.onclick = () => { const t = cIn.value.trim(); if (!t || !F.normalize(t)) return; const l = loadCustom(); if (!l.some(x => F.normalize(x.term) === F.normalize(t))) l.push({ term: t, level: 'revisar', enabled: true }); saveCustom(l); cIn.value = ''; renderCustom(); };

  function render() {
    list.replaceChildren();
    const live = (typeof clips !== 'undefined' && clips) ? clips : [];
    const shown = items.filter(f => !F.isRemoved(f, live));
    info.textContent = items.length ? `${shown.length} por revisar · ${[...marked].filter(id => shown.some(f => f.id === id)).length} marcadas` : '';
    applyBtn.disabled = !shown.some(f => marked.has(f.id));
    if (!items.length) { list.textContent = forVideo ? 'No encontré muletillas (Whisper suele "limpiarlas" al transcribir).' : 'Transcribe el video y pícale "Buscar muletillas".'; return; }
    for (const f of shown) {
      const row = el('label', 'fillerItem' + (f.level === 'siempre' ? ' safe' : ''));
      const cb = el('input'); cb.type = 'checkbox'; cb.checked = marked.has(f.id);
      cb.onchange = () => { if (cb.checked) marked.add(f.id); else marked.delete(f.id); render(); };
      const when = el('span', 'fillerWhen', tfmt(f.start));
      const what = el('b', null, f.term);
      const ctx = el('span', 'fillerCtx', f.context);
      const tag = el('span', 'fillerTag', f.level === 'siempre' ? 'segura' : 'revisar'); tag.title = f.reason || '';
      const play = el('button', 'tl-btn', '▶'); play.type = 'button'; play.title = 'Escuchar (1 s antes y después)';
      play.onclick = e => { e.preventDefault(); if (typeof playAt === 'function') playAt(Math.max(0, f.start - 1), (f.end - f.start) + 2).catch(err => say(err.message, true)); };
      row.append(cb, when, what, tag, ctx, play); list.append(row);
    }
  }
  findBtn.onclick = () => {
    const st = typeof state !== 'undefined' ? state : null;
    if (!st || !st.project) return say('Abre un video primero.', true);
    if (!st.transcript || !st.transcript.length) return say('Primero transcribe el video (Paso 2).', true);
    const dur = typeof tlDuration === 'function' ? tlDuration() : Infinity;
    items = F.findFillers(st.transcript, [...F.DEFAULT_FILLERS, ...loadCustom()], { duration: dur || Infinity });
    marked = new Set(items.filter(f => f.suggested).map(f => f.id)); forVideo = st.project.videoPath;
    render();
    say(items.length ? `🔎 Encontré ${items.length} posibles muletillas; ${marked.size} marcadas solas (las seguras). Revisa con ▶ y quita las que quieras.` : 'No encontré muletillas en la transcripción.');
  };
  safeBtn.onclick = () => { marked = new Set(items.filter(f => f.suggested).map(f => f.id)); render(); };
  noneBtn.onclick = () => { marked.clear(); render(); };
  applyBtn.onclick = () => {
    try {
      const cuts = F.fillerCuts(items, [...marked]);
      if (!cuts.length) throw Error('Marca al menos una muletilla.');
      ensureClips(); pushUndo('Muletillas');
      clips = F.removeFromClips(clips, cuts); saveClips(); syncRemoved(); buildTimeline();
      const n = cuts.length; marked.clear(); render();
      say(`✂️ Quité ${n} ${n === 1 ? 'muletilla' : 'muletillas'} de la línea del tiempo (Ctrl+Z para regresar).`);
    } catch (e) { say(e.message, true); }
  };
  // Al cambiar de video se limpia la lista.
  setInterval(() => { const st = typeof state !== 'undefined' ? state : null; const v = st && st.project ? st.project.videoPath : ''; if (forVideo && v !== forVideo) { items = []; marked.clear(); forVideo = ''; render(); } }, 1500);
  renderCustom(); render();
})();
