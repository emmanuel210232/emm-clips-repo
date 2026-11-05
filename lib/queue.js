'use strict';
// COLA DE EXPORTS (lógica pura, sin ffmpeg ni archivos): varios exports (video largo, Shorts) que se hacen uno tras otro.
// Cada elemento guarda las opciones TAL COMO ESTABAN al agregarlo; el servidor solo llama a las funciones de export de
// siempre con esas opciones (no cambia calidad ni método de corte/sincronía).
// Estados: 'waiting' (en espera) → 'running' (exportando) → 'done' (listo) | 'error' | 'cancelled' (cancelado).
// La cola se guarda en data/export_queue.json; al abrir la app NO arranca sola (active=false) y lo que quedó a medias
// se marca como error "se interrumpió".

const STATUS_LABEL = { waiting: 'En espera', running: 'Exportando', done: 'Listo', error: 'Error', cancelled: 'Cancelado' };
const MAX_ITEMS = 60;
const KINDS = new Set(['video', 'short']);

function emptyQueue() { return { items: [], active: false, seq: 0 }; }

// Normaliza lo que venga del disco (archivo viejo, dañado o a medio escribir).
function normalizeQueue(raw) {
  const q = emptyQueue();
  if (!raw || typeof raw !== 'object') return q;
  q.active = !!raw.active;
  q.seq = Number.isFinite(+raw.seq) ? Math.max(0, Math.floor(+raw.seq)) : 0;
  for (const it of Array.isArray(raw.items) ? raw.items : []) {
    if (!it || typeof it !== 'object' || !KINDS.has(it.kind) || !it.id) continue;
    q.items.push({
      id: String(it.id), kind: it.kind, label: String(it.label || ''), videoPath: String(it.videoPath || ''),
      params: it.params && typeof it.params === 'object' ? it.params : {},
      status: STATUS_LABEL[it.status] ? it.status : 'waiting', message: String(it.message || ''),
      output: it.output ? String(it.output) : '', addedAt: String(it.addedAt || ''), startedAt: String(it.startedAt || ''), finishedAt: String(it.finishedAt || ''),
    });
    const n = parseInt(String(it.id).replace(/^q/, ''), 10);
    if (Number.isFinite(n) && n > q.seq) q.seq = n;
  }
  return q;
}

// Al arrancar la app: nada está corriendo de verdad → lo que decía "exportando" se interrumpió; la cola queda en pausa.
function recoverQueue(raw, now = new Date()) {
  const q = normalizeQueue(raw);
  for (const it of q.items) if (it.status === 'running') Object.assign(it, { status: 'error', message: 'Se interrumpió porque la app se cerró. Puedes volver a intentarlo.', finishedAt: now.toISOString() });
  q.active = false;
  return q;
}

function addItem(q, { kind, label, params, videoPath }, now = new Date()) {
  if (!KINDS.has(kind)) throw Error('Tipo de export no válido.');
  if (!videoPath) throw Error('Abre un video primero.');
  if (q.items.filter(i => i.status === 'waiting' || i.status === 'running').length >= MAX_ITEMS) throw Error(`La cola ya tiene ${MAX_ITEMS} exports pendientes.`);
  // Si se pasa del límite total, se quitan los terminados más viejos.
  while (q.items.length >= MAX_ITEMS) { const i = q.items.findIndex(x => x.status !== 'waiting' && x.status !== 'running'); if (i < 0) break; q.items.splice(i, 1); }
  const item = { id: 'q' + (++q.seq), kind, label: String(label || (kind === 'short' ? 'Short' : 'Video')).slice(0, 120), videoPath: String(videoPath), params: JSON.parse(JSON.stringify(params || {})), status: 'waiting', message: '', output: '', addedAt: now.toISOString(), startedAt: '', finishedAt: '' };
  q.items.push(item);
  return item;
}

const find = (q, id) => q.items.find(i => i.id === String(id));
function nextWaiting(q) { return q.items.find(i => i.status === 'waiting') || null; }
function running(q) { return q.items.find(i => i.status === 'running') || null; }

function markRunning(q, id, now = new Date()) {
  const it = find(q, id); if (!it) throw Error('No encuentro ese export en la cola.');
  if (running(q) && running(q) !== it) throw Error('Ya hay un export de la cola en curso.');
  Object.assign(it, { status: 'running', message: 'Exportando…', startedAt: now.toISOString(), finishedAt: '' });
  return it;
}
function markFinished(q, id, { status, message = '', output = '' }, now = new Date()) {
  const it = find(q, id); if (!it) return null;
  if (!['done', 'error', 'cancelled'].includes(status)) throw Error('Estado final no válido: ' + status);
  Object.assign(it, { status, message: String(message || ''), output: output ? String(output) : it.output, finishedAt: now.toISOString() });
  if (status === 'cancelled' && !q.items.some(i => i.status === 'waiting')) q.active = false;
  return it;
}

// Cancelar: si está en espera se cancela ya; si se está exportando, el servidor debe detener ffmpeg (devuelve 'stop').
function cancelItem(q, id, now = new Date()) {
  const it = find(q, id); if (!it) throw Error('No encuentro ese export en la cola.');
  if (it.status === 'waiting') { Object.assign(it, { status: 'cancelled', message: 'Cancelado antes de empezar.', finishedAt: now.toISOString() }); return { item: it, action: 'cancelled' }; }
  if (it.status === 'running') return { item: it, action: 'stop' };
  return { item: it, action: 'none' };
}
// Quitar de la lista: cualquiera menos el que se está exportando (ese primero se cancela).
function removeItem(q, id) {
  const i = q.items.findIndex(x => x.id === String(id)); if (i < 0) return false;
  if (q.items[i].status === 'running') throw Error('Primero cancela el export que está en curso.');
  q.items.splice(i, 1); return true;
}
function clearFinished(q) { const before = q.items.length; q.items = q.items.filter(i => i.status === 'waiting' || i.status === 'running'); return before - q.items.length; }
// Volver a intentar uno con error o cancelado (al final de la fila, con las mismas opciones).
function retryItem(q, id) {
  const it = find(q, id); if (!it) throw Error('No encuentro ese export en la cola.');
  if (it.status !== 'error' && it.status !== 'cancelled') throw Error('Solo se puede reintentar uno con error o cancelado.');
  q.items.splice(q.items.indexOf(it), 1); q.items.push(it);
  Object.assign(it, { status: 'waiting', message: '', startedAt: '', finishedAt: '' });
  return it;
}
// Mover un elemento en espera hacia arriba (-1) o abajo (+1) entre los que esperan.
function moveItem(q, id, dir) {
  const i = q.items.findIndex(x => x.id === String(id)); if (i < 0 || q.items[i].status !== 'waiting') return false;
  let j = i + (dir < 0 ? -1 : 1);
  while (j >= 0 && j < q.items.length && q.items[j].status !== 'waiting') j += dir < 0 ? -1 : 1;
  if (j < 0 || j >= q.items.length) return false;
  [q.items[i], q.items[j]] = [q.items[j], q.items[i]];
  return true;
}

function summary(q) {
  const c = { waiting: 0, running: 0, done: 0, error: 0, cancelled: 0 };
  for (const i of q.items) c[i.status]++;
  return { ...c, total: q.items.length, active: !!q.active, pending: c.waiting + c.running };
}

// ¿Qué hacer en este momento? (el servidor lo llama cada segundo). jobBusy = hay otro trabajo de la app corriendo.
// Devuelve {action:'start', item} | {action:'wait'} | {action:'idle'}.
function decide(q, { jobBusy, currentVideo }) {
  if (running(q)) return { action: 'wait' };
  if (!q.active) return { action: 'idle' };
  const next = nextWaiting(q);
  if (!next) { q.active = false; return { action: 'idle' }; }
  if (jobBusy) return { action: 'wait' };
  if (next.videoPath && currentVideo && next.videoPath !== currentVideo) return { action: 'skip', item: next, reason: 'Este export era de otro video. Abre ese video y vuelve a intentarlo.' };
  return { action: 'start', item: next };
}

module.exports = { STATUS_LABEL, MAX_ITEMS, emptyQueue, normalizeQueue, recoverQueue, addItem, nextWaiting, running, markRunning, markFinished, cancelItem, removeItem, clearFinished, retryItem, moveItem, summary, decide };
