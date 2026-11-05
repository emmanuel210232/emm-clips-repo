'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('../lib/hwaccel');

test('decodeArgs: solo -hwaccel cuda (sin hwaccel_output_format)', () => {
  assert.deepEqual(H.decodeArgs({ gpu: true }), ['-hwaccel', 'cuda']);
  assert.deepEqual(H.decodeArgs({ gpu: false }), []);
  assert.deepEqual(H.decodeArgs(), []);
});

test('sin GPU no cambia nada', () => {
  const a = ['-y', '-i', 'v.mpg', 'out.mp4'];
  assert.deepEqual(H.withHwaccel(a, { gpu: false }), a);
  assert.notEqual(H.withHwaccel(a, { gpu: false }), a, 'regresa copia');
});

test('varias entradas con -ss/-t (como exportVideo con pre-roll): -hwaccel antes de cada bloque', () => {
  const args = ['-y', '-ss', '85.000', '-t', '25.000', '-i', 'D:/directo.mpg', '-ss', '0.000', '-t', '12.000', '-i', 'D:/directo.mpg',
    '-/filter_complex', 'data/filter.txt', '-map', '[v]', '-map', '[a]', '-c:v', 'h264_nvenc', '-cq', '18', '-c:a', 'aac', 'out.mp4'];
  assert.deepEqual(H.withHwaccel(args, { gpu: true }), ['-y', '-hwaccel', 'cuda', '-ss', '85.000', '-t', '25.000', '-i', 'D:/directo.mpg',
    '-hwaccel', 'cuda', '-ss', '0.000', '-t', '12.000', '-i', 'D:/directo.mpg',
    '-/filter_complex', 'data/filter.txt', '-map', '[v]', '-map', '[a]', '-c:v', 'h264_nvenc', '-cq', '18', '-c:a', 'aac', 'out.mp4']);
});

test('no pone -hwaccel en lavfi, concat, imágenes, subtítulos ni audio', () => {
  const args = ['-y', '-i', 'main.mp4', '-f', 'lavfi', '-t', '0.8', '-i', 'color=c=black:s=1920x1080:r=60',
    '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-i', 'logo.png', '-i', 'subs.ass', '-i', 'voz.wav',
    '-f', 'concat', '-safe', '0', '-i', 'lista.txt', '-filter_complex', 'x', 'o.mp4'];
  const r = H.withHwaccel(args, { gpu: true });
  assert.equal(r.filter(x => x === '-hwaccel').length, 1);
  assert.deepEqual(r.slice(0, 5), ['-y', '-hwaccel', 'cuda', '-i', 'main.mp4']);
});

test('respeta -hide_banner/-loglevel y no duplica un -hwaccel existente', () => {
  const r = H.withHwaccel(['-hide_banner', '-loglevel', 'error', '-ss', '5', '-i', 'a.ts', '-hwaccel', 'cuda', '-i', 'b.ts', '-f', 'null', '-'], { gpu: true });
  assert.deepEqual(r, ['-hide_banner', '-loglevel', 'error', '-hwaccel', 'cuda', '-ss', '5', '-i', 'a.ts', '-hwaccel', 'cuda', '-i', 'b.ts', '-f', 'null', '-']);
});

test('reconoce fallas de NVDEC/CUDA y no confunde otros errores', () => {
  for (const s of ['[h264 @ 0x1] Failed setup for format cuda: hwaccel initialisation returned error.', 'No device available for decoder: device type cuda needed for codec h264.',
    'Cannot load nvcuda.dll', 'CUDA_ERROR_OUT_OF_MEMORY', 'Device creation failed: -542398533.', 'Cannot load libcuda.so.1'])
    assert.equal(H.isHwaccelFailure(s), true, s);
  for (const s of ['', 'No such file or directory', 'Error initializing output stream: Error while opening encoder for output stream #0:0 - maybe incorrect parameters', 'Conversion failed!'])
    assert.equal(H.isHwaccelFailure(s), false, s);
});

test('runWithHwFallback: reintenta sin GPU solo si la falla es de NVDEC', async () => {
  const calls = [];
  const run = async a => { calls.push(a); if (a.includes('-hwaccel')) throw Error('ffmpeg salió con 1: Failed setup for format cuda'); return 'ok'; };
  let fell = 0;
  assert.equal(await H.runWithHwFallback(run, ['-i', 'v.ts', 'o.mp4'], { gpu: true, onFallback: () => fell++ }), 'ok');
  assert.equal(calls.length, 2); assert.equal(fell, 1); assert.deepEqual(calls[1], ['-i', 'v.ts', 'o.mp4']);
  const bad = async () => { throw Error('Conversion failed!'); };
  await assert.rejects(() => H.runWithHwFallback(bad, ['-i', 'v.ts'], { gpu: true }), /Conversion failed/);
  calls.length = 0;
  await H.runWithHwFallback(run, ['-i', 'v.ts'], { gpu: false });
  assert.deepEqual(calls, [['-i', 'v.ts']]);
});

test('probeCuda nunca lanza: binario inexistente → false', async () => {
  H._clearCache();
  assert.equal(await H.probeCuda('/no/existe/ffmpeg'), false);
});
