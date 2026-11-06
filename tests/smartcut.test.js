'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const SC = require('../lib/smartcut');

const FPS = 60, V0 = 0.1, keys = Array.from({ length: 400 }, (_, i) => i * 120); // cuadro clave cada 2 s
const out = p => p.pieces.map(x => x.type === 'copy' ? `C${x.a}-${x.b}` : 'E' + x.ranges.map(r => `${r.a}-${r.b}`).join('+') + (x.xfades.some(Boolean) ? `x${x.xfades.join('/')}` : '') + (x.fadeIn ? 'I' : '') + (x.fadeOut ? 'O' : '')).join(' ');

test('un corte largo: cabeza recodificada + núcleo copiado (GOPs completos) + cola recodificada', () => {
  const p = SC.plan([{ start: 5.3, end: 13.7 }], keys, V0, FPS);
  assert.equal(out(p), 'E312-360 C360-720 E720-816');
  assert.equal(p.totalFrames, 816 - 312);
  assert.equal(p.copiedFrames, 360);
});

test('clip corto (< 1 s entre cuadros clave) se recodifica completo', () => {
  const p = SC.plan([{ start: 5.3, end: 6.5 }], keys, V0, FPS);
  assert.equal(out(p), 'E312-384');
});

test('clip con zoom se recodifica completo; los demás se copian', () => {
  const p = SC.plan([{ start: 0.1, end: 10.1 }, { start: 20.1, end: 30.1, zoom: 1.1 }], keys, V0, FPS);
  assert.equal(out(p), 'C0-600 E1200-1800');
});

test('cortes secos entre clips: la cola de uno y la cabeza del siguiente van en la misma pieza recodificada', () => {
  const p = SC.plan([{ start: 1.1, end: 9.0 }, { start: 30.5, end: 40.1 }], keys, V0, FPS);
  assert.equal(out(p), 'E60-120 C120-480 E480-534+1824-1920 C1920-2400');
  assert.equal(p.totalFrames, (534 - 60) + (2400 - 1824));
});

test('transición (crossfade) entre clips: cuadros de los dos lados se recodifican juntos y se descuentan', () => {
  const p = SC.plan([{ start: 0.1, end: 9.0 }, { start: 30.1, end: 40.1, trans: true }], keys, V0, FPS, { xfadeFrames: i => (i === 1 ? 30 : 0) });
  // El núcleo del 2º clip no puede empezar justo en el corte: arranca en el siguiente cuadro clave.
  assert.equal(out(p), 'C0-480 E480-534+1800-1920x30 C1920-2400');
  assert.equal(p.totalFrames, 480 + (54 + 120 - 30) + 480);
});

test('fundido de entrada y salida: el principio y el final se recodifican', () => {
  const p = SC.plan([{ start: 0.1, end: 20.1 }], keys, V0, FPS, { fadeInFrames: 48, fadeOutFrames: 48 });
  assert.equal(out(p), 'E0-120I C120-1080 E1080-1200O');
});

test('parseKeyframes: lee paquetes de ffprobe y detecta video irregular', () => {
  const csv = ['0.101667,K__', '0.118333,___', '0.135000,___', '2.101667,K__'].join('\n');
  const k = SC.parseKeyframes(csv, 60);
  assert.equal(k.ok, true); assert.deepEqual(k.keys, [0, 120]);
  assert.equal(SC.parseKeyframes('0.1,K\n0.127,_\n', 60).ok, false);
});

test('parseKeyframes: los tiempos de Kick redondeados al milisegundo (cuadros de 16/17 ms) son válidos', () => {
  const csv = Array.from({ length: 240 }, (_, i) => `${(0.1 + Math.round(i * 1000 / 60) / 1000).toFixed(6)},${i % 120 === 0 ? 'K__' : '___'}`).join('\n');
  const k = SC.parseKeyframes(csv, 60);
  assert.equal(k.ok, true); assert.deepEqual(k.keys, [0, 120]);
  assert.equal(SC.parseKeyframes('0.1,K\n0.1255,_\n', 60).ok, false); // media cuadro fuera de lugar: irregular de verdad
});

test('parseKeyframes: GOP abierto (cuadro que se muestra antes del cuadro clave) desactiva el corte inteligente', () => {
  const k = SC.parseKeyframes(['0.100000,K__', '0.150000,___', '2.100000,K__', '2.066667,___'].join('\n'), 60);
  assert.equal(k.ok, false); assert.equal(k.reason, 'GOP abierto');
});
