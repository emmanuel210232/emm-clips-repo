const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../lib/timeline-core');

const clips3 = () => [{ start: 0, end: 10 }, { start: 12, end: 20, zoom: true }, { start: 25, end: 30 }];

test('partes quitadas = huecos que ningún clip cubre', () => {
  assert.deepEqual(T.removedRanges(clips3(), 40), [{ start: 10, end: 12 }, { start: 20, end: 25 }, { start: 30, end: 40 }]);
  assert.deepEqual(T.removedRanges([{ start: 0, end: 40 }], 40), []);
  assert.equal(T.totalOut(clips3()), 23);
});

test('índice: solo devuelve los clips visibles y encuentra el clip bajo el cursor', () => {
  const c = clips3(); const ix = T.buildIndex(c);
  assert.deepEqual(T.visibleClips(ix, c, 11, 13), [1]);
  assert.deepEqual(T.visibleClips(ix, c, 9, 26), [0, 1, 2]);
  assert.deepEqual(T.visibleClips(ix, c, 31, 39), []);
  assert.equal(T.clipAt(ix, c, 15), 1);
  assert.equal(T.clipAt(ix, c, 11), -1);
  assert.equal(T.clipAt(ix, c, 0), 0);
});

test('índice rápido con 5000 clips (directo de 6 h)', () => {
  const c = []; for (let i = 0; i < 5000; i++) c.push({ start: i * 4.3, end: i * 4.3 + 3.9 });
  const t0 = Date.now(); const ix = T.buildIndex(c);
  let n = 0; for (let k = 0; k < 2000; k++) n += T.visibleClips(ix, c, k * 10, k * 10 + 60).length;
  assert.ok(n > 0); assert.ok(Date.now() - t0 < 500, 'debe ser rápido');
  assert.equal(T.clipAt(ix, c, 4.3 * 4000 + 1), 4000);
});

test('índice con clips reordenados (fuera de orden de fuente)', () => {
  const c = [{ start: 25, end: 30 }, { start: 0, end: 10 }];
  const ix = T.buildIndex(c);
  assert.deepEqual(T.visibleClips(ix, c, 0, 40), [1, 0]);
  assert.equal(T.clipAt(ix, c, 26), 0);
  assert.equal(T.isSourceOrdered(c), false);
});

test('dividir en el cursor conserva el zoom y no divide en el borde', () => {
  const r = T.splitAt(clips3(), 15);
  assert.equal(r.idx, 2);
  assert.deepEqual(r.clips.slice(1, 3), [{ start: 12, end: 15, zoom: true }, { start: 15, end: 20, zoom: true }]);
  assert.equal(T.splitAt(clips3(), 12.05), null);
  assert.equal(T.splitAt(clips3(), 11), null);
});

test('borrar clips; nunca deja el video vacío', () => {
  assert.deepEqual(T.deleteClips(clips3(), [1]).map(c => c.start), [0, 25]);
  assert.equal(T.deleteClips(clips3(), [0, 1, 2]), null);
});

test('recortar respeta vecinos, mínimo e imán', () => {
  const c = clips3();
  // el inicio del clip 1 no puede pasar el final del clip 0
  assert.equal(T.trimClip(c, 1, 'L', 5, { dur: 40 }).value, 10);
  // el final no puede pasar el inicio del clip 2
  assert.equal(T.trimClip(c, 1, 'R', 28, { dur: 40 }).value, 25);
  // mínimo de duración
  assert.equal(T.trimClip(c, 1, 'R', 12, { dur: 40 }).value, 12 + T.MIN_CLIP);
  // imán al cursor (17.5) con tolerancia 0.3
  const r = T.trimClip(c, 1, 'R', 17.3, { dur: 40, snapPoints: [17.5], snapTol: 0.3 });
  assert.equal(r.value, 17.5); assert.equal(r.snapped, 17.5);
  // sin imán fuera de tolerancia
  assert.equal(T.trimClip(c, 1, 'R', 17.0, { dur: 40, snapPoints: [17.5], snapTol: 0.3 }).snapped, null);
  // no muta el original
  assert.equal(c[1].end, 20);
  // último clip no pasa la duración
  assert.equal(T.trimClip(c, 2, 'R', 99, { dur: 40 }).value, 40);
});

test('snapTime elige el punto más cercano', () => {
  assert.deepEqual(T.snapTime(4.9, [1, 5, 9], 0.2), { t: 5, snapped: true, point: 5 });
  assert.equal(T.snapTime(3, [1, 5, 9], 0.2).snapped, false);
  assert.deepEqual(T.edgePoints(clips3(), 1), [0, 10, 25, 30]);
});

test('quitar y restaurar un rango', () => {
  const cut = T.cutRange([{ start: 0, end: 30 }], 10, 12);
  assert.deepEqual(cut, [{ start: 0, end: 10 }, { start: 12, end: 30 }]);
  // restaurar une de nuevo en un solo clip
  assert.deepEqual(T.restoreRange(cut, 9, 13, 30), [{ start: 0, end: 30 }]);
  // restaurar solo una parte del hueco
  assert.deepEqual(T.restoreRange(cut, 10.5, 11, 30), [{ start: 0, end: 10 }, { start: 10.5, end: 11 }, { start: 12, end: 30 }]);
  assert.equal(T.restoreRange([{ start: 0, end: 30 }], 1, 2, 30), null);
  assert.equal(T.cutRange([{ start: 0, end: 30 }], 0, 30), null);
});

test('mapa tiempo de salida → fuente', () => {
  const c = clips3(); const acc = T.outMap(c);
  assert.equal(T.outToSource(c, acc, 0), 0);
  assert.equal(T.outToSource(c, acc, 12), 14);
  assert.equal(T.outToSource(c, acc, 19), 26);
});

test('vista de la edición: salta las partes quitadas y sigue el orden de los clips', () => {
  const c = clips3();
  assert.deepEqual(T.previewStep(c, 0, 5, 0.02), { idx: 0 });
  assert.deepEqual(T.previewStep(c, 0, 9.99, 0.02), { idx: 1, seek: 12 });
  assert.deepEqual(T.previewStep(c, 2, 30, 0.02), { idx: 2, end: true });
  // cursor dentro de una parte quitada → salta al siguiente clip
  assert.deepEqual(T.previewStep(c, -1, 21, 0.02), { idx: 2, seek: 25 });
  assert.deepEqual(T.previewStep(c, -1, 35, 0.02), { idx: -1, end: true });
  // clips reordenados: después del clip 0 (25-30) va el 1 (0-10)
  const r = [{ start: 25, end: 30 }, { start: 0, end: 10 }];
  assert.deepEqual(T.previewStep(r, 0, 29.99, 0.02), { idx: 1, seek: 0 });
});

test('rangos de groserías: margen, unión y búsqueda', () => {
  const m = T.mergeRanges([{ start: 5, end: 5.4 }, { start: 5.5, end: 6 }, { start: 1, end: 1.2 }], 0.15, 100);
  assert.equal(m.length, 2);
  assert.ok(Math.abs(m[0].start - 0.85) < 1e-9);
  assert.ok(Math.abs(m[1].end - 6.15) < 1e-9);
  assert.equal(T.inRanges(m, 5.45), true);
  assert.equal(T.inRanges(m, 3), false);
  assert.equal(T.inRanges(m, 6.2), false);
});

test('historial: deshacer/rehacer, duplicados y límite', () => {
  const h = T.createHistory({ limit: 3 });
  const s = (n) => ({ clips: [{ start: 0, end: n }], selectedIds: ['a'], selectedPauseIds: [] });
  assert.equal(h.record(s(1)), true);
  assert.equal(h.record(s(1)), false, 'no guarda duplicados seguidos');
  h.record(s(2));
  const u = h.undo(s(3)); assert.equal(u.clips[0].end, 2);
  const u2 = h.undo(u); assert.equal(u2.clips[0].end, 1);
  assert.equal(h.undo(u2), null);
  const r = h.redo(u2); assert.equal(r.clips[0].end, 2);
  const r2 = h.redo(r); assert.equal(r2.clips[0].end, 3);
  assert.equal(h.canRedo(), false);
  // una edición nueva borra el "rehacer"
  h.undo(r2); assert.equal(h.canRedo(), true); h.record(s(9)); assert.equal(h.canRedo(), false);
  // límite
  for (let i = 10; i < 20; i++) h.record(s(i));
  assert.equal(h.size().undo, 3);
  // persistir y recargar
  const h2 = T.createHistory({ limit: 3 }); assert.ok(h2.load(JSON.parse(JSON.stringify(h.toJSON()))));
  assert.equal(h2.undo(s(50)).clips[0].end, 19);
});

test('historial conserva banderas zoom/transición/unión', () => {
  const c = [{ start: 0, end: 1, zoom: true }, { start: 2, end: 3, trans: true, join: true }];
  assert.deepEqual(T.decodeClips(T.encodeClips(c)), c);
});

test('zoom con ancla y límites de la vista', () => {
  const v = T.fitView(3600, 1000);
  assert.ok(Math.abs(v.pps - 1000 / 3600) < 1e-12);
  const z = T.zoomAt(v, 10, 500, 3600, 1000);
  // el tiempo bajo el cursor (1800 s) se queda en x=500
  assert.ok(Math.abs(z.start + 500 / z.pps - 1800) < 1e-6);
  // no se puede alejar más que "todo el video"
  assert.deepEqual(T.zoomAt(v, 0.1, 500, 3600, 1000), T.fitView(3600, 1000));
  // máximo acercamiento
  assert.equal(T.zoomAt(v, 1e9, 0, 3600, 1000).pps, T.MAX_PX_PER_SEC);
  assert.equal(T.tickStep(1000 / 21600), 3600); // 6 h en 1000 px → una marca por hora
  assert.equal(T.tickStep(100), 1);
});

test('formato de tiempo', () => {
  assert.equal(T.fmtTC(3725.5), '1:02:05');
  assert.equal(T.fmtTC(65.257, true), '1:05.25');
});

test('picos de la onda de audio y niveles', () => {
  const pcm = new Int16Array([0, 100, -32768, 5, 0, 0, 16384, 0]);
  const p = T.peaksFromPcm(pcm, 4);
  assert.equal(p.length, 2); assert.equal(p[0], 255); assert.ok(p[1] > 150 && p[1] < 200);
  const big = new Uint8Array(10000); big[9999] = 200;
  const lv = T.peakLevels(big);
  assert.ok(lv.length > 2); assert.equal(lv[lv.length - 1][lv[lv.length - 1].length - 1], 200);
});

test('atajos de teclado', () => {
  const k = (key, o = {}) => T.keyAction({ key, ...o });
  assert.equal(k(' '), 'playPause');
  assert.equal(k('z', { ctrlKey: true }), 'undo');
  assert.equal(k('Z', { ctrlKey: true, shiftKey: true }), 'redo');
  assert.equal(k('y', { ctrlKey: true }), 'redo');
  assert.equal(k('ArrowLeft'), 'backFrame');
  assert.equal(k('ArrowRight', { shiftKey: true }), 'fwd1s');
  assert.equal(k('S'), 'split');
  assert.equal(k('Delete'), 'delete');
  assert.equal(k('+'), 'zoomIn');
  assert.equal(k('-'), 'zoomOut');
  assert.equal(k('?', { shiftKey: true }), 'help');
  assert.equal(k('c', { ctrlKey: true }), null);
  assert.equal(T.shuttle(0, 'shuttleFwd'), 1);
  assert.equal(T.shuttle(1, 'shuttleFwd'), 2);
  assert.equal(T.shuttle(8, 'shuttleFwd'), 8);
  assert.equal(T.shuttle(2, 'shuttleBack'), -1);
  assert.equal(T.shuttle(-1, 'shuttleBack'), -2);
  assert.equal(T.shuttle(4, 'shuttleStop'), 0);
});

// ---------- Vista de la edición: mismo plan que el export ----------
test('plan de la vista: con clips editados reproduce los clips en orden y silencia las groserías marcadas', () => {
  const matches = [{ id: 'a', start: 10, end: 10.5 }, { id: 'b', start: 30, end: 30.4 }];
  const p = T.editPlan({ edited: true, clips: [{ start: 20, end: 40 }, { start: 0, end: 15 }], dur: 60, matches, selectedIds: ['b'] });
  assert.deepEqual(p.clips.map(c => [c.start, c.end]), [[20, 40], [0, 15]]);
  assert.equal(p.mode, 'edit');
  assert.equal(p.mute.length, 1);
  assert.ok(Math.abs(p.mute[0].start - 29.79) < 1e-9 && Math.abs(p.mute[0].end - 30.61) < 1e-9);
  // "censurar todas" silencia también las no marcadas
  const all = T.editPlan({ edited: true, clips: [{ start: 0, end: 60 }], dur: 60, matches, selectedIds: [], censorAll: true });
  assert.equal(all.mute.length, 2);
});

test('plan de la vista: modo Silenciar = video completo + silencio en marcadas, cortes manuales y ajustes', () => {
  const p = T.editPlan({ mode: 'mute', dur: 100, matches: [{ id: 'a', start: 10, end: 11 }], selectedIds: ['a'], adjustments: { a: { start: 9.5, end: 11.2 } }, manualCuts: [{ start: 50, end: 52 }] });
  assert.deepEqual(p.clips, [{ start: 0, end: 100 }]);
  assert.equal(p.mute.length, 2);
  assert.ok(Math.abs(p.mute[0].start - 9.35) < 1e-9 && Math.abs(p.mute[0].end - 11.35) < 1e-9, 'usa el ajuste manual + margen');
  assert.ok(T.inRanges(p.mute, 51) && !T.inRanges(p.mute, 30));
});

test('plan de la vista: modo Cortar quita marcadas, pausas marcadas y cortes manuales', () => {
  const p = T.editPlan({ mode: 'cut', dur: 100, matches: [{ id: 'a', start: 10, end: 11 }], selectedIds: ['a'], pauses: [{ id: 'p1', start: 40, end: 45 }, { id: 'p2', start: 70, end: 72 }], selectedPauseIds: ['p1'], manualCuts: [{ start: 80, end: 90 }] });
  assert.deepEqual(p.clips.map(c => [+c.start.toFixed(2), +c.end.toFixed(2)]), [[0, 9.94], [11.06, 40], [45, 80], [90, 100]]);
  assert.equal(p.skipped, 3);
  assert.deepEqual(p.mute, []);
  // la vista recorre el plan saltando los cortes
  assert.deepEqual(T.previewStep(p.clips, 0, 9.95, 0.03), { idx: 1, seek: p.clips[1].start });
});

test('describe el cambio para el mensaje de deshacer', () => {
  const a = [{ start: 0, end: 10 }, { start: 20, end: 30 }];
  assert.equal(T.describeChange(a, [{ start: 0, end: 5 }, { start: 5, end: 10 }, { start: 20, end: 30 }]), 'dividir clip');
  assert.equal(T.describeChange(a, [{ start: 20, end: 30 }]), 'borrar clip');
  assert.equal(T.describeChange(a, [{ start: 20, end: 30 }, { start: 0, end: 10 }]), 'mover clip');
  assert.equal(T.describeChange(a, [{ start: 0, end: 8 }, { start: 20, end: 30 }]), 'recortar clip');
  assert.equal(T.describeChange(a, [{ start: 0, end: 10, zoom: true }, { start: 20, end: 30 }]), 'poner zoom');
  assert.equal(T.describeChange(a, [{ start: 0, end: 100 }]), 'volver al video completo');
  assert.equal(T.describeChange([{ start: 0, end: 5 }, { start: 5, end: 10 }], [{ start: 0, end: 10 }]), 'unir clips');
  assert.equal(T.describeChange([{ start: 0, end: 100 }], Array.from({ length: 40 }, (_, i) => ({ start: i * 2, end: i * 2 + 1 }))), 'quitar 39 partes');
});

test('historial guardado: cabe en el límite, se recupera tras "recargar" y no pierde el último paso', () => {
  const h = T.createHistory({ limit: 50 });
  const big = n => Array.from({ length: n }, (_, i) => ({ start: i, end: i + 0.5 }));
  for (let i = 0; i < 50; i++) h.record({ clips: big(200 + i), label: 'paso ' + i });
  const raw = JSON.stringify(h.toJSON());
  const fit = T.fitHistory(h.toJSON(), Math.floor(raw.length / 4));
  assert.ok(JSON.stringify(fit).length <= raw.length / 4);
  assert.equal(fit.past[fit.past.length - 1].l, 'paso 49', 'conserva lo más reciente');
  const h2 = T.createHistory({ limit: 50 });
  assert.ok(h2.load(JSON.parse(JSON.stringify(fit))));
  assert.equal(h2.peekUndoLabel(), 'paso 49');
  const back = h2.undo({ clips: big(3), label: h2.peekUndoLabel() });
  assert.equal(back.clips.length, 249);
  assert.equal(h2.peekRedoLabel(), 'paso 49');
  // un límite imposible deja al menos el último paso
  const tiny = T.fitHistory(h.toJSON(), 10);
  assert.equal(tiny.past.length, 1); assert.equal(tiny.future.length, 0);
});

test('zoom de la línea del tiempo: máximo según duración y ancla del cursor', () => {
  assert.equal(T.maxTlZoom(0, 1000), 1);
  assert.equal(T.maxTlZoom(60, 1000), 60 * 240 / 1000);
  assert.equal(T.maxTlZoom(6 * 3600, 1000), 4e6 / 1000, 'un directo de 6 h no pasa de 4 millones de px');
  assert.equal(T.maxTlZoom(2, 1000), 1);
  // el punto bajo el cursor (x=300 de la vista) se queda en su lugar
  assert.equal(T.anchoredScroll(500, 300, 2000, 8000), 0.4 * 8000 - 300);
  assert.equal(T.anchoredScroll(0, 0, 0, 100), 0);
});

test('fitHistory: con miles de clips es lineal y el resultado cabe en el límite', () => {
  const big = Array.from({ length: 5000 }, (_, i) => ({ start: i * 2, end: i * 2 + 1.5 }));
  const h = T.createHistory({ limit: 50 });
  for (let i = 0; i < 50; i++) h.record({ clips: big.slice(i), label: 'paso ' + i });
  const t0 = Date.now();
  const fit = T.fitHistory(h.toJSON(), 1500000);
  assert.ok(Date.now() - t0 < 1500, 'no debe tardar segundos');
  assert.ok(JSON.stringify(fit).length <= 1500000, 'cabe en el límite');
  assert.equal(fit.past[fit.past.length - 1].l, 'paso 49', 'conserva el paso más reciente');
});
