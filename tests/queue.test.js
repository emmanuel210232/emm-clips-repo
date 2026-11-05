'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Q = require('../lib/queue');

const V = 'C:/directo.mpg';
const add = (q, kind = 'video', label = '') => Q.addItem(q, { kind, label, params: { mode: 'mute', quality: 'original' }, videoPath: V });

test('agrega, guarda copia de las opciones y arranca en orden solo si está activa', () => {
  const q = Q.emptyQueue();
  const params = { mode: 'cut', segments: [{ start: 1, end: 2 }] };
  const a = Q.addItem(q, { kind: 'video', label: 'Largo', params, videoPath: V });
  params.mode = 'mute'; // cambiar después NO afecta lo guardado
  assert.equal(a.params.mode, 'cut');
  const b = add(q, 'short', 'Short 1');
  assert.deepEqual([a.id, b.id], ['q1', 'q2']);
  assert.equal(Q.decide(q, { jobBusy: false, currentVideo: V }).action, 'idle', 'sin "Empezar cola" no arranca');
  q.active = true;
  assert.equal(Q.decide(q, { jobBusy: true, currentVideo: V }).action, 'wait', 'espera si hay otro trabajo');
  const d = Q.decide(q, { jobBusy: false, currentVideo: V });
  assert.equal(d.action, 'start'); assert.equal(d.item.id, 'q1');
  Q.markRunning(q, 'q1');
  assert.equal(Q.decide(q, { jobBusy: false, currentVideo: V }).action, 'wait');
  Q.markFinished(q, 'q1', { status: 'done', output: 'a.mp4' });
  assert.equal(Q.decide(q, { jobBusy: false, currentVideo: V }).item.id, 'q2');
  Q.markRunning(q, 'q2'); Q.markFinished(q, 'q2', { status: 'error', message: 'x' });
  assert.equal(Q.decide(q, { jobBusy: false, currentVideo: V }).action, 'idle');
  assert.equal(q.active, false, 'al vaciarse se apaga');
  assert.deepEqual(Q.summary(q), { waiting: 0, running: 0, done: 1, error: 1, cancelled: 0, total: 2, active: false, pending: 0 });
});

test('cancelar, quitar, reintentar y mover', () => {
  const q = Q.emptyQueue();
  add(q); add(q); add(q);
  assert.equal(Q.cancelItem(q, 'q2').action, 'cancelled');
  Q.markRunning(q, 'q1');
  assert.equal(Q.cancelItem(q, 'q1').action, 'stop', 'el que corre se detiene en el servidor');
  assert.throws(() => Q.removeItem(q, 'q1'), /cancela/);
  assert.equal(Q.removeItem(q, 'q2'), true);
  Q.markFinished(q, 'q1', { status: 'cancelled' });
  Q.retryItem(q, 'q1');
  assert.deepEqual(q.items.map(i => [i.id, i.status]), [['q3', 'waiting'], ['q1', 'waiting']]);
  assert.equal(Q.moveItem(q, 'q1', -1), true);
  assert.deepEqual(q.items.map(i => i.id), ['q1', 'q3']);
  assert.equal(Q.clearFinished(q), 0);
});

test('al reabrir la app: lo que estaba exportando queda como error y la cola en pausa', () => {
  const q = Q.emptyQueue(); add(q); add(q); q.active = true; Q.markRunning(q, 'q1');
  const r = Q.recoverQueue(JSON.parse(JSON.stringify(q)));
  assert.equal(r.items[0].status, 'error'); assert.match(r.items[0].message, /interrumpió/);
  assert.equal(r.items[1].status, 'waiting'); assert.equal(r.active, false);
  assert.equal(add(r).id, 'q3', 'sigue la numeración');
  assert.deepEqual(Q.recoverQueue('basura').items, []);
  assert.deepEqual(Q.normalizeQueue({ items: [{ id: 'q1', kind: 'raro' }, null] }).items, []);
});

test('un export de otro video se salta con aviso', () => {
  const q = Q.emptyQueue(); add(q); q.active = true;
  const d = Q.decide(q, { jobBusy: false, currentVideo: 'C:/otro.mpg' });
  assert.equal(d.action, 'skip'); assert.match(d.reason, /otro video/);
});

test('límites y validación', () => {
  const q = Q.emptyQueue();
  assert.throws(() => Q.addItem(q, { kind: 'zip', videoPath: V }), /no válido/);
  assert.throws(() => Q.addItem(q, { kind: 'video' }), /Abre un video/);
  for (let i = 0; i < Q.MAX_ITEMS; i++) add(q);
  assert.throws(() => add(q), /pendientes/);
});
