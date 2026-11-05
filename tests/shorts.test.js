'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {suggestShorts,makeAss,applyCaptionCorrections}=require('../lib/shorts');

test('corrige una frase de subtítulos y conserva el intervalo de tiempo',()=>{
  const words=[{text:'yo',norm:'yo',start:1,end:1.3},{text:'soy',norm:'soy',start:1.3,end:1.6},{text:'una',norm:'una',start:1.6,end:1.9},{text:'cuevita',norm:'cuevita',start:1.9,end:2.5}];
  const corrected=applyCaptionCorrections(words,[{from:'yo soy una cuevita',to:'hay una cuevita'}]);
  assert.equal(corrected.map(w=>w.text).join(' '),'hay una cuevita');
  assert.equal(corrected[0].start,1);
  assert.equal(corrected.at(-1).end,2.5);
  const ass=makeAss(words,{start:0,end:4,captionStyle:'clasico',captionCorrections:[{from:'yo soy una cuevita',to:'hay una cuevita'}]});
  const plain=ass.replace(/\{[^}]*\}/g,'');
  assert.match(plain,/HAY UNA CUEVITA/);
  assert.doesNotMatch(plain,/YO SOY/);
});

test('los subtítulos dividen frases largas para caber en vertical',()=>{
  const text='Tenemos que investigar cuál es la fauna que se movió detrás del árbol'.split(' ');
  const segments=text.map((word,i)=>({start:i*.4,end:(i+1)*.4,text:word}));
  const ass=makeAss(segments,{start:0,end:10,hook:'¿QUÉ SE MOVIÓ?'});
  const lines=ass.split('\n').filter(s=>s.startsWith('Dialogue:')&&s.includes(',Caption,'));
  assert.ok(lines.length>1);
  for(const line of lines) assert.ok(line.split(',,').at(-1).replace(/\{[^}]*\}/g,'').length<=21);
  assert.match(ass,/INVESTIGAR/);
  assert.match(ass,/¿QUÉ SE MOVIÓ\?/);
  assert.match(ass,/@ADRIANOZENDEJAS32/);
  assert.match(ass,/&H0000FFFF&/);
});

test('las propuestas duran entre 60 y 90 segundos y no se superponen',()=>{
  const words=['mira','qué','pasó','dinero','espera','increíble','aquí','vamos','ahora','sí'];
  const segments=Array.from({length:2400},(_,i)=>({start:i*.35,end:i*.35+.28,text:words[i%words.length]+(i%31===0?'?':'')}));
  const shorts=suggestShorts(segments,850);
  assert.equal(shorts.length,5);
  for(const s of shorts) assert.ok(s.end-s.start>=60 && s.end-s.start<=90);
  for(let i=0;i<shorts.length;i++) for(let j=i+1;j<shorts.length;j++) assert.ok(shorts[i].end<=shorts[j].start || shorts[j].end<=shorts[i].start);
});

test('la marca se puede omitir o cambiar al compartir la app',()=>{
  const words=[{start:0,end:1,text:'hola'}];
  const withoutBrand=makeAss(words,{start:0,end:2,brandHandle:'',brandMark:''});
  assert.doesNotMatch(withoutBrand,/@ADRIANOZENDEJAS32|,Brand,,/);
  const withBrand=makeAss(words,{start:0,end:2,brandHandle:'@OTROCANAL',brandMark:'O'});
  assert.match(withBrand,/@OTROCANAL/);
  assert.doesNotMatch(withBrand,/@ADRIANOZENDEJAS32/);
});

test('estilo Opus: 1-2 palabras por subtítulo, pop de entrada, gancho en recuadro solo 3 s y sin cortarlo',()=>{
  const words=['te','esperamos','a','que','hagas','algo','increible'].map((t,i)=>({text:t,norm:t,start:i*0.4,end:i*0.4+0.35}));
  const ass=makeAss(words,{start:0,end:6,hook:'El peligro no termina con el primer tirón'});
  const caps=ass.split('\n').filter(l=>l.startsWith('Dialogue')&&l.includes(',Caption,'));
  assert.ok(caps.every(l=>l.replace(/\{[^}]*\}/g,'').split(',,').pop().trim().split(/\s+/).length<=2), 'máx 2 palabras');
  assert.ok(caps.every(l=>l.includes('\\t(0,90,\\fscx100\\fscy100)')), 'pop de entrada');
  assert.match(ass,/Style: Caption,Luckiest Guy/);
  const hook=ass.split('\n').find(l=>l.includes(',Hook,'));
  assert.match(hook,/0:00:00\.00,0:00:03\.20/);
  assert.match(hook.replace(/\\N/g,' '),/PRIMER TIRÓN/);
});
