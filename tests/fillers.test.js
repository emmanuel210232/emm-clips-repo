'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('../lib/fillers');
// Palabras con tiempos: [texto, inicio, fin]
const seg = ws => ws.map(([text, start, end]) => ({ text, start, end }));

test('marca solas las seguras (eh, mmm) y deja sin marcar las de revisar', () => {
  const f = F.findFillers(seg([['Hola', 0, .4], ['eeeh', .5, 1.0], ['chat', 1.4, 1.8], ['mmm', 2.4, 3.0], ['vamos', 3.3, 3.7], ['este,', 4.0, 4.3], ['al', 4.8, 4.9], ['Oxxo', 4.9, 5.3]]));
  assert.deepEqual(f.map(x => [x.term, x.level, x.suggested]), [['eeeh', 'siempre', true], ['mmm', 'siempre', true], ['este,', 'revisar', false]]);
});

test('no marca usos con significado: "este video", "está bueno", "pues sí", "o sea que", "e" conjunción', () => {
  const f = F.findFillers(seg([['este', 0, .3], ['video', .3, .7], ['está', 1, 1.2], ['bueno', 1.2, 1.5], ['pues', 2, 2.2], ['sí', 2.5, 2.7], ['o', 3, 3.1], ['sea', 3.1, 3.3], ['que', 3.3, 3.5], ['vámonos', 3.5, 4], ['e', 4.1, 4.15], ['iba', 4.15, 4.5]]));
  assert.deepEqual(f, []);
});

test('detecta "Bueno," al arrancar, "o sea…", "pues…" con pausa y la coletilla "¿no?"', () => {
  const f = F.findFillers(seg([['Bueno,', 0, .4], ['ya', 1, 1.2], ['llegamos', 1.2, 1.7], ['o', 2, 2.1], ['sea…', 2.1, 2.4], ['está', 3, 3.2], ['cabrón', 3.2, 3.6], ['¿no?', 3.6, 3.8], ['pues…', 4.6, 5.0], ['vamos', 5.6, 6]]));
  assert.deepEqual(f.map(x => x.kind), ['bueno', 'osea', 'no', 'pues']);
  assert.ok(f.every(x => !x.suggested), 'las de revisar no se marcan solas');
});

test('el corte se come el silencio vecino (sin hueco) y deja un margen junto a las palabras', () => {
  const [f] = F.findFillers(seg([['ya', 0, .5], ['eh', 1.0, 1.3], ['vamos', 2.0, 2.4]]));
  assert.equal(f.cutStart, 0.58);
  assert.equal(f.cutEnd, 1.92);
});

test('tiempos aproximados (segmento de varias palabras) nunca se marcan solos', () => {
  const f = F.findFillers([{ text: 'ya eh vamos', start: 0, end: 1.5 }]);
  assert.equal(f.length, 1); assert.equal(f[0].approximate, true); assert.equal(f[0].suggested, false);
});

test('muletillas propias solo con pausa; cortes unidos y quitados de los clips (ripple)', () => {
  const list = [...F.DEFAULT_FILLERS, { term: 'tipo', level: 'revisar' }];
  const f = F.findFillers(seg([['tipo,', 0, .3], ['tipo', 1, 1.2], ['así', 1.2, 1.5]]), list);
  assert.deepEqual(f.map(x => x.term), ['tipo,']);
  const cuts = F.fillerCuts([{ id: 'a', cutStart: 1, cutEnd: 2 }, { id: 'b', cutStart: 2.02, cutEnd: 3 }, { id: 'c', cutStart: 5, cutEnd: 6 }], ['a', 'b']);
  assert.deepEqual(cuts, [{ start: 1, end: 3 }]);
  assert.deepEqual(F.removeFromClips([{ start: 0, end: 10, zoom: true }], cuts), [{ start: 0, end: 1, zoom: true }, { start: 3, end: 10, zoom: true }]);
  assert.equal(F.isRemoved({ start: 1.5, end: 1.8 }, [{ start: 0, end: 1 }, { start: 3, end: 10 }]), true);
});
