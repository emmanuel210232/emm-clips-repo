'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const R=require('../lib/research');

const NOW=Date.parse('2026-10-29T12:00:00Z');
const daysAgo=d=>new Date(NOW-d*864e5).toISOString();
function vid(id,ch,views,{dur=1200,title='Video '+id,ago=10,iso,desc='',tags=[]}={}){
  return {id,channelId:ch,title,description:desc,tags,publishedAt:iso||daysAgo(ago),duration:dur,views,likes:0,comments:0,thumb:'',thumbSmall:'',live:false};
}

test('lee duraciones ISO 8601 de YouTube',()=>{
  assert.equal(R.parseDuration('PT1H2M3S'),3723);
  assert.equal(R.parseDuration('PT45S'),45);
  assert.equal(R.parseDuration('P1DT1M'),86460);
  assert.equal(R.parseDuration(''),0);
});

test('la hora de subida se convierte a hora de CDMX',()=>{
  // 2026-10-29 02:00 UTC = 2026-10-28 20:00 en CDMX (UTC-6, sin horario de verano), miércoles
  const s=R.mxSlot('2026-10-29T02:00:00Z');
  assert.equal(s.hour,20);
  assert.equal(R.DAYS[s.dow],'Mié');
});

test('score = vistas ÷ mediana del propio canal (canal chico con un pegón cuenta igual que uno grande)',()=>{
  const channels=[{id:'A',title:'Shifu Clips',status:'track'},{id:'B',title:'Momentos Shifu',status:'track'}];
  const vids={
    A:[vid('a1','A',1000),vid('a2','A',1000),vid('a3','A',1000),vid('a4','A',8000)],
    B:[vid('b1','B',100000),vid('b2','B',100000),vid('b3','B',100000),vid('b4','B',120000)],
  };
  const out=R.analyze(channels,vids,NOW);
  const top=out.long.outliers[0];
  assert.equal(top.id,'a4');
  assert.ok(top.score>=7, 'el pegón del canal chico tiene score alto: '+top.score);
  assert.ok(out.long.outliers.find(v=>v.id==='b4').score<2);
});

test('separa Shorts de videos largos y no mezcla sus medianas',()=>{
  const channels=[{id:'A',title:'Shifu',status:'track'}];
  const vids={A:[vid('l1','A',500),vid('l2','A',500),vid('s1','A',50000,{dur:40}),vid('s2','A',50000,{dur:55})]};
  const out=R.analyze(channels,vids,NOW);
  assert.equal(out.totals.long,2);
  assert.equal(out.totals.short,2);
  assert.equal(out.long.outliers[0].score,1);
  assert.equal(out.short.outliers[0].score,1);
});

test('en un canal general solo cuentan los videos que mencionan a Shifu; en uno dedicado, todos',()=>{
  const general={id:'G',title:'Clips de streamers'};
  const gv=[vid('g1','G',1,{title:'Shifu en Miami'}),vid('g2','G',1,{title:'Ibai'}),vid('g3','G',1,{title:'Westcol'}),vid('g4','G',1,{title:'Spreen'})];
  assert.deepEqual(R.relevantVideos(general,gv).videos.map(v=>v.id),['g1']);
  const dedicado={id:'D',title:'Adriano Zendejas Kick'};
  const dv=[vid('d1','D',1,{title:'Fuimos a Six Flags'}),vid('d2','D',1,{title:'Jet privado'})];
  assert.equal(R.relevantVideos(dedicado,dv).videos.length,2);
});

test('los videos recién subidos no cuentan para los patrones y mi canal va aparte',()=>{
  const channels=[{id:'A',title:'Shifu',status:'track'},{id:'M',title:'Mi canal',mine:true,status:'track'}];
  const vids={A:[vid('a1','A',100),vid('a2','A',100),vid('a3','A',100),vid('nuevo','A',100000,{ago:0.5})],M:[vid('m1','M',10,{title:'Shifu mío'})]};
  const out=R.analyze(channels,vids,NOW);
  assert.ok(!out.long.outliers.some(v=>v.id==='nuevo'));
  assert.ok(!out.long.outliers.some(v=>v.id==='m1'));
  assert.equal(out.long.mineCount,1);
  assert.equal(out.mineVideos[0].id,'m1');
});

test('detecta palabras de título que aparecen más en los que pegaron',()=>{
  const channels=[{id:'A',title:'Shifu',status:'track'}];
  const list=[];
  for(let i=0;i<4;i++) list.push(vid('t'+i,'A',50000,{title:'JET PRIVADO a Miami '+i}));
  for(let i=0;i<12;i++) list.push(vid('r'+i,'A',1000,{title:'Caminando por la calle '+i}));
  const out=R.analyze(channels,{A:list},NOW);
  const words=out.long.words.map(w=>w.word);
  assert.ok(words.includes('jet')&&words.includes('privado'), JSON.stringify(out.long.words));
  assert.ok(!words.includes('calle'));
});

test('extrae hashtags y rasgos del título',()=>{
  assert.deepEqual(R.extractHashtags('Hola #MaestroShifu y #kick #kick'),['#maestroshifu','#kick']);
  const f=R.titleFeatures('HICIMOS STREAM EN UN AVIÓN ✈️ ($12,500 al mes) | Shifu');
  assert.equal(f.emojis,1); assert.ok(f.hasMoney); assert.ok(f.hasSeparator); assert.ok(f.mentionsShifu); assert.equal(f.capsWords,3);
});

test('interpreta @handle, URL y IDs de canal',()=>{
  assert.deepEqual(R.parseChannelInput('https://www.youtube.com/@adrianozendejaselmaestroshifu/videos'),{handle:'@adrianozendejaselmaestroshifu'});
  assert.deepEqual(R.parseChannelInput('@shifu.clips'),{handle:'@shifu.clips'});
  assert.deepEqual(R.parseChannelInput('https://youtube.com/channel/UCabcdefghijklmnopqrstuv'),{id:'UCabcdefghijklmnopqrstuv'});
  assert.equal(R.parseChannelInput(''),null);
});

test('la transcripción compacta quita los bucles que inventa Whisper',()=>{
  const segs=[];
  for(let i=0;i<40;i++) segs.push({start:60+i,text:'No vamos a ir al aeropuerto.'});
  segs.push({start:120,text:'Aterrizamos en Miami, chat.'});
  const t=R.compactTranscript(segs);
  assert.ok((t.match(/aeropuerto/g)||[]).length<=2, t);
  assert.match(t,/\[2m\] Aterrizamos en Miami/);
});

test('quita los bucles que inventa Whisper sin tocar lo que se dijo de verdad',()=>{
  assert.equal(R.dedupeRepeats('No me caliente al lado mío. No me caliente al lado mío. No me caliente al lado mío. Ya llegamos.'),'No me caliente al lado mío. Ya llegamos.');
  assert.equal(R.dedupeRepeats('Te lo juro te lo juro te lo juro te lo juro de verdad.'),'Te lo juro de verdad.');
  assert.equal(R.dedupeRepeats('No, no, ya.'),'No, no, ya.', 'dos veces es habla normal');
  assert.equal(R.dedupeRepeats('Mañana vamos a Miami con Jay Wheeler.'),'Mañana vamos a Miami con Jay Wheeler.');
});
test('la limpieza es rápida aun con miles de repeticiones (antes una regex se trababa)',()=>{
  const big=Array(3000).fill('hoy nos vamos a pasar de verga').join(' ')+' fin';
  const t0=Date.now(); const out=R.dedupeRepeats(big);
  assert.ok(Date.now()-t0<500, 'tardó '+(Date.now()-t0)+' ms');
  assert.equal(out,'hoy nos vamos a pasar de verga fin');
});

test('lee la lista de momentos de la IA aunque venga con texto, bloque de código, corchetes o cortada',()=>{
  const m='{"ini":233,"dur":90,"gancho":"EL SOPLO","por":"x","score":8},{"ini":539,"dur":60,"gancho":"8 MONSTERS","por":"y","score":6}';
  assert.equal(R.extractMoments('{"momentos":['+m+']}').length,2,'JSON limpio');
  assert.equal(R.extractMoments('Aquí están los momentos:\n```json\n{"momentos":['+m+']}\n```\nEspero que sirvan.').length,2,'con texto y bloque de código');
  assert.equal(R.extractMoments('Usé los bloques [SEGUNDOS|m:ss] del directo. {"momentos":['+m+']} (ver [nota])').length,2,'corchetes en la explicación (antes rompía todo)');
  assert.equal(R.extractMoments('{"momentos":['+m+',{"ini":900,"dur":7').length,2,'respuesta cortada: rescata los completos');
  assert.equal(R.extractMoments('{"shorts":[{"ini":10,"dur":40,"gancho":"a [b] c"}]}').length,1,'clave shorts y corchetes dentro del texto');
  assert.equal(R.extractMoments('No puedo ayudar con eso.').length,0);
});
