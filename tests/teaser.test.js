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
  const g=T.buildTeaserGraph({frags,firstInput:3,videoPath:'v.mpg',fps:60,width:1920,height:1080,fontFile:'data/fonts/X.ttf',fmtStart:1.4,muteOf:(s,e)=>s===100?',volume=0':''});
  // CORTE EXACTO: salto 15 s antes (o nada si está cerca del inicio) y trim sobre el tiempo ABSOLUTO (start_time 1.4 + tiempo)
  assert.equal(g.needsCopyts,true);
  assert.deepEqual(g.inputs.slice(0,4),['-t','15.500','-i','v.mpg']);
  assert.deepEqual(g.inputs.slice(4,10),['-ss','85.000','-t','25.500','-i','v.mpg']);
  const f=g.filters.join(';');
  assert.match(f,/\[3:v\]trim=start=6\.4000:end=16\.4000,setpts=PTS-STARTPTS/);
  assert.match(f,/\[4:v\]trim=start=101\.4000:end=111\.4000.*hue=s=0/);
  assert.match(f,/xfade=transition=fade:duration=0\.500:offset=9\.500/);
  assert.match(f,/xfade=transition=fade:duration=0\.500:offset=19\.000/);
  // audio: los fragmentos con fundido después pierden 0.5 s al final → suenan justo cuando aparecen
  assert.match(f,/\[3:a\]atrim=start=6\.4000:end=15\.9000/);
  assert.match(f,/\[4:a\]atrim=start=101\.4000:end=110\.9000,asetpts=PTS-STARTPTS,volume=0/);
  assert.match(f,/\[5:a\]atrim=start=201\.4000:end=211\.4000/);
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

test('lee la energía del audio de la salida de ffmpeg (astats)',()=>{
  const log='frame:0 pts:0 pts_time:0\nlavfi.astats.Overall.RMS_level=-23.5\nframe:1 pts:16000 pts_time:1\nlavfi.astats.Overall.RMS_level=-inf\n';
  assert.deepEqual(T.parseEnergyLog(log),[{t:0,db:-23.5},{t:1,db:-120}]);
});

test('lo que el video final quitó: huecos entre los clips (y solo los largos se evitan)',()=>{
  const keep=[{start:10,end:20},{start:20.5,end:40},{start:100,end:120}];
  assert.deepEqual(T.removedRanges(keep,130),[{start:0,end:10},{start:20,end:20.5},{start:40,end:100},{start:120,end:130}]);
  assert.deepEqual(T.avoidRanges(keep,130),[{start:0,end:10},{start:40,end:100},{start:120,end:130}]);
  assert.deepEqual(T.mergeRanges([{start:5,end:6},{start:1,end:2},{start:1.5,end:3}]),[{start:1,end:3},{start:5,end:6}]);
});

test('silencio de groserías dentro de un fragmento: mismo margen 0.15 s, tiempos relativos, sin bip',()=>{
  const r=[{start:105,end:106},{start:300,end:301}];
  assert.equal(T.muteFilter(r,100,110),",volume=enable='between(t,4.850,6.150)':volume=0");
  assert.equal(T.muteFilter(r,200,210),'');
  assert.doesNotMatch(T.muteFilter(r,100,110),/sine|beep/);
  // muchas groserías → varios filtros de 20 (para no agotar memoria)
  const many=Array.from({length:45},(_,i)=>({start:100+i*0.2,end:100+i*0.2+0.1}));
  assert.equal((T.muteFilter(many,100,110).match(/volume=enable/g)||[]).length,3);
});

test('sin resumen del directo usa la ENERGÍA del audio (antes que la transcripción)',()=>{
  const energy=[]; for(let t=0;t<600;t++) energy.push({t,db:(t>=300&&t<330)?-8:-35});
  const tr=[]; for(let t=0;t<600;t+=5) tr.push({start:t,end:t+4,text:'¡jajaja no mames!'}); // la transcripción no decide
  const m=T.pickMoments({energy,transcript:tr,duration:600,count:3});
  assert.equal(m[0].source,'energy');
  assert.ok(m[0].start>=295 && m[0].end<=335,'el momento más fuerte es el del grito');
  for(let i=0;i<m.length;i++) for(let j=i+1;j<m.length;j++) assert.ok(m[i].end+30<=m[j].start||m[j].end+30<=m[i].start,'separados');
});

test('energyMoments aguanta un directo de 6 h rápido',()=>{
  const energy=Array.from({length:6*3600},(_,t)=>({t,db:-30+10*Math.sin(t/97)}));
  const t0=Date.now(); const m=T.energyMoments(energy,6*3600); assert.ok(m.length>1000); assert.ok(Date.now()-t0<2000);
});

test('ninguna ventana libre → el momento se salta (no enseña lo que se quitó)',()=>{
  assert.equal(T.strongestWindow([{t:5,db:-10}],0,12,10,[{start:0,end:12}]),null);
  const p=T.planTeaser({moments:[{start:0,end:12},{start:100,end:140}],energyOf:()=>[],avoid:[{start:0,end:12}],fragLen:10});
  assert.deepEqual(p.fragments.map(f=>[f.start,f.end]),[[115,125]]);
});

test('plan completo: usa bestof y NO toma fragmentos de lo que el video quitó',()=>{
  const candidates=[{start:100,end:160,score:10},{start:400,end:460,score:9},{start:800,end:860,score:8}];
  const energy=[]; for(let t=0;t<1000;t++) energy.push({t,db:(t>=120&&t<130)?-5:-30});
  const keep=[{start:0,end:300},{start:700,end:1000}]; // 300..700 no sale en el video
  const p=T.buildPlan({candidates,energy,duration:1000,keep});
  assert.ok(p.fragments.length>=2);
  assert.ok(p.fragments.every(f=>f.end<=300||f.start>=700),'nada de 300..700');
  assert.ok(p.fragments.some(f=>Math.min(f.end,130)-Math.max(f.start,120)>=9),'el grito de 120-130 entra');
  assert.equal(p.fragments.length,6,'completa con la energía hasta 6');
  assert.ok(p.fragments.every(f=>Math.abs((f.end-f.start)-10)<1e-6));
});

test('audio del avance: misma frecuencia/canales que el video y largo EXACTO al de la imagen',()=>{
  const frags=[{start:5,end:15},{start:100,end:110}];
  const g=T.buildTeaserGraph({frags,firstInput:0,videoPath:'v.ts',fps:60,width:1920,height:1080,sampleRate:44100,layout:'mono'});
  const f=g.filters.join(';');
  assert.match(f,/aresample=44100,aformat=sample_fmts=fltp:channel_layouts=mono,apad,atrim=end=19\.500\[tza\]/);
  assert.doesNotMatch(f,/stereo/);
  assert.match(T.prependFilter(g,'[v]','[a]',{fps:60}).join(';'),/\[v\]settb=AVTB,fps=60,format=yuv420p,setsar=1\[tzomv\]/);
});

test('IA: lee el avance propuesto (absoluto, relativo, texto m:ss) y rechaza lo que no sirve', () => {
  const m = { start: 3600, end: 3690 };
  assert.deepEqual(T.readAvance({ inicio: 3620, fin: 3628.5, por_que: 'el grito' }, m), { start: 3620, end: 3628.5, why: 'el grito' });
  assert.deepEqual(T.readAvance({ inicio: 20, fin: 28 }, m), { start: 3620, end: 3628, why: '' }); // relativo al momento
  assert.deepEqual(T.readAvance({ inicio: '1:00:20', fin: '1:00:27' }, m), { start: 3620, end: 3627, why: '' });
  assert.equal(T.readAvance({ inicio: 3620, fin: 3622 }, m), null); // muy corto
  assert.equal(T.readAvance({ inicio: 3620, fin: 3640 }, m), null); // muy largo
  assert.equal(T.readAvance({ inicio: 100, fin: 108 }, m), null); // fuera del momento
  assert.equal(T.readAvance({ inicio: 'x', fin: null }, m), null);
  assert.equal(T.readAvance(null, m), null);
  assert.equal(T.readAvance('3620-3628', m), null);
  // Momento al inicio del directo (30–120 s): 25–33 es ABSOLUTO (no relativo → no 55–63); 31–39 absoluto se respeta.
  const m0 = { start: 30, end: 120 };
  assert.equal(T.readAvance({ inicio: 25, fin: 33 }, m0), null);
  assert.deepEqual(T.readAvance({ inicio: 31, fin: 39 }, m0), { start: 31, end: 39, why: '' });
  assert.deepEqual(T.readAvance({ inicio: 10, fin: 18 }, m0), { start: 40, end: 48, why: '' }); // ambos antes del inicio → relativo
});

test('IA: afina el final con las últimas palabras y el inicio al empezar una frase', () => {
  const m = { start: 1000, end: 1090 };
  const tr = [{ start: 1018.4, end: 1022, text: 'oye wey mira eso' }, { start: 1022, end: 1027.3, text: '¿Qué es eso? ¡No manches!' }, { start: 1027.3, end: 1031, text: 'era un perro jajaja' }];
  const av = T.refineAvance({ start: 1020, end: 1030, why: 'sorpresa' }, tr, m, 'que es eso no manches');
  assert.deepEqual(av, { start: 1018.4, end: 1027.3, why: 'sorpresa' }); // corta antes del remate ("era un perro")
  assert.deepEqual(T.refineAvance({ start: 1020, end: 1030, why: '' }, [], m, 'x'), { start: 1020, end: 1030, why: '' });
});

test('IA: el plan usa el avance de la IA y, si falta o cae en algo quitado, la energía', () => {
  const cands = [{ start: 100, end: 170, score: 9, gancho: 'A', avance: { inicio: 120, fin: 128, por_que: 'grito' } }, { start: 400, end: 470, score: 8, gancho: 'B', avance: { inicio: 'roto' } }];
  const p = T.buildPlan({ candidates: cands, energy: [], transcript: [], duration: 600 });
  assert.equal(p.fragments[0].source, 'ia'); assert.equal(p.fragments[0].start, 120); assert.equal(p.fragments[0].end, 128); assert.equal(p.fragments[0].why, 'grito');
  assert.notEqual(p.fragments[1].source, 'ia');
  const p2 = T.buildPlan({ candidates: cands, energy: [], transcript: [], duration: 600, keep: [{ start: 0, end: 121 }, { start: 140, end: 600 }] });
  assert.ok(p2.fragments.every(f => f.source !== 'ia'), 'si el video quitó parte del avance de la IA, no se usa');
});
