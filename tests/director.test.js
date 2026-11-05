'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {direct}=require('../lib/director');

const W=1920,H=1080,CROP=606; // recorte 9:16 de un video 1080p
const fps=5;
// Escena: personas A (izq, x=.2) y B (der, x=.75). talk(t) dice quién mueve la boca.
function scene(dur,talk,{ax=.2,bx=.75,withB=true}={}){
  const frames=[];
  for(let i=0;i<dur*fps;i++){
    const t=i/fps, who=talk(t);
    const mouth=(name)=> who===name ? 0.03+0.05*Math.abs(Math.sin(t*9)) : 0.004;
    const people=[{hx:ax,hy:.35,sw:.14}]; const faces=[{cx:ax,cy:.36,w:.1,mouth:mouth('A')}];
    if(withB){ people.push({hx:bx,hy:.33,sw:.12}); faces.push({cx:bx,cy:.34,w:.09,mouth:mouth('B')}); }
    frames.push({t,people,faces});
  }
  return frames;
}
const energy=dur=>Array.from({length:dur*10},(_,i)=>({t:i/10,db:-22}));
const centerAt=(r,t)=>{ let x=r.track[0].x; for(const p of r.track) if(p.t<=t) x=p.x; return (x+CROP/2)/W; };

test('sigue a quien habla y corta cuando habla el otro',()=>{
  const r=direct({frames:scene(20,t=>t<8?'A':'B'),energy:energy(20),dur:20,srcW:W,srcH:H});
  assert.ok(Math.abs(centerAt(r,4)-.2)<.06, 'al inicio encuadra a A: '+centerAt(r,4));
  assert.ok(Math.abs(centerAt(r,15)-.75)<.06, 'después encuadra a B: '+centerAt(r,15));
  assert.equal(r.shots.length,2);
  assert.ok(r.shots[1].start>=7.5 && r.shots[1].start<=8.5, 'el corte cae justo cuando B empieza (como un editor): '+r.shots[1].start);
});

test('el corte es seco (no se desliza de una persona a otra)',()=>{
  const r=direct({frames:scene(20,t=>t<8?'A':'B'),energy:energy(20),dur:20,srcW:W,srcH:H});
  const c=r.shots[1].start; const before=r.track.filter(p=>p.t<c).at(-1), after=r.track.find(p=>p.t>=c);
  assert.ok(after.t-before.t<=0.002, 'cambio instantáneo');
});

test('un "ajá" corto del otro NO provoca corte',()=>{
  const r=direct({frames:scene(20,t=>(t>=9&&t<9.4)?'B':'A'),energy:energy(20),dur:20,srcW:W,srcH:H});
  assert.equal(r.shots.length,1, JSON.stringify(r.shots));
  assert.ok(Math.abs(centerAt(r,10)-.2)<.06);
});

test('sin voz no corta aunque se mueva la boca (está comiendo, no hablando)',()=>{
  const quiet=Array.from({length:200},(_,i)=>({t:i/10,db:i<80?-22:-70}));
  const r=direct({frames:scene(20,t=>t<8?'A':'B'),energy:quiet,dur:20,srcW:W,srcH:H});
  assert.equal(r.shots.length,1);
});

test('si las dos personas caben juntas, encuadra a las dos',()=>{
  const r=direct({frames:scene(12,t=>t<6?'A':'B',{ax:.45,bx:.56}),energy:energy(12),dur:12,srcW:W,srcH:H});
  for(const t of [3,9]) assert.ok(Math.abs(centerAt(r,t)-.505)<.04, 'centro entre ambos: '+centerAt(r,t));
});

test('una sola persona que se mueve poco: cámara quieta (zona muerta)',()=>{
  const frames=scene(10,()=> 'A',{withB:false}).map((f,i)=>({...f,people:[{...f.people[0],hx:.4+.01*Math.sin(i)}],faces:[{...f.faces[0],cx:.4+.01*Math.sin(i)}]}));
  const r=direct({frames,energy:energy(10),dur:10,srcW:W,srcH:H});
  assert.ok(r.track.length<=3, 'pocos puntos = cámara quieta: '+r.track.length);
});

test('si casi no hay personas, avisa para usar el modo de respaldo',()=>{
  const frames=Array.from({length:50},(_,i)=>({t:i/5,people:[],faces:[]}));
  const r=direct({frames,energy:energy(10),dur:10,srcW:W,srcH:H});
  assert.equal(r.fallback,true);
});

test('el recorte nunca se sale del cuadro',()=>{
  const r=direct({frames:scene(10,()=> 'A',{ax:.02,withB:false}),energy:energy(10),dur:10,srcW:W,srcH:H});
  assert.ok(r.track.every(p=>p.x>=0 && p.x<=W-CROP));
});

test('dos personas lejos que se responden rápido → pantalla dividida (izquierda arriba)',()=>{
  const talk=t=> t<4?'A' : t>=16?'B' : (Math.floor((t-4)/2.2)%2===0?'B':'A');
  const r=direct({frames:scene(24,talk,{ax:.15,bx:.85}),energy:energy(24),dur:24,srcW:W,srcH:H});
  assert.ok(r.splits.length>=1, JSON.stringify(r.shots));
  const s=r.splits[0];
  assert.ok(s.top.x<s.bottom.x, 'la persona de la izquierda va arriba');
  assert.ok(s.start>=3 && s.end<=18.5, 'solo durante el ida y vuelta: '+s.start+'-'+s.end);
  assert.ok(r.shots.some(x=>x.layout==='split'));
});

test('si caben juntas NO se divide (se usa toma de dos)',()=>{
  const talk=t=> Math.floor(t/2.2)%2===0?'A':'B';
  const r=direct({frames:scene(20,talk,{ax:.45,bx:.56}),energy:energy(20),dur:20,srcW:W,srcH:H});
  assert.equal(r.splits.length,0);
});

test('respuestas largas (cada quien habla varios segundos) NO se dividen',()=>{
  const r=direct({frames:scene(20,t=>t<8?'A':'B',{ax:.15,bx:.85}),energy:energy(20),dur:20,srcW:W,srcH:H});
  assert.equal(r.splits.length,0);
});

test('cambio manual: forzar a una persona en un tramo',()=>{
  const base=direct({frames:scene(20,()=> 'A'),energy:energy(20),dur:20,srcW:W,srcH:H});
  const idB=base.people.find(p=>p.x>.5).id;
  const r=direct({frames:scene(20,()=> 'A'),energy:energy(20),dur:20,srcW:W,srcH:H,overrides:[{start:5,end:10,mode:'person',id:idB}]});
  assert.ok(Math.abs(centerAt(r,7)-.75)<.06, 'en 5-10 s sale B: '+centerAt(r,7));
  assert.ok(Math.abs(centerAt(r,15)-.2)<.06, 'fuera del tramo vuelve a A');
});

test('cambio manual: pantalla dividida en un tramo y lista de personas para la vista previa',()=>{
  const r=direct({frames:scene(20,()=> 'A'),energy:energy(20),dur:20,srcW:W,srcH:H,overrides:[{start:4,end:9,mode:'split'}]});
  assert.equal(r.splits.length,1); assert.equal(r.splits[0].start,4); assert.equal(r.splits[0].end,9);
  assert.equal(r.people.length,2); assert.ok(r.people.every(p=>Number.isFinite(p.t)&&p.size>0));
});

test('sonreír o reírse con la boca abierta NO cuenta como hablar (caso real)',()=>{
  // A habla (boca que abre y cierra); B sonríe todo el tiempo con la boca abierta casi fija.
  const frames=scene(20,()=> 'A').map(f=>({...f,faces:[f.faces[0],{...f.faces[1],mouth:0.055+0.003*Math.sin(f.t*2)}]}));
  const r=direct({frames,energy:energy(20),dur:20,srcW:W,srcH:H});
  assert.equal(r.shots.length,1, JSON.stringify(r.shots));
  assert.ok(Math.abs(centerAt(r,10)-.2)<.06, 'se queda con quien habla');
});

test('si a quien habla se le tapa la cara (letrero, agacha la cabeza) la cámara NO se va con el que está callado',()=>{
  const frames=scene(20,()=> 'A').map(f=> (f.t>=6&&f.t<11) ? ({...f,people:[f.people[1]],faces:[f.faces[1]]}) : f);
  const r=direct({frames,energy:energy(20),dur:20,srcW:W,srcH:H});
  assert.ok(Math.abs(centerAt(r,8.5)-.2)<.06, 'mantiene la toma de A aunque no se le vea: '+centerAt(r,8.5));
  assert.equal(r.shots.length,1, JSON.stringify(r.shots));
});

test('cámara estable: el temblor del detector no la mueve y los tiempos van en orden (caso real que tronaba ffmpeg)',()=>{
  let seed=3; const rnd=()=>(seed=(seed*16807)%2147483647)/2147483647;
  const frames=scene(40,t=>Math.floor(t/3)%2?'A':'B',{ax:.3,bx:.7}).map(f=>({...f,
    people:f.people.map(p=>({...p,hx:p.hx+(rnd()-.5)*.06})), faces:f.faces.map(p=>({...p,cx:p.cx+(rnd()-.5)*.06}))}));
  const r=direct({frames,energy:energy(40),dur:40,srcW:W,srcH:H});
  assert.ok(r.track.every((p,i)=>i===0||p.t>p.track?.t||p.t>=r.track[i-1].t), 'tiempos en orden');
  assert.ok(r.track.length<=60, 'expresión corta para ffmpeg: '+r.track.length);
});

test('sin nadie a quién encuadrar → toma abierta (imagen completa), no un recorte vacío',()=>{
  const frames=scene(20,()=> 'A',{withB:false}).map(f=> (f.t>=8&&f.t<13) ? ({...f,people:[],faces:[]}) : f);
  const r=direct({frames,energy:energy(20),dur:20,srcW:W,srcH:H});
  assert.ok(r.wides.length>=1, JSON.stringify(r.shots));
  const w=r.wides[0]; assert.ok(w.start<=9.5 && w.end>=12, 'cubre el hueco: '+w.start+'-'+w.end);
  assert.ok(r.shots.some(s=>s.layout==='wide'));
});
test('cambio manual a toma abierta',()=>{
  const r=direct({frames:scene(20,()=> 'A'),energy:energy(20),dur:20,srcW:W,srcH:H,overrides:[{start:3,end:7,mode:'wide'}]});
  assert.deepEqual(r.wides,[{start:3,end:7}]);
});
