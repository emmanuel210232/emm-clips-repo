'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../lib/seek');

test('entrada exacta: abre 15 s antes y corta en tiempo absoluto (start_time del formato + tiempo)', () => {
  const e = S.exactInput('v.mpg', 61.25, 71.25, { fmtStart: 1.412 });
  assert.deepEqual(e.input, ['-ss', '46.250', '-t', '25.500', '-i', 'v.mpg']);
  assert.equal(e.vtrim, 'trim=start=62.6620:end=72.6620,setpts=PTS-STARTPTS');
  assert.equal(e.atrim, 'atrim=start=62.6620:end=72.6620,asetpts=PTS-STARTPTS');
});

test('cerca del inicio no salta (-ss 0 no hace falta) y sin start_time usa 0', () => {
  const e = S.exactInput('v.mp4', 4, 9);
  assert.deepEqual(e.input, ['-t', '9.500', '-i', 'v.mp4']);
  assert.equal(e.vtrim, 'trim=start=4.0000:end=9.0000,setpts=PTS-STARTPTS');
});

test('pedazo inválido truena; absTrims para una sola entrada completa', () => {
  assert.throws(() => S.exactInput('v', 5, 5), /inválido/);
  assert.deepEqual(S.absTrims(10, 12.5, 1.4), { vtrim: 'trim=start=11.4000:end=13.9000,setpts=PTS-STARTPTS', atrim: 'atrim=start=11.4000:end=13.9000,asetpts=PTS-STARTPTS' });
  assert.deepEqual(S.COPYTS, ['-copyts']);
});

test('startTimeOf no truena si ffprobe no existe', () => {
  assert.equal(S.startTimeOf('/no/existe/ffprobe', 'x.ts'), 0);
});

test('start_time negativo (MPEG-TS cerca de la vuelta de 33 bits) se respeta', () => {
  const e = S.exactInput('v.ts', 100, 110, { fmtStart: -22.3177 });
  assert.equal(e.vtrim, 'trim=start=77.6823:end=87.6823,setpts=PTS-STARTPTS');
});
