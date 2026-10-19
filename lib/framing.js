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

module.exports={detectSubjectX,smoothTrack,cropExpression,zoomExpression};
