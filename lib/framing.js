'use strict';

function skin(r,g,b) {
  if (r < 65 || g < 30 || b < 15 || r < g*1.05 || r < b*1.12) return false;
  const cb=128-.168736*r-.331264*g+.5*b;
  const cr=128+.5*r-.418688*g-.081312*b;
  return cb>=77 && cb<=127 && cr>=133 && cr<=173;
}

function detectSubjectX(rgb,width,height) {
  const step=2,w=Math.floor(width/step),h=Math.floor(height/step),mask=new Uint8Array(w*h),seen=new Uint8Array(w*h);
  for(let y=0;y<h;y++) for(let x=0;x<w;x++) {
    const i=((y*step)*width+x*step)*3;
    if(skin(rgb[i],rgb[i+1],rgb[i+2])) mask[y*w+x]=1;
  }
  let best=null;
  const queue=new Int32Array(w*h);
  for(let i=0;i<mask.length;i++) {
    if(!mask[i]||seen[i]) continue;
    let head=0,tail=1,area=0,minX=w,maxX=0,minY=h,maxY=0,sumX=0;
    queue[0]=i;seen[i]=1;
    while(head<tail) {
      const at=queue[head++],x=at%w,y=Math.floor(at/w);
      area++;sumX+=x;minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y);
      for(const n of [at-1,at+1,at-w,at+w]) {
        if(n<0||n>=mask.length||Math.abs(n%w-x)+Math.abs(Math.floor(n/w)-y)!==1||!mask[n]||seen[n]) continue;
        seen[n]=1;queue[tail++]=n;
      }
    }
    const bw=maxX-minX+1,bh=maxY-minY+1,aspect=bw/bh,density=area/(bw*bh),cy=(minY+maxY)/2;
    if(area<28||area>2600||bw<5||bh<6||aspect<.38||aspect>2.2||density<.24||cy>h*.76) continue;
    const score=area*Math.min(1,density/.5)*(1-cy/h*.35);
    if(!best||score>best.score) best={x:(sumX/area+.5)/w,score,area};
  }
  return best;
}

function smoothTrack(observations,sourceWidth,sourceHeight) {
  const cropWidth=Math.min(sourceWidth,sourceHeight*9/16);
  const maxLeft=Math.max(0,sourceWidth-cropWidth);
  const reliable=observations.filter(p=>p.subject && p.subject.score>=350);
  const hits=reliable.length;
  const jumps=reliable.slice(1).filter((p,i)=>Math.abs(p.subject.x-reliable[i].subject.x)>.3).length;
  if(observations.length<3||hits/observations.length<.55||jumps>Math.max(1,Math.floor((hits-1)*.18))||maxLeft<20) return null;
  const track=[];
  let center=observations[0].subject?.score>=350?observations[0].subject.x:.5;
  for(const point of observations) {
    const target=point.subject?.score>=350?point.subject.x:.5;
    center+=Math.max(-.22,Math.min(.22,(target-center)*.75));
    const left=Math.max(0,Math.min(maxLeft,center*sourceWidth-cropWidth/2));
    track.push({t:+point.t.toFixed(2),x:+left.toFixed(1)});
  }
  return {track,cropWidth:Math.floor(cropWidth/2)*2,confidence:+(hits/observations.length).toFixed(2)};
}

function cropExpression(track) {
  if(!track?.length) return '(iw-ow)/2';
  let expr=String(track.at(-1).x);
  for(let i=track.length-2;i>=0;i--) {
    const a=track[i],b=track[i+1],delta=+(b.x-a.x).toFixed(1),span=+(b.t-a.t).toFixed(2);
    if(span<=0) continue;
    expr=`if(lt(t\\,${b.t})\\,${a.x}+(${delta})*(t-${a.t})/${span}\\,${expr})`;
  }
  return expr;
}

function zoomExpression(words,start,end) {
  const cues=/(?:[!?¡¿]|\b(?:mira|espera|increíble|no mames|qué pasó|sorpresa)\b)/i;
  const events=[];
  for(const word of words) {
    if(word.start<start+5||word.start>end-4||!cues.test(word.text)) continue;
    const at=+(word.start-start).toFixed(1);
    if(events.every(e=>Math.abs(e-at)>=9)) events.push(at);
    if(events.length>=6) break;
  }
  if(!events.length) for(let at=12;at<end-start-5&&events.length<4;at+=18) events.push(at);
  const pulses=events.map(at=>`max(0\\,1-abs(on/30-${at})/2.2)`);
  return pulses.length?`1+0.09*${pulses.reduce((a,b)=>`max(${a}\\,${b})`)}`:'1';
}

// ===== ZOOMS ESTILO OPUS =====
// En vez de zooms al azar (signos ¿!), los "golpes" de zoom salen donde la VOZ sube de verdad (gritos, risas, remates):
// energía del audio cada 0.1 s → picos sostenidos ≥0.3 s sobre el nivel normal de voz del clip.
// Entrada rápida (punch), se mantiene mientras dura el momento, salida suave. Separados ≥4 s y máx. ~1 cada 7 s.
function median(a){ const s=[...a].sort((x,y)=>x-y); return s.length?s[s.length>>1]:0; }
function planZooms(energy, dur, opts={}) {
  const minGap=opts.minGap??4, rise=opts.rise??6, minLen=opts.minLen??0.3, amount=opts.amount??0.14;
  if(!Array.isArray(energy)||energy.length<10||!(dur>6)) return [];
  const step=energy.length>1?Math.max(0.05,energy[1].t-energy[0].t):0.1;
  // Suavizado de 0.3 s para que un golpe de un solo cuadro (aplauso, golpe al micro) no cuente.
  const db=energy.map((_,i)=>{ let s=0,n=0; for(let k=-1;k<=1;k++){ const e=energy[i+k]; if(e&&Number.isFinite(e.db)){s+=e.db;n++;} } return n?s/n:-90; });
  const speech=db.filter(x=>x>-50);
  if(speech.length<energy.length*0.2) return [];
  const base=median(speech), thr=base+rise;
  const runs=[]; let s=-1;
  for(let i=0;i<=db.length;i++){
    const on=i<db.length&&db[i]>=thr;
    if(on&&s<0) s=i;
    if(!on&&s>=0){ const a=energy[s].t, b=energy[i-1].t+step; if(b-a>=minLen) { let peak=-90; for(let k=s;k<i;k++) peak=Math.max(peak,db[k]); runs.push({start:a,end:b,peak}); } s=-1; }
  }
  // Los más fuertes primero; respeta separación y un máximo por duración; evita el primer segundo y los últimos 1.5 s.
  const maxN=Math.max(1,Math.floor(dur/7));
  const picked=[];
  for(const r of runs.sort((x,y)=>y.peak-x.peak)){
    if(r.start<1||r.start>dur-1.5) continue;
    if(picked.some(p=>Math.abs(p.start-r.start)<minGap)) continue;
    picked.push(r); if(picked.length>=maxN) break;
  }
  return picked.sort((a,b)=>a.start-b.start).map(r=>{
    const start=Math.max(0,r.start-0.12); // entra un pelo ANTES del grito: se siente intencional
    const hold=Math.min(3,Math.max(1.2,r.end-r.start));
    const strength=Math.min(1,0.65+(r.peak-thr)/12);
    return {start:+start.toFixed(2), end:+Math.min(dur-0.6,start+hold).toFixed(2), amount:+(amount*strength).toFixed(3)};
  });
}
// Expresión de zoom Z(t) para ffmpeg: acercamiento lento de fondo (1.00→1.04) + golpes con curva suave (smoothstep).
// Sin comas sueltas: se usa \, para que el parser de filtros de ffmpeg no las tome como separadores.
function zoomCurve(punches, dur, opts={}) {
  const drift=opts.drift??0.04, inT=opts.inT??0.22, outT=opts.outT??0.5;
  const sm=x=>`(${x})*(${x})*(3-2*(${x}))`;
  const cl=x=>`clip(${x}\\,0\\,1)`;
  const parts=[`1+${drift}*t/${Math.max(1,dur).toFixed(2)}`];
  for(const p of punches||[]){
    const up=cl(`(t-${p.start})/${inT}`), down=cl(`(t-${p.end})/${outT}`);
    parts.push(`${p.amount}*${sm(up)}*(1-${sm(down)})`);
  }
  return parts.join('+');
}
// Filtro de zoom SIN temblor: escala con factor decimal en cada cuadro (lanczos) y recorta al tamaño final.
// (zoompan redondea la posición a pixeles enteros del original → "tiembla"; esto no.) fy = dónde apunta en vertical:
// 0.5 = centro; 0.38 = un poco arriba, donde suelen estar las caras.
function zoomFilter(OW,OH,zexpr,fy=0.38) {
  if(!zexpr||zexpr==='1') return `scale=${OW}:${OH}:flags=lanczos`;
  return `scale=w='trunc(${OW}*(${zexpr})/2)*2':h='trunc(${OH}*(${zexpr})/2)*2':eval=frame:flags=lanczos,crop=${OW}:${OH}:x='(iw-ow)/2':y='(ih-oh)*${fy}'`;
}

module.exports={detectSubjectX,smoothTrack,cropExpression,zoomExpression,planZooms,zoomCurve,zoomFilter};
