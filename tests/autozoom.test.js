'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Z = require('../lib/autozoom');

function silenceClips(lens, gap = 0.6) { let t = 0; return lens.map(l => { const c = { start: t, end: +(t + l).toFixed(3) }; t = +(t + l + gap).toFixed(3); return c; }); }
const zs = r => r.map(c => (c.zoom ? c.zoom : 1));

test('alterna 1.00× / 1.10× en los cortes y respeta encuadre ≥ 4 s', () => {
  const r = Z.planAutoZoom(silenceClips([7, 7, 7, 7, 7, 7]), { level: 'normal' });
  assert.deepEqual(zs(r), [1, 1.1, 1, 1.1, 1, 1.1]);
  assert.ok(r.every(c => c.zoomAuto));
  const r2 = Z.planAutoZoom(silenceClips([3, 3, 3, 3, 3, 3, 3, 3]));
  let t = 0, last = 0;
  for (let i = 1; i < r2.length; i++) { t += 3; if (zs(r2)[i] !== zs(r2)[i - 1]) { assert.ok(t - last >= 4); last = t; } }
});

test('clips de < 2.5 s heredan el zoom anterior; nivel fuerte', () => {
  const r = Z.planAutoZoom(silenceClips([6, 2, 6, 1.5, 6]), { level: 'suave' });
  assert.equal(zs(r)[1], zs(r)[0]);
  assert.equal(zs(r)[3], zs(r)[2]);
  assert.deepEqual(zs(Z.planAutoZoom(silenceClips([6, 6]), { level: 'fuerte' })), [1, 1.15]);
});

test('más de 25 s sin corte: parte en el siguiente inicio de frase; sin transcripción a los 25 s', () => {
  const ws = [];
  for (let t = 0; t < 60; t += 0.5) if (!(t > 26.4 && t < 27.3)) ws.push({ start: t, end: t + 0.4 });
  ws.push({ start: 27.3, end: 27.6 }); ws.sort((a, b) => a.start - b.start);
  const r = Z.planAutoZoom([{ start: 0, end: 60 }], { words: ws });
  assert.equal(r[0].end, 27.3); assert.ok(r[1].autoSplit);
  assert.deepEqual(zs(r).slice(0, 2), [1, 1.1]);
  const r2 = Z.planAutoZoom([{ start: 10, end: 70 }]);
  assert.deepEqual(r2.map(c => [c.start, c.end]), [[10, 35], [35, 60], [60, 70]]);
});

test('golpe en un pico fuerte de voz, nunca más de 1.25×', () => {
  const energy = []; for (let t = 0; t < 60; t++) energy.push({ t, db: -30 });
  energy[23].db = -8;
  const r = Z.planAutoZoom(silenceClips([7, 7, 7, 7]), { energy });
  assert.ok(r.some(c => c.zoom === 1.18));
  assert.ok(r.every(c => !c.zoom || c.zoom <= Z.MAX_Z));
});

test('respeta lo manual y "quitar zooms automáticos" regresa todo como estaba', () => {
  const clips = silenceClips([7, 7, 7, 7]);
  clips[1].zoom = false; clips[1].zoomManual = true;
  clips[2].zoom = 1.2; clips[2].zoomManual = true;
  const r = Z.planAutoZoom(clips);
  assert.equal(r[1].zoom, false); assert.equal(r[2].zoom, 1.2);
  const back = Z.removeAutoZoom(Z.planAutoZoom([{ start: 0, end: 80, trans: true }]));
  assert.deepEqual(back, [{ start: 0, end: 80, trans: true, zoom: false }]);
});

test('centro en la cara dentro del cuadro; sin cara, tercio superior', () => {
  const r = Z.planAutoZoom(silenceClips([6, 6]), { faceOf: () => ({ cx: 0.98, cy: 0.1 }) });
  assert.equal(r[1].zoomCx, 0.545); assert.equal(r[1].zoomCy, 0.455);
  assert.equal(Z.planAutoZoom(silenceClips([6, 6]))[1].zoomCy, 0.455);
});

test('filtro de ffmpeg: recorte par, dentro del cuadro, lanczos; compatible con zoom:true', () => {
  assert.equal(Z.cropZoomFilter({ zoom: true }, 1920, 1080), ',crop=1714:964:103:58,scale=1920:1080:flags=lanczos,setsar=1');
  assert.equal(Z.cropZoomFilter({ zoom: 1.1, zoomCx: 0.545, zoomCy: 0.455 }, 1920, 1080), ',crop=1744:980:174:1,scale=1920:1080:flags=lanczos,setsar=1');
  assert.equal(Z.cropZoomFilter({ zoom: 3 }, 1920, 1080), ',crop=1536:864:192:108,scale=1920:1080:flags=lanczos,setsar=1');
  assert.equal(Z.cropZoomFilter({ zoom: false }, 1920, 1080), '');
  assert.deepEqual(Z.sanitizeSegmentZoom({ zoom: 0 }), { zoom: 0 });
  assert.deepEqual(Z.previewTransform({ zoom: 1.1 }), { transform: 'scale(1.1)', origin: '50.0% 50.0%' });
});
