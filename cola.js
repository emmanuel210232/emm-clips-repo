'use strict';
// ===== COLA DE EXPORTS =====
// Varios exports (video largo y Shorts) que se hacen uno tras otro, sin estar al pendiente. La lógica (estados, orden,
// qué sigue) vive en lib/queue.js en el servidor; aquí solo se muestra y se mandan los botones.
// Cada export de la cola usa la MISMA función que el botón normal ("Exportar MP4" / "Crear Short"): misma calidad.
(function () {
  const $q = id => document.getElementById(id);
  const post = async (url, data) => { const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data || {}) }); const b = await r.json(); if (!r.ok) throw Error(b.error || 'Error inesperado'); return b; };
  const say = (m, bad) => { if (typeof notice === 'function') notice(m, bad); };
  const ICON = { waiting: '⏳', running: '⚙️', done: '✅', error: '⚠️', cancelled: '⛔' };
  let last = null, timer = null;

  function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function btn(text, title, fn, cls = 'secondary compact') { const b = el('button', cls, text); b.type = 'button'; if (title) b.title = title; b.onclick = async () => { b.disabled = true; try { render(await fn()); } catch (e) { say(e.message, true); } finally { b.disabled = false; } }; return b; }

  function render(st) {
    if (!st || !st.items) return;
    last = st;
    const body = $q('queueBody'), badge = $q('queueBadge');
    if (!body) return;
    const s = st.summary || {};
    if (badge) badge.textContent = st.items.length ? `${s.pending || 0} pendiente${s.pending === 1 ? '' : 's'} · ${s.done || 0} listo${s.done === 1 ? '' : 's'}` : 'vacía';
    body.replaceChildren();
    const bar = el('div', 'row wrap queueBar');
    if (s.waiting || s.running) {
      bar.append(s.active
        ? btn('⏸ Pausar la cola', 'Termina el export que está corriendo y ya no empieza el siguiente', () => post('/api/queue/pause'))
        : btn('▶ Empezar la cola', 'Exporta uno tras otro', () => post('/api/queue/start'), 'primary compact'));
    }
    if (s.done || s.error || s.cancelled) bar.append(btn('🧹 Quitar terminados', 'Quita de la lista los listos, con error y cancelados', () => post('/api/queue/clear')));
    const hint = el('span', 'muted', st.items.length ? (s.active ? 'La cola está corriendo: puedes seguir editando.' : (s.waiting ? 'La cola está en pausa.' : '')) : 'Agrega exports con “➕ Agregar a la cola” (en Exportar o en cada Short) y luego dale ▶.');
    bar.append(hint);
    body.append(bar);
    if (!st.items.length) return;
    const list = el('div', 'queueList');
    st.items.forEach((it, idx) => {
      const row = el('div', 'queueItem q-' + it.status);
      const main = el('div', 'queueMain');
      const title = el('div', 'queueTitle', `${ICON[it.status] || ''} ${it.label}`);
      const sub = el('div', 'muted queueSub');
      let txt = it.statusLabel || it.status;
      if (it.status === 'running' && st.job && st.job.status === 'running') txt += ` · ${st.job.percent || 0}% · ${st.job.message || ''}`;
      if (it.message) txt += ' · ' + it.message;
      if (it.otherVideo && it.status === 'waiting') txt += ' · es de otro video: se saltará hasta que lo abras';
      sub.textContent = txt;
      main.append(title, sub);
      const acts = el('div', 'queueActs');
      if (it.status === 'waiting') {
        if (idx > 0) acts.append(btn('▲', 'Subir', () => post('/api/queue/move', { id: it.id, dir: -1 })));
        if (idx < st.items.length - 1) acts.append(btn('▼', 'Bajar', () => post('/api/queue/move', { id: it.id, dir: 1 })));
      }
      if (it.status === 'waiting' || it.status === 'running') acts.append(btn(it.status === 'running' ? 'Cancelar' : 'Cancelar', it.status === 'running' ? 'Detiene este export' : 'No exportar este', () => { if (it.status === 'running' && !confirm('¿Cancelar el export que está corriendo?')) throw Error('Sigue exportando.'); return post('/api/queue/cancel', { id: it.id }); }));
      if (it.status === 'error' || it.status === 'cancelled') acts.append(btn('↻ Reintentar', 'Volver a ponerlo en espera', () => post('/api/queue/retry', { id: it.id })));
      if (it.status !== 'running') acts.append(btn('🗑️', 'Quitar de la cola', () => post('/api/queue/remove', { id: it.id })));
      row.append(main, acts);
      list.append(row);
    });
    body.append(list);
  }

  async function refresh() { try { const r = await fetch('/api/queue'); if (r.ok) render(await r.json()); } catch {} }
  function schedule() {
    clearTimeout(timer);
    const busy = last && last.summary && (last.summary.running || (last.summary.active && last.summary.waiting));
    timer = setTimeout(async () => { await refresh(); schedule(); }, busy ? 1500 : 6000);
  }

  // Agregar el video largo con las MISMAS opciones que tiene ahorita el panel de Exportar.
  async function addVideo() {
    if (typeof window.emmExportBody !== 'function') throw Error('Recarga la página para usar la cola.');
    const { body, edited, mode, segments } = await window.emmExportBody();
    const label = edited ? `Video editado (${segments.length} clip${segments.length > 1 ? 's' : ''})` : (mode === 'mute' ? 'Video con groserías silenciadas' : 'Video con cortes');
    const q = $q('exportQuality'); const ql = q && q.selectedOptions && q.selectedOptions[0] ? ' · ' + q.selectedOptions[0].textContent.trim() : '';
    const r = await post('/api/queue/add', { kind: 'video', label: label + ql, params: body });
    render(r); schedule();
    say('➕ Agregado a la cola. Dale “▶ Empezar la cola” cuando quieras (abajo de Exportar).');
  }
  // Para los Shorts (lo llama app.js en cada Short).
  window.emmQueueShort = async (s) => {
    if (typeof visionBeforeRender === 'function') await visionBeforeRender(s); // mismo análisis de cámara que "Crear Short"
    const r = await post('/api/queue/add', { kind: 'short', id: s.id });
    render(r); schedule();
    say(`➕ Short ${s.rank || ''} agregado a la cola.`);
  };
  window.emmQueueRefresh = () => { refresh(); schedule(); };

  const add = $q('exportQueueAdd');
  if (add) add.onclick = async () => { add.disabled = true; try { await addVideo(); } catch (e) { say(e.message, true); } finally { add.disabled = false; } };
  refresh().then(schedule);
})();
