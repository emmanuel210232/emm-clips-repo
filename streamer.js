'use strict';
// ===== STREAMER DE ESTE VIDEO (la app se usa con varios canales) =====
// Nombre del streamer, @ para la marca (Shorts y tarjeta de intro/outro) y nombres que salen (ayudan a Whisper a
// escribirlos bien). Se guarda por video y la app recuerda el último usado para el siguiente video del mismo canal.
// Usa del app.js: state, refresh, notice.
(function () {
  const host = document.getElementById('streamerBox');
  if (!host) return;
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const field = (label, ph, max) => { const l = el('label', 'stField'); const t = el('span', null, label); const i = el('input'); i.type = 'text'; i.placeholder = ph; i.maxLength = max; l.append(t, i); return { l, i }; };
  const name = field('Streamer', 'p. ej. Maestro Shifu', 60);
  const names = field('Nombres que salen (opcional)', 'p. ej. Adriano, Emiliano, Tico', 300);
  const save = el('button', 'secondary compact', 'Guardar'); save.type = 'button';
  const info = el('span', 'muted', '');
  const row = el('div', 'row wrap'); row.append(save, info);
  host.append(el('p', 'hint', 'De quién es este directo. El nombre y los nombres que salen ayudan a que la transcripción y los títulos de los Shorts los escriban bien. Se recuerda para el siguiente video.'), name.l, names.l, row);
  let loadedFor = '';
  const fill = () => {
    const st = typeof state !== 'undefined' ? state : null; const p = st && st.project;
    const key = p ? p.videoPath + '|' + (p.openedAt || '') : '';
    if (key === loadedFor) return; loadedFor = key;
    const s = (p && p.streamer) || {};
    name.i.value = s.name || ''; names.i.value = s.names || '';
    save.disabled = !p; info.textContent = p ? '' : 'Abre un video primero.';
  };
  save.onclick = async () => {
    try {
      const r = await fetch('/api/project/streamer', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: name.i.value, names: names.i.value }) });
      const b = await r.json(); if (!r.ok) throw Error(b.error || 'No se pudo guardar.');
      if (typeof state !== 'undefined' && state && b.project) state.project = b.project;
      info.textContent = '✅ Guardado';
      setTimeout(() => { if (info.textContent === '✅ Guardado') info.textContent = ''; }, 3000);
    } catch (e) { if (typeof notice === 'function') notice(e.message, true); }
  };
  setInterval(fill, 800); fill();

  // ---- Marca (@) en los Shorts: se elige aquí, en la sección de Shorts; vacío = sin marca ----
  const bhost = document.getElementById('shortsBrandBox');
  if (bhost) {
    const lbl = el('label', null, '🏷️ Marca en los Shorts ');
    const inp = el('input'); inp.type = 'text'; inp.maxLength = 60; inp.placeholder = 'Sin marca · escribe o elige un @'; inp.setAttribute('list', 'brandHandles');
    const dl = el('datalist'); dl.id = 'brandHandles';
    const ok = el('button', 'secondary compact', 'Usar'); ok.type = 'button';
    const none = el('button', 'secondary compact', 'Sin marca'); none.type = 'button';
    const bi = el('span', 'muted', '');
    lbl.append(inp); bhost.append(lbl, dl, ok, none, bi);
    let bFor = '';
    const fillB = () => {
      const st = typeof state !== 'undefined' ? state : null; const p = st && st.project;
      const key = p ? p.videoPath + '|' + (p.openedAt || '') : '';
      dl.replaceChildren(...(((st && st.brandHandles) || []).map(h => { const o = el('option'); o.value = h; return o; })));
      if (key === bFor) return; bFor = key;
      inp.value = (p && p.streamer && p.streamer.handle) || '';
      bi.textContent = p ? (inp.value ? 'Sale abajo en cada Short.' : 'Los Shorts salen sin marca.') : '';
    };
    const setH = async v => {
      try {
        const r = await fetch('/api/project/streamer', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle: v }) });
        const b = await r.json(); if (!r.ok) throw Error(b.error || 'No se pudo guardar.');
        if (typeof state !== 'undefined' && state) { if (b.project) state.project = b.project; if (b.brandHandles) state.brandHandles = b.brandHandles; }
        inp.value = v; bi.textContent = v ? '✅ ' + v + ' sale abajo en cada Short.' : '✅ Los Shorts salen sin marca.';
      } catch (e) { if (typeof notice === 'function') notice(e.message, true); }
    };
    ok.onclick = () => setH(inp.value.trim());
    none.onclick = () => setH('');
    inp.onkeydown = e => { if (e.key === 'Enter') setH(inp.value.trim()); };
    setInterval(fillB, 800); fillB();
  }
})();
