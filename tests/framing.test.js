'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const {detectSubjectX,smoothTrack,cropExpression,zoomExpression}=require('../lib/framing');

test('el encuadre sigue una zona visible y vuelve al fondo si no hay detección fiable',()=>{
  const width=320,height=180,rgb=Buffer.alloc(width*height*3,90);
  for(let y=30;y<90;y++)for(let x=48;x<108;x++){const i=(y*width+x)*3;rgb[i]=205;rgb[i+1]=145;rgb[i+2]=115}
  const subject=detectSubjectX(rgb,width,height);
  assert.ok(subject?.score>350);
  assert.ok(subject.x>.2&&subject.x<.3);
  assert.equal(detectSubjectX(Buffer.alloc(width*height*3,90),width,height),null);
  assert.equal(smoothTrack([{t:0,subject:null},{t:3,subject:null},{t:6,subject}],1920,1080),null);
  const track=smoothTrack([{t:0,subject},{t:3,subject},{t:6,subject}],1920,1080);
  assert.equal(track.track.length,3);
  assert.ok(track.track.every(p=>p.x>=0&&p.x<=1920-608));
});

test('FFmpeg acepta el recorte móvil y el zoom local', {skip:!process.env.EDITOR_IRL_TEST_FFMPEG},()=>{
  const ffmpeg=process.env.EDITOR_IRL_TEST_FFMPEG;
  const track=[{t:0,x:500},{t:1,x:600},{t:2,x:700}];
  const zoom=zoomExpression([{start:6,text:'¡Mira!'}],0,12);
  const filter=`[0:v]crop=w=608:h=1080:x='${cropExpression(track)}':y=0,zoompan=z='${zoom}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=720x1280:fps=30[v]`;
  const out=spawnSync(ffmpeg,['-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc2=size=1920x1080:rate=30:duration=2','-filter_complex',filter,'-map','[v]','-frames:v','30','-f','null','-'],{encoding:'utf8',windowsHide:true,timeout:30000});
  assert.equal(out.status,0,out.stderr);
  const blur=`[0:v]fps=30,split=2[bg][fg];[bg]scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,boxblur=15:2[back];[fg]scale=720:-2,zoompan=z='${zoom}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=720x406:fps=30[front];[back][front]overlay=(W-w)/2:(H-h)/2[v]`;
  const fallback=spawnSync(ffmpeg,['-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc2=size=1920x1080:rate=30:duration=2','-filter_complex',blur,'-map','[v]','-frames:v','30','-f','null','-'],{encoding:'utf8',windowsHide:true,timeout:30000});
  assert.equal(fallback.status,0,fallback.stderr);
});

const {planZooms,zoomCurve,zoomFilter}=require('../lib/framing');
function fakeEnergy(dur,loud){ const e=[]; for(let t=0;t<dur;t+=0.1){ const inLoud=loud.some(([a,b])=>t>=a&&t<b); e.push({t:+t.toFixed(1),db:inLoud?-14:-28+Math.sin(t*7)*1.5}); } return e; }
test('los zooms caen donde la voz sube (gritos), no al azar',()=>{
  const z=planZooms(fakeEnergy(40,[[10,11.5],[25,26]]),40);
  assert.equal(z.length,2);
  assert.ok(Math.abs(z[0].start-10)<0.3 && Math.abs(z[1].start-25)<0.3, JSON.stringify(z));
  assert.ok(z.every(p=>p.end-p.start>=1.19 && p.amount>0.05 && p.amount<=0.14));
});
test('sin gritos no inventa zooms y un golpe de un cuadro no cuenta',()=>{
  assert.deepEqual(planZooms(fakeEnergy(30,[]),30),[]);
  assert.deepEqual(planZooms(fakeEnergy(30,[[12,12.1]]),30),[]);
});
test('respeta separación mínima y un máximo por duración',()=>{
  const loud=[]; for(let t=3;t<28;t+=2) loud.push([t,t+0.6]);
  const z=planZooms(fakeEnergy(30,loud),30);
  assert.ok(z.length<=Math.floor(30/7));
  for(let i=1;i<z.length;i++) assert.ok(z[i].start-z[i-1].start>=3.8);
});
test('el filtro de zoom es suave (sin zoompan) y sin zooms queda solo el escalado',()=>{
  const f=zoomFilter(1080,1920,zoomCurve([{start:5,end:7,amount:0.12}],30));
  assert.match(f,/eval=frame/); assert.doesNotMatch(f,/zoompan/); assert.match(f,/crop=1080:1920/);
  assert.equal(zoomFilter(1080,1920,'1'),'scale=1080:1920:flags=lanczos');
});
