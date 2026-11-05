'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {parseAssessment,summarizeAssessment}=require('../lib/editorial');

test('el evaluador penaliza logística y rechaza respuestas fuera de escala',()=>{
  const base={hook:2,story:2,payoff:1,reaction:2,clarity:2,logistics:0};
  const without=summarizeAssessment(base).score;
  const withLogistics=summarizeAssessment({...base,logistics:3}).score;
  assert.ok(without>withLogistics);
  assert.deepEqual(parseAssessment(JSON.stringify(base)),base);
  assert.throws(()=>parseAssessment(JSON.stringify({...base,hook:9})));
});
