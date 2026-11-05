'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const T=require('../lib/teaser');

const cands=[
  {start:100,end:170,score:6,gancho:'a'},{start:400,end:470,score:9,gancho:'b'},{start:900,end:960,score:8,gancho:'c'},
  {start:1300,end:1380,score:7,gancho:'d'},{start:2000,end:2070,score:10,gancho:'e'},{start:2500,end:2560,score:5,gancho:'f'},
  {start:3000,end:3050,score:4,gancho:'g'},{start:420,end:480,score:9.5,gancho:'pegado'},
];

test('elige los mejores momentos del resumen por score y sin amontonarlos',()=>{
  const m=T.pickMoments({candidates:cands,duration:3600,count:6});
  assert.equal(m.length,6);
  assert.deepEqual(m.map(x=>x.label),['e','pegado','c','d','a','f']); // 'b' queda fuera: está pegado a 'pegado' (mejor score)
  assert.ok(m.every(x=>x.source==='bestof'));
});

test('sin resumen del directo usa la transcripción (risas/exclamaciones pesan más)',()=>{
  const tr=[];
  for(let t=0;t<600;t+=5) tr.push({start:t,end:t+4,text:'pues aquí andamos caminando'});
  tr.push({start:300,end:304,text:'¡JAJAJA no mames wey! ¡mira!'},{start:305,end:309,text:'¡jajaja corre corre!'});
  const m=T.pickMoments({transcript:tr,duration:600,count:2});
  assert.equal(m.length,2);
  assert.equal(m[0].source,'transcript');
  assert.ok(m[0].start<=300 && m[0].end>=309,'la mejor ventana contiene las risas');
});

test('completa con la transcripción si el resumen trae pocos momentos',()=>{
  const tr=[]; for(let t=0;t<1200;t+=5) tr.push({start:t,end:t+4,text:'hola chat '+t});
  const m=T.pickMoments({candidates:[{start:500,end:560,score:9}],transcript:tr,duration:1200,count:4});
  assert.equal(m.length,4); assert.equal(m[0].source,'bestof'); assert.ok(m.slice(1).every(x=>x.source==='transcript'));
  for(let i=0;i<m.length;i++) for(let j=i+1;j<m.length;j++) assert.ok(m[i].end+30<=m[j].start||m[j].end+30<=m[i].start,'separados');
});

test('la ventana más fuerte es la de más energía (potencia, no promedio de dB)',()=>{
  const e=[]; for(let t=0;t<60;t++) e.push({t,db:-30});
  e[41].db=-5; // un grito fuerte en t=41
  const w=T.strongestWindow(e,0,60,10);
  assert.ok(w.start<=41 && w.end>41,'incluye el grito');
  assert.equal(w.end-w.start,10);
  const w2=T.strongestWindow(e,0,60,10,[{start:38,end:45}]); // si el grito está en un rango a evitar, no lo usa
  assert.ok(w2.end<=38.25||w2.start>=44.75);
});

test('sin datos de energía toma el centro del momento',()=>{
  assert.deepEqual(T.strongestWindow([],100,140,10),{start:115,end:125,energy:0});
});

test('el plan sale en orden cronológico y arranca al inicio de una frase cercana',()=>{
  const moments=[{start:500,end:560,score:9},{start:100,end:160,score:8}];
  const energy=m=>Array.from({length:60},(_,i)=>({t:m.start+i,db:i===20?-3:-40}));
  const tr=[{start:114.2,end:116,text:'oye'},{start:515.2,end:518,text:'mira'}];
  const p=T.planTeaser({moments,energyOf:energy,transcript:tr,fragLen:10,xfade:0.5});
  assert.equal(p.fragments.length,2);
  assert.equal(p.fragments[0].start,114.2); // pico en 120 → ventana centrada 115..125 → se ajusta a la frase de 114.2
  assert.equal(p.fragments[1].start,515.2);
  assert.equal(p.duration,19.5);
});

test('duración del avance: 6 × 10 s con 5 fundidos de 0.5 s = 57.5 s',()=>{
  const f=Array.from({length:6},(_,i)=>({start:i*100,end:i*100+10}));
  assert.equal(T.teaserDuration(f,0.5),57.5);
  assert.equal(T.teaserDuration([{start:0,end:10}],0.5),10);
  assert.equal(T.teaserDuration([],0.5),0);
});

test('filtro del avance: blanco y negro, fundidos, letrero y audio alineado con la imagen',()=>{
  const frags=[{start:5,end:15},{start:100,end:110},{start:200,end:210}];
  const g=T.buildTeaserGraph({frags,firstInput:3,videoPath:'v.mpg',fps:60,width:1920,height:1080,fontFile:'data/fonts/X.ttf',muteOf:(s,e)=>s===100?',volume=0':''});
  // entradas: salto 15 s antes (o lo que haya) y trim sobre los tiempos pedidos
  assert.deepEqual(g.inputs.slice(0,6),['-ss','0.000','-t','15.000','-i','v.mpg']);
  assert.deepEqual(g.inputs.slice(6,12),['-ss','85.000','-t','25.000','-i','v.mpg']);
  const f=g.filters.join(';');
  assert.match(f,/\[3:v\]trim=start=5\.000:end=15\.000/);
  assert.match(f,/\[4:v\]trim=start=15\.000:end=25\.000.*hue=s=0/);
  assert.match(f,/xfade=transition=fade:duration=0\.500:offset=9\.500/);
  assert.match(f,/xfade=transition=fade:duration=0\.500:offset=19\.000/);
  // audio: los fragmentos con fundido después pierden 0.5 s al final → suenan justo cuando aparecen
  assert.match(f,/\[3:a\]atrim=start=5\.000:end=14\.500/);
  assert.match(f,/\[4:a\]atrim=start=15\.000:end=24\.500,asetpts=PTS-STARTPTS,volume=0/);
  assert.match(f,/\[5:a\]atrim=start=15\.000:end=25\.000/);
  assert.match(f,/text='PRÓXIMAMENTE\.\.\.'/);
  assert.match(f,/fontfile='data\/fonts\/X\.ttf'/);
  assert.equal(g.duration,29);
  assert.equal(g.nextInput,6);
  const pre=T.prependFilter(g,'[v]','[a]');
  assert.match(pre.join(';'),/\[tzv\]\[tza\]\[tzomv\]\[tzoma\]concat=n=2:v=1:a=1\[tzov\]\[tzoa\]/);
});

test('escapes para drawtext y rutas de Windows',()=>{
  assert.equal(T.fontPathForFilter('C:\\Users\\x\\f.ttf'),'C\\:/Users/x/f.ttf');
  assert.equal(T.drawtextEscape("50% it's: ya"),"50\\% it’s\\: ya");
});

test('valida los fragmentos que manda la interfaz',()=>{
  const s=T.sanitizeFragments([{start:50,end:60},{start:55,end:65},{start:-5},{start:'x'},{start:595,end:640}],600);
  assert.deepEqual(s.map(f=>[f.start,f.end]),[[0,10],[50,60],[595,600]]);
});
