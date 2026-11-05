'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../lib/pace');

const sil = [{ start: 0, end: 1 }, { start: 5, end: 5.3 }, { start: 10, end: 11 }, { start: 20, end: 22.5 }];

test('lee silencedetect, incluido un silencio que llega al final', () => {
  const log = '[silencedetect] silence_start: 0\n[silencedetect] silence_end: 1.2 | silence_duration: 1.2\nx silence_start: 8.5\n';
  assert.deepEqual(P.parseSilenceLog(log, 10), [{ start: 0, end: 1.2 }, { start: 8.5, end: 10 }]);
});

test('ritmo: solo quita pausas de la duración mínima o más, con márgenes antes/después', () => {
  const p = P.plan({ silences: sil, duration: 30, minPause: 0.6, padBefore: 0.08, padAfter: 0.15 });
  // 0–1 (inicio: sin margen hacia afuera), 10–11 y 20–22.5; la de 0.3 s se queda
  assert.deepEqual(p.cuts, [{ start: 0, end: 0.92 }, { start: 10.15, end: 10.92 }, { start: 20.15, end: 22.42 }]);
  assert.deepEqual(p.keep, [{ start: 0.92, end: 10.15 }, { start: 10.92, end: 20.15 }, { start: 22.42, end: 30 }]);
  assert.equal(+(p.kept + p.removed).toFixed(3), 30);
  // pausa de 0.3 s: con márgenes 80+150 ms solo quedarían 0.07 s → no vale la pena cortarla; sin márgenes sí
  assert.equal(P.plan({ silences: sil, duration: 30, minPause: 0.25 }).cuts.length, 3);
  assert.equal(P.plan({ silences: sil, duration: 30, minPause: 0.25, padBefore: 0, padAfter: 0 }).cuts.length, 4);
});

test('"Dejar todas las pausas" no corta nada', () => {
  const p = P.plan({ silences: sil, duration: 30, minPause: Infinity });
  assert.deepEqual(p.keep, [{ start: 0, end: 30 }]); assert.equal(p.cuts.length, 0);
  assert.match(P.summary(p), /No se quita ninguna pausa/);
});

test('nunca deja pedazos de voz de menos de 0.15 s (prefiere no cortar)', () => {
  const p = P.plan({ silences: [{ start: 2, end: 3 }, { start: 3.3, end: 4.5 }], duration: 10, minPause: 0.5 });
  assert.ok(p.keep.every(k => k.end - k.start >= 0.15));
  const p2 = P.plan({ silences: [{ start: 2, end: 3 }, { start: 3.1, end: 4.5 }], duration: 10, minPause: 0.5, padBefore: 0, padAfter: 0 });
  assert.ok(p2.keep.every(k => k.end - k.start >= 0.15));
  assert.equal(p2.cuts.length, 1, 'se omite el segundo corte para no dejar 0.1 s sueltos');
});

test('no se come palabras con tiempos confiables', () => {
  const words = P.reliableWords([{ start: 9.6, end: 10.3, text: 'hola' }, { start: 10.8, end: 11.2, text: 'chat' }, { start: 0, end: 30, text: 'segmento largo con muchas palabras' }]);
  assert.equal(words.length, 2);
  const p = P.plan({ silences: [{ start: 10, end: 11 }], duration: 30, minPause: 0.6, padBefore: 0.08, padAfter: 0.15, words });
  // el corte quedaría 10.15–10.92, pero "hola" termina en 10.3 y "chat" empieza en 10.8
  assert.deepEqual(p.cuts, [{ start: 10.3, end: 10.8 }]);
});

test('resumen en español y etiquetas', () => {
  const p = P.plan({ silences: [{ start: 100, end: 160 }], duration: 4 * 3600 + 12 * 60, minPause: 0.6, padBefore: 0, padAfter: 0 });
  assert.equal(P.summary(p), 'El video pasa de 4:12:00 a 4:11:00 · 1 corte (−1:00)');
  assert.equal(P.rhythmLabel(Infinity), 'Dejar todas las pausas');
  assert.equal(P.rhythmLabel(0.6), 'Quitar pausas de 0.6 s o más');
  assert.equal(P.RHYTHM_STEPS[P.RHYTHM_STEPS.length - 1], Infinity);
});

test('rápido con un directo de 6 h (20 000 silencios y 60 000 palabras)', () => {
  const s = [], w = [];
  for (let i = 0; i < 20000; i++) s.push({ start: i * 1.08, end: i * 1.08 + 0.3 + (i % 5) * 0.1 });
  for (let i = 0; i < 60000; i++) w.push({ start: i * 0.36, end: i * 0.36 + 0.2 });
  const t0 = Date.now();
  const p = P.plan({ silences: s, duration: 21600, minPause: 0.4, words: w });
  assert.ok(Date.now() - t0 < 500, 'menos de medio segundo');
  assert.ok(p.keep.length > 0);
});

test('silences:null (sin escaneo) no truena', () => {
  const p = P.plan({ silences: null, words: null, duration: 10, minPause: 0.6 });
  assert.deepEqual(p.keep, [{ start: 0, end: 10 }]); assert.equal(p.cuts.length, 0);
});

test('video casi todo silencio: video completo, sin cortes', () => {
  const p = P.plan({ silences: [{ start: 0, end: 10 }], duration: 10, minPause: 0.6 });
  assert.deepEqual(p.keep, [{ start: 0, end: 10 }]); assert.equal(p.cuts.length, 0);
  const p2 = P.plan({ silences: [{ start: 0, end: 9.95 }], duration: 10, minPause: 0.6, padBefore: 0 });
  assert.deepEqual(p2.keep, [{ start: 0, end: 10 }]); assert.equal(p2.cuts.length, 0);
});

test('cola final corta no se tira: se quita el ultimo corte y cuadran keep/cuts', () => {
  const p = P.plan({ silences: [{ start: 2, end: 9.95 }], duration: 10, minPause: 0.6, padBefore: 0, padAfter: 0 });
  assert.deepEqual(p.cuts, []); assert.deepEqual(p.keep, [{ start: 0, end: 10 }]);
  const q = P.plan({ silences: [{ start: 2, end: 3 }, { start: 5, end: 9.95 }], duration: 10, minPause: 0.6, padBefore: 0, padAfter: 0 });
  assert.deepEqual(q.cuts, [{ start: 2, end: 3 }]);
  assert.deepEqual(q.keep, [{ start: 0, end: 2 }, { start: 3, end: 10 }]);
  const sum = r => r.keep.reduce((a, k) => a + k.end - k.start, 0) + r.cuts.reduce((a, c) => a + c.end - c.start, 0);
  assert.equal(+sum(q).toFixed(3), 10);
});

test('pedacito al inicio: se va con el corte salvo que tenga una palabra', () => {
  const s = [{ start: 0.05, end: 3 }];
  const p = P.plan({ silences: s, duration: 10, minPause: 0.6, padBefore: 0, padAfter: 0 });
  assert.deepEqual(p.cuts, [{ start: 0, end: 3 }]); assert.deepEqual(p.keep, [{ start: 3, end: 10 }]);
  const w = P.plan({ silences: s, duration: 10, minPause: 0.6, padBefore: 0, padAfter: 0, words: [{ start: 0, end: 0.05 }] });
  assert.deepEqual(w.cuts, []); assert.deepEqual(w.keep, [{ start: 0, end: 10 }]);
});

test('lee silencedetect con notacion cientifica', () => {
  const log = 'silence_start: 2.08333e-05\nsilence_end: 1.5 | silence_duration: 1.5\nsilence_start: 3E+00\nsilence_end: 4';
  assert.deepEqual(P.parseSilenceLog(log, 10), [{ start: 0, end: 1.5 }, { start: 3, end: 4 }]);
});
