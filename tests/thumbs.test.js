'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../lib/thumbs');

test('muestras: todo el video, alrededor de un momento y mejores momentos', () => {
  const all = T.sampleTimes({ duration: 3600, count: 4 });
  assert.deepEqual(all.times, [477, 1359, 2241, 3123]);
  assert.ok(all.times.every(t => t >= 36 && t <= 3564), 'sin el primer/último 1 %');
  assert.deepEqual(T.sampleTimes({ duration: 100, count: 5, mode: 'around', around: 50, window: 2 }).times, [48, 49, 50, 51, 52]);
  const best = T.sampleTimes({ duration: 3600, mode: 'best', count: 4, perMoment: 3, bestof: [{ start: 100, end: 130, score: 5 }, { start: 1000, end: 1009, score: 9 }] });
  assert.deepEqual(best.times, [105, 1001.5, 1004.5, 1007.5], 'primero el de mejor score');
  const nob = T.sampleTimes({ duration: 600, mode: 'best', count: 3 });
  assert.equal(nob.mode, 'all'); assert.equal(nob.fallback, true);
  assert.deepEqual(T.sampleTimes({ duration: 0 }).times, []);
});

test('un cuadro antes/después y formatos de tiempo', () => {
  assert.equal(T.stepFrame(10, 1, 60), 10.017);
  assert.equal(T.stepFrame(10, -60, 60), 9);
  assert.equal(T.stepFrame(0, -1, 60), 0);
  assert.equal(T.fmtTime(3723.25), '1:02:03.25');
  assert.equal(T.fmtTime(65.5), '1:05.50');
  assert.equal(T.fileStamp(3723.25), '1h02m03s250');
});

test('cara expresiva: boca abierta/sorpresa y risa ganan; ojos cerrados pierden', () => {
  const neutral = T.expressionScore({ jawOpen: 0.05, mouthSmileLeft: 0.1, mouthSmileRight: 0.1 }).score;
  const grito = T.expressionScore({ jawOpen: 0.8, browInnerUp: 0.7, eyeWideLeft: 0.5, eyeWideRight: 0.5 }).score;
  const risa = T.expressionScore([{ categoryName: 'mouthSmileLeft', score: 0.9 }, { categoryName: 'mouthSmileRight', score: 0.9 }, { categoryName: 'jawOpen', score: 0.3 }]).score;
  const parpadeo = T.expressionScore({ jawOpen: 0.8, browInnerUp: 0.7, eyeBlinkLeft: 0.95, eyeBlinkRight: 0.95 }).score;
  assert.ok(grito > risa && risa > neutral, `${grito} > ${risa} > ${neutral}`);
  assert.ok(parpadeo < grito * 0.5, 'ojos cerrados la arruinan');
});

test('cara chica o en la orilla vale menos; foto movida vale menos', () => {
  const blend = { jawOpen: 0.7 };
  const cerca = T.faceScore({ blend, w: 0.25, h: 0.35, cx: 0.5, cy: 0.4 }).score;
  const lejos = T.faceScore({ blend, w: 0.03, h: 0.05, cx: 0.5, cy: 0.4 }).score;
  const orilla = T.faceScore({ blend, w: 0.25, h: 0.35, cx: 0.97, cy: 0.4 }).score;
  assert.ok(cerca > orilla && orilla > lejos);
  const nitida = T.frameScore({ faces: [{ blend, w: 0.25, h: 0.35 }], sharp: 400 }).score;
  const movida = T.frameScore({ faces: [{ blend, w: 0.25, h: 0.35 }], sharp: 10 }).score;
  assert.ok(nitida > movida * 2);
  assert.equal(T.frameScore({ faces: [] }).score, 0);
});

test('nitidez: laplaciano alto en bordes, cero en imagen plana', () => {
  const w = 16, h = 16, flat = new Float32Array(w * h).fill(100), edges = new Float32Array(w * h);
  for (let i = 0; i < edges.length; i++) edges[i] = ((i % w) + Math.floor(i / w)) % 2 ? 255 : 0;
  assert.equal(T.laplacianVariance(flat, w, h), 0);
  assert.ok(T.laplacianVariance(edges, w, h) > 1000);
  assert.equal(T.grayFromRGBA(new Uint8ClampedArray([255, 255, 255, 255]), 1, 1)[0].toFixed(1), '255.0');
});

test('sugerencias: las mejores sin repetir casi el mismo momento', () => {
  const f = (t, jaw) => ({ t, faces: [{ blend: { jawOpen: jaw }, w: 0.25, h: 0.3 }], sharp: 300 });
  const r = T.rankFrames([f(10, 0.9), f(10.5, 0.85), f(30, 0.6), f(50, 0.02), { t: 60, faces: [] }], { top: 3, minGap: 2 });
  assert.deepEqual(r.map(x => x.t), [10, 30]);
});
