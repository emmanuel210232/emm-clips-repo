const test = require('node:test');
const assert = require('node:assert/strict');
const { findMatches, buildCuts, keptIntervals, adjustedCuts, parseSrt } = require('../lib/core');

test('detecta acentos, frases y palabras completas sin falsos positivos parciales', () => {
  const segments = [
    { start: 0, end: .5, text: 'Que' }, { start: .5, end: 1, text: 'cabrón' },
    { start: 1, end: 1.5, text: 'no' }, { start: 1.5, end: 2, text: 'mames' },
    { start: 2, end: 2.5, text: 'computadora' }
  ];
  const matches = findMatches(segments, [{term:'cabron',enabled:true},{term:'no mames',enabled:true},{term:'puta',enabled:true}]);
  assert.deepEqual(matches.map(m => m.term), ['cabron', 'no mames']);
  assert.equal(matches[1].start, 1);
  assert.equal(matches[1].end, 2);
});

test('une cortes solapados y conserva el resto de la línea de tiempo', () => {
  const matches = [{id:'a',start:1,end:1.4},{id:'b',start:1.42,end:1.7},{id:'c',start:8,end:8.2}];
  const cuts = buildCuts(matches, ['a','b'], 10, .05);
  assert.deepEqual(cuts, [{start:.95,end:1.75}]);
  assert.deepEqual(keptIntervals(cuts, 10), [{start:0,end:.95},{start:1.75,end:10}]);
});

test('importa SRT y marca sus tiempos como aproximados', () => {
  const rows = parseSrt('1\n00:00:01,000 --> 00:00:02,500\nNo mames, güey.\n');
  assert.equal(rows[0].start, 1);
  assert.equal(rows[0].end, 2.5);
  assert.equal(rows[0].approximate, true);
});

test('el margen automático respeta palabras vecinas y los ajustes se aplican al exportar',()=>{
  const words=[{start:.5,end:.99},{start:1,end:1.4},{start:1.41,end:1.8}];
  const matches=[{id:'groseria',start:1,end:1.4}];
  assert.deepEqual(adjustedCuts(matches,['groseria'],3,words),[{start:.995,end:1.405}]);
  assert.deepEqual(adjustedCuts(matches,['groseria'],3,words,{groseria:{start:.9,end:1.5}}),[{start:.9,end:1.5}]);
});

test('pide revisión cuando Whisper asigna a una palabra más de 0.9 segundos',()=>{
  const segments=[{start:0,end:.4,text:'No'},{start:.4,end:2.1,text:'mames'},{start:2.1,end:2.4,text:'a'}];
  const matches=findMatches(segments,[{term:'no mames',enabled:true}]);
  assert.equal(matches.length,1);
  assert.equal(matches[0].approximate,true);
});
