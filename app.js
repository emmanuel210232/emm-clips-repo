'use strict';
const $ = id => document.getElementById(id);
// Tema (oscuro estilo CapCut por defecto; se puede cambiar y recuerda la elección).
(function(){let t;try{t=localStorage.getItem('eirl_theme');}catch{}document.documentElement.dataset.theme=(t==='light'?'light':'dark');})();
function applyThemeIcon(){const b=$('themeToggle');if(b)b.textContent=document.documentElement.dataset.theme==='dark'?'☀️':'🌙';}
function toggleTheme(){const cur=document.documentElement.dataset.theme==='dark'?'dark':'light';const next=cur==='dark'?'light':'dark';document.documentElement.dataset.theme=next;try{localStorage.setItem('eirl_theme',next);}catch{}applyThemeIcon();}
let state = null;
let selected = new Set();
let selectedPauses = new Set();
let lastVideo = '';
let lastSourceVideo = '';
let lastJob = '';
let matchFingerprint = '';
let autoPrepKey = ''; // evita volver a auto-preparar el mismo video
let selectionHydrated = false;
let selectionSave = Promise.resolve();
let playerSourceOffset = 0;
let playerIsCutPreview = false;
function sourcePlayerTime() { if(playerIsCutPreview) throw Error('Abre el video original o un fragmento sin cortar para tomar su tiempo.'); return $('video').currentTime+playerSourceOffset; }
function persistSelection() {
  const snapshot={selectedIds:[...selected],selectedPauseIds:[...selectedPauses]};
  selectionSave=selectionSave.catch(()=>{}).then(()=>api('/api/cuts/selection',snapshot));
  selectionSave.catch(e=>notice('No se pudo guardar la selección: '+e.message,true));
  return selectionSave;
}
function notice(message, bad=false) { const el=$('notice'); el.hidden=!message; el.textContent=message||''; el.className='notice'+(bad?' error':''); }
async function api(url, data) { const res=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)}); const body=await res.json(); if(!res.ok)throw Error(body.error||'Error inesperado'); return body; }
async function upload(url,file) { const res=await fetch(url+'?name='+encodeURIComponent(file.name),{method:'POST',headers:{'content-type':'application/octet-stream'},body:file});const body=await res.json();if(!res.ok)throw Error(body.error||'Error al subir archivo');return body; }
async function refresh() { const res=await fetch('/api/state'); state=await res.json(); render(); }
function fmt(t) { const n=Math.max(0,Math.floor(t));return `${String(Math.floor(n/3600)).padStart(2,'0')}:${String(Math.floor(n%3600/60)).padStart(2,'0')}:${String(n%60).padStart(2,'0')}`; }
async function playAt(at,length) {
  const v=$('video');
  v.parentElement.classList.add('ready');
  if(!state.project?.previewPath && /\.(mpg|mpeg|mkv|avi)$/i.test(state.project?.videoPath||'')) {
    notice('Preparando fragmento de revisión…');
    const clip=await api('/api/review-clip',{at,length});
    playerSourceOffset=at-clip.seek;playerIsCutPreview=false;
    v.src=clip.url;
    v.ontimeupdate=null;
    v.onloadedmetadata=()=>{v.currentTime=Math.max(0,length?clip.seek:clip.seek-1);v.play().catch(()=>{});notice('');};
  } else {
    playerSourceOffset=0;playerIsCutPreview=false;
    v.src='/api/video?d='+Date.now();
    v.ontimeupdate=length?()=>{if(v.currentTime>=at+length)v.pause();}:null;
    v.onloadedmetadata=()=>{v.currentTime=Math.max(0,length?at:at-1);v.play().catch(()=>{});notice('');};
  }
  v.scrollIntoView({behavior:'smooth',block:'center'});
}
function addCaptionEditor(row,s) {
  const details=document.createElement('details');details.className='captionEditor';
  const summary=document.createElement('summary');summary.textContent=`Corregir subtítulos (${(s.captionCorrections||[]).length})`;
  const hint=document.createElement('p');hint.textContent='Escribe la frase tal como aparece y el texto correcto. Se reemplazará en este Short al volver a crearlo.';
  const fields=document.createElement('div');fields.className='captionFields';
  const from=document.createElement('input');from.type='text';from.maxLength=100;from.placeholder='Texto detectado';from.setAttribute('aria-label',`Texto detectado en Short ${s.rank}`);
  const to=document.createElement('input');to.type='text';to.maxLength=100;to.placeholder='Texto correcto';to.setAttribute('aria-label',`Texto correcto en Short ${s.rank}`);
  const save=document.createElement('button');save.className='secondary';save.textContent='Agregar corrección';
  save.onclick=safe(async()=>{await api('/api/shorts/captions',{id:s.id,corrections:[...(s.captionCorrections||[]),{from:from.value,to:to.value}]});notice('Corrección guardada. Vuelve a crear el Short para verla.');});
  fields.append(from,to,save);
  const list=document.createElement('div');list.className='captionCorrectionList';
  (s.captionCorrections||[]).forEach((correction,i)=>{const entry=document.createElement('div');entry.className='captionCorrection';const label=document.createElement('span');label.textContent=`${correction.from} → ${correction.to}`;const remove=document.createElement('button');remove.className='delete';remove.textContent='×';remove.title='Quitar corrección';remove.onclick=safe(async()=>{await api('/api/shorts/captions',{id:s.id,corrections:s.captionCorrections.filter((_,j)=>j!==i)});notice('Corrección quitada.');});entry.append(label,remove);list.append(entry);});
  details.append(summary,hint,fields,list);row.insertBefore(details,row.querySelector('.shortActions'));
}
function addShortControls(row,s) {
  const details=document.createElement('details');details.className='shortControls';
  const summary=document.createElement('summary');summary.textContent='Ajustar inicio, final y encuadre';
  const timing=document.createElement('div');timing.className='shortControlRow';
  const start=document.createElement('input');start.type='number';start.min='0';start.step='.1';start.value=s.start.toFixed(1);start.setAttribute('aria-label',`Inicio del Short ${s.rank} en segundos`);
  const end=document.createElement('input');end.type='number';end.min='0';end.step='.1';end.value=s.end.toFixed(1);end.setAttribute('aria-label',`Final del Short ${s.rank} en segundos`);
  const saveTiming=document.createElement('button');saveTiming.className='secondary';saveTiming.textContent='Guardar tiempos';
  saveTiming.onclick=safe(async()=>{await api('/api/shorts/timing',{id:s.id,start:Number(start.value),end:Number(end.value)});notice('Inicio y final guardados. Revisa el clip completo.');});
  const startLabel=document.createElement('label');startLabel.textContent='Inicio (s)';startLabel.append(start);
  const endLabel=document.createElement('label');endLabel.textContent='Final (s)';endLabel.append(end);
  timing.append(startLabel,endLabel,saveTiming);
  const framing=document.createElement('div');framing.className='shortControlRow';
  const mode=document.createElement('select');for(const [value,label] of [['auto','Auto: buscar sujeto'],['manual','Manual: elegir posición'],['blur','Fondo desenfocado']]){const option=document.createElement('option');option.value=value;option.textContent=label;mode.append(option)}mode.value=s.framingMode||'auto';
  const center=document.createElement('input');center.type='range';center.min='0';center.max='100';center.value=String(Math.round((s.cropCenter??.5)*100));center.title='Izquierda ↔ derecha';center.setAttribute('aria-label',`Posición horizontal del Short ${s.rank}`);
  const centerLabel=document.createElement('label');centerLabel.textContent='Posición';centerLabel.append(center);
  const zoom=document.createElement('input');zoom.type='checkbox';zoom.checked=s.zoomEnabled!==false;
  const zoomLabel=document.createElement('label');zoomLabel.className='inlineCheck';zoomLabel.append(zoom,document.createTextNode(' Zooms suaves'));
  const styleSel=document.createElement('select');for(const cs of (state.captionStyles||[])){const o=document.createElement('option');o.value=cs.id;o.textContent=cs.label;styleSel.append(o);}styleSel.value=s.captionStyle||'verde';
  const styleLabel=document.createElement('label');styleLabel.textContent='Subtítulos';styleLabel.append(styleSel);
  const fmtSel=document.createElement('select');for(const [val,lbl] of [['vertical','Vertical 9:16 (Shorts)'],['square','Cuadrado 1:1'],['horizontal','Horizontal 16:9']]){const o=document.createElement('option');o.value=val;o.textContent=lbl;fmtSel.append(o);}fmtSel.value=s.format||'vertical';
  const fmtLabel=document.createElement('label');fmtLabel.textContent='Formato';fmtLabel.append(fmtSel);
  const save=document.createElement('button');save.className='secondary';save.textContent='Guardar estilo';
  const update=()=>{const vert=fmtSel.value==='vertical';mode.disabled=!vert;centerLabel.hidden=(mode.value!=='manual'||!vert);zoomLabel.hidden=mode.value==='blur'};mode.onchange=update;fmtSel.onchange=update;update();
  save.onclick=safe(async()=>{await api('/api/shorts/settings',{id:s.id,framingMode:mode.value,cropCenter:Number(center.value)/100,zoomEnabled:zoom.checked,captionStyle:styleSel.value,format:fmtSel.value});notice('Formato y estilo guardados. Vuelve a crear el Short para verlo.');});
  framing.append(mode,fmtLabel,styleLabel,centerLabel,zoomLabel,save);
  const hint=document.createElement('p');hint.textContent='Auto sigue zonas de piel visibles. Si pierde al sujeto, usa Manual o Fondo desenfocado. El recorte vertical se ve en el MP4 terminado.';
  details.append(summary,timing,framing,hint);row.insertBefore(details,row.querySelector('.shortActions'));
}
async function copyText(text,btn){
  try{ await navigator.clipboard.writeText(text); }
  catch{ try{const ta=document.createElement('textarea');ta.value=text;ta.style.position='fixed';ta.style.opacity='0';document.body.appendChild(ta);ta.select();document.execCommand('copy');ta.remove();}catch{notice('No se pudo copiar; selecciónalo a mano.',true);return;} }
  if(btn){const o=btn.textContent;btn.textContent='¡Copiado!';setTimeout(()=>btn.textContent=o,1200);}
}
function addMetaEditor(row,s){
  const details=document.createElement('details');details.className='metaEditor';
  const summary=document.createElement('summary');summary.textContent='📋 Título, descripción y # (IA)';
  const gen=document.createElement('button');gen.className='secondary';gen.textContent=s.meta?'Regenerar con IA':'Generar con IA';
  const out=document.createElement('div');out.className='metaOut';
  const renderMeta=(m)=>{out.replaceChildren();if(!m)return;
    const mk=(label,text)=>{const b=document.createElement('div');b.className='metaBlock';const head=document.createElement('div');head.className='metaHead';const h=document.createElement('span');h.className='metaLabel';h.textContent=label;const c=document.createElement('button');c.className='copyBtn';c.textContent='Copiar';c.type='button';c.onclick=()=>copyText(text,c);head.append(h,c);const p=document.createElement('div');p.className='metaText';p.textContent=text;b.append(head,p);return b;};
    const hashline='#'+(m.hashtags||[]).join(' #');
    out.append(mk('Título',m.titulo));
    out.append(mk('Descripción',m.descripcion+'\n\n'+hashline));
    out.append(mk('Solo hashtags',hashline));
  };
  gen.onclick=async()=>{try{gen.disabled=true;gen.textContent='Generando…';const r=await api('/api/shorts/metadata',{id:s.id});s.meta=r.meta;renderMeta(r.meta);gen.textContent='Regenerar con IA';notice('Título y descripción listos. Cópialos a YouTube.');}catch(e){notice(e.message,true);}finally{gen.disabled=false;}};
  if(s.meta)renderMeta(s.meta);
  details.append(summary,gen,out);row.insertBefore(details,row.querySelector('.shortActions'));
}
let tlZoom=1, tlDrag=false;
let tlCutMode=false, selStart=null, selEnd=null, selDragging=false;
let tlKeyMark=(()=>{try{return localStorage.getItem('eirl_cutkey')||'s';}catch{return 's';}})();
function tlInner(){const h=$('tlHead');return h&&h.parentElement;}
function tlXofTime(t){const inner=tlInner();const dur=tlDuration();if(!inner||!dur)return 0;return Math.max(0,Math.min(inner.offsetWidth,t/dur*inner.offsetWidth));}
function tlTimeFromX(clientX){const inner=tlInner();const dur=tlDuration();if(!inner||!dur)return 0;const r=inner.getBoundingClientRect();const x=Math.max(0,Math.min(inner.offsetWidth,clientX-r.left));return x/inner.offsetWidth*dur;}
function updateCutButtons(){
  const has=selStart!=null&&selEnd!=null&&Math.abs(selEnd-selStart)>=0.04;
  const del=$('tlDelSel');if(del)del.disabled=!has;
  const cm=$('tlCutMode');if(cm)cm.classList.toggle('active',tlCutMode);
  const mk=$('tlMark');if(mk)mk.textContent='⬇️ Marcar aquí ('+tlKeyMark.toUpperCase()+')';
  const n=(state?.manualCuts||[]).length;
  const info=$('tlCutInfo');if(info)info.textContent=n?(n+' '+(n===1?'tramo':'tramos')+' se quitará'+(n===1?'':'n')):(has?'Tramo: '+fmt(Math.min(selStart,selEnd))+'–'+fmt(Math.max(selStart,selEnd)):'');
  const go=$('tlGoCut');if(go)go.hidden=!n;
}
function refreshOverlays(){
  const inner=tlInner();if(!inner)return;
  inner.querySelectorAll('.tl-sel,.tl-cut').forEach(x=>x.remove());
  for(const c of (state?.manualCuts||[])){
    const el=document.createElement('div');el.className='tl-cut';
    el.style.left=tlXofTime(c.start)+'px';el.style.width=Math.max(3,tlXofTime(c.end)-tlXofTime(c.start))+'px';
    el.title=(c.label||'Corte')+' · '+fmt(c.start)+'–'+fmt(c.end)+'  (clic ✕ para quitar)';
    const x=document.createElement('button');x.className='tl-cutx';x.type='button';x.textContent='×';x.title='Conservar este tramo (quitar el corte)';
    x.onmousedown=ev=>ev.stopPropagation();
    x.onclick=ev=>{ev.stopPropagation();api('/api/cuts/manual/delete',{id:c.id}).then(()=>refresh()).catch(e=>notice(e.message,true));};
    el.append(x);inner.append(el);
  }
  if(selStart!=null&&selEnd!=null){
    const a=Math.min(selStart,selEnd),b=Math.max(selStart,selEnd);
    const el=document.createElement('div');el.className='tl-sel';
    el.style.left=tlXofTime(a)+'px';el.style.width=Math.max(2,tlXofTime(b)-tlXofTime(a))+'px';
    inner.append(el);
  }
  updateCutButtons();
}
function tlMark(){
  const v=$('video');const t=(v?.currentTime||0)+(playerSourceOffset||0);
  if(selStart==null||(selStart!=null&&selEnd!=null)){selStart=t;selEnd=null;notice('Inicio del tramo marcado en '+fmt(t)+'. Mueve el reproductor y marca de nuevo para el final.');}
  else {selEnd=t;const a=Math.min(selStart,selEnd),b=Math.max(selStart,selEnd);selStart=a;selEnd=b;notice('Tramo '+fmt(a)+'–'+fmt(b)+' listo. Pulsa “Quitar tramo” (o Supr) para eliminarlo.');}
  refreshOverlays();
}
function clearSelection(){selStart=null;selEnd=null;refreshOverlays();}
async function deleteSelection(){
  if(selStart==null||selEnd==null)return notice('Primero selecciona un tramo (Modo corte + arrastrar, o marca inicio y fin).',true);
  const a=Math.min(selStart,selEnd),b=Math.max(selStart,selEnd);
  if(b-a<0.04)return notice('El tramo es demasiado corto.',true);
  try{await api('/api/cuts/manual',{start:a,end:b,label:'Corte en timeline'});selStart=null;selEnd=null;await refresh();notice('Tramo marcado para quitar (rojo). Se eliminará al Exportar recortado; escucha el salto antes de publicar.');}
  catch(e){notice(e.message,true);}
}
function tlDuration(){const v=$('video');if(v&&v.duration&&isFinite(v.duration))return v.duration;const t=state?.transcript;return t&&t.length?Number(t[t.length-1].end)||0:0;}
function positionHead(){const head=$('tlHead');if(!head)return;const inner=head.parentElement;const v=$('video');const dur=tlDuration();if(!dur||!inner)return;const t=(v?.currentTime||0)+(playerSourceOffset||0);head.style.left=(Math.max(0,Math.min(1,t/dur))*inner.offsetWidth)+'px';}
function tlSeekFromX(clientX){const head=$('tlHead');const inner=head&&head.parentElement;if(!inner)return;const dur=tlDuration();if(!dur)return;const r=inner.getBoundingClientRect();const x=Math.max(0,Math.min(inner.offsetWidth,clientX-r.left));const t=x/inner.offsetWidth*dur;const v=$('video');if(v){const tt=Math.max(0,t-(playerSourceOffset||0));try{if(tlDrag){v.pause();if(v.fastSeek){v.fastSeek(tt);}else{v.currentTime=tt;}}else{v.currentTime=tt;}}catch{}}positionHead();updateTlTime();}
function updateTlTime(){const v=$('video'),el=$('tlTime');if(!el)return;const dur=tlDuration();const t=(v?.currentTime||0)+(playerSourceOffset||0);el.textContent=fmt(t)+' / '+fmt(dur);}
function buildTimeline(){
  const bar=$('timeline'); if(!bar) return;
  const dur=tlDuration();
  const fp=`${(state.matches||[]).length}|${(state.pauses||[]).length}|${Math.round(dur)}|${tlZoom}|${state.filmstrip?state.filmstrip.count:0}`;
  if(bar.dataset.fp===fp && bar.childElementCount){positionHead();refreshOverlays();return;}
  bar.dataset.fp=fp; bar.replaceChildren();
  if(!dur){bar.innerHTML='<div class="tl-empty">Abre un video para ver la línea de tiempo.</div>';updateTlTime();return;}
  const inner=document.createElement('div');inner.className='timelineInner';
  const px=Math.round(Math.max(bar.clientWidth||600, dur*2.2*tlZoom));
  inner.style.width=px+'px';
  const X=t=>Math.max(0,Math.min(px,t/dur*px));
  // Regla de tiempo (ticks con etiqueta)
  const ruler=document.createElement('div');ruler.className='tl-ruler';
  const approx=dur/(px/90);
  const nice=[1,2,5,10,15,30,60,120,300,600,900].find(n=>n>=approx)||1200;
  for(let t=0;t<=dur+0.1;t+=nice){const tick=document.createElement('div');tick.className='tl-tick';tick.style.left=X(t)+'px';const lab=document.createElement('span');lab.textContent=fmt(t).replace(/^0:/,'');tick.append(lab);ruler.append(tick);}
  inner.append(ruler);
  if(state.filmstrip && state.filmstrip.count){
    const strip=document.createElement('div');strip.className='tl-strip';
    for(let k=1;k<=state.filmstrip.count;k++){const img=document.createElement('img');img.loading='lazy';img.draggable=false;img.src='/api/strip?i='+k;strip.append(img);}
    inner.append(strip);
    if(state.filmstrip.wave){const w=document.createElement('img');w.className='tl-wave';w.draggable=false;w.src='/api/wave?v='+state.filmstrip.count;inner.append(w);}
  }
  for(const p of (state.pauses||[])){const el=document.createElement('div');el.className='tl-pause';el.style.left=X(p.start)+'px';el.style.width=Math.max(2,X(p.end)-X(p.start))+'px';el.title=`Pausa ${p.duration}s`;inner.append(el);}
  for(const m of (state.matches||[])){const el=document.createElement('div');el.className='tl-gros';el.style.left=X(m.start)+'px';el.title=m.term;inner.append(el);}
  const head=document.createElement('div');head.className='tl-head';head.id='tlHead';inner.append(head);
  bar.append(inner); positionHead(); updateTlTime(); refreshOverlays();
}
function frameStep(d){const v=$('video');if(!v)return;try{v.pause();v.currentTime=Math.max(0,(v.currentTime||0)+d);}catch{}positionHead();updateTlTime();}
// Vista previa de la animación del clip (simula el fade con un overlay sobre el reproductor).
// Usa la Web Animations API (más fiable que requestAnimationFrame, que se pausa si la pestaña no se ve).
let animHandle=null, animTick=null, animTimer=null;
function animColor(v){return v==='blanco'?'#ffffff':'#000000';}
function animDur(){return Math.max(0.3,Math.min(3,Number($('clipDur')?.value)||0.8));}
function stopAnimPreview(){const v=$('video'),ov=$('animOverlay');if(animHandle){try{animHandle.cancel();}catch{}animHandle=null;}if(animTimer){clearTimeout(animTimer);animTimer=null;}if(animTick&&v){v.removeEventListener('timeupdate',animTick);animTick=null;}if(ov){ov.style.opacity='0';ov.style.display='none';}}
function runOverlayFade(ov,from,to,d,onDone){
  ov.style.display='block';ov.style.opacity=String(to);
  animHandle=ov.animate([{opacity:from},{opacity:to}],{duration:d*1000,easing:'linear',fill:'forwards'});
  animHandle.onfinish=()=>{animHandle=null;if(onDone)onDone();};
  return animHandle;
}
function previewAnim(kind){
  const v=$('video'),ov=$('animOverlay');if(!v||!ov)return;
  if(!v.getAttribute('src')){notice('Abre un video primero para previsualizar.',true);return;}
  stopAnimPreview();
  const d=animDur();
  if(kind==='in'){
    const sel=$('clipIn').value;if(sel==='none'){notice('Elige una animación de entrada primero. (Entrada: Ninguna)');return;}
    ov.style.background=animColor(sel);
    try{v.currentTime=0;}catch{}
    v.play().catch(()=>{});
    runOverlayFade(ov,1,0,d,()=>{animTimer=setTimeout(()=>{try{v.pause();}catch{}ov.style.display='none';},700);});
    notice('▶ Previsualizando entrada (fade in). Así se verá el inicio del video.');
  } else {
    const sel=$('clipOut').value;if(sel==='none'){notice('Elige una animación de salida primero. (Salida: Ninguna)');return;}
    const total=tlDuration();if(!total){notice('El video aún no tiene duración.',true);return;}
    const st=Math.max(0,total-d);
    ov.style.background=animColor(sel);ov.style.opacity='0';ov.style.display='block';
    try{v.currentTime=Math.max(0,st-1.2);}catch{}
    v.play().catch(()=>{});
    animTick=()=>{const t=(v.currentTime||0)+(playerSourceOffset||0);if(t>=st){v.removeEventListener('timeupdate',animTick);animTick=null;runOverlayFade(ov,0,1,d,()=>{animTimer=setTimeout(()=>{try{v.pause();}catch{}ov.style.display='none';ov.style.opacity='0';},400);});}};
    v.addEventListener('timeupdate',animTick);
    notice('▶ Previsualizando salida (fade out). Reproduciendo hacia el final…');
  }
}
function buildTranscript(){
  const tv=$('transcriptView'); if(!tv) return;
  const fp=(state.transcript?.length||0)+'|'+(state.matches?.length||0);
  if(tv.dataset.fp===fp) return; tv.dataset.fp=fp;
  tv.replaceChildren();
  if(!state.transcript || !state.transcript.length){tv.textContent='Transcribe el video para ver aquí todo el texto.';return;}
  const ranges=(state.matches||[]).map(m=>[Number(m.start),Number(m.end)]);
  const inCut=t=>ranges.some(r=>t>=r[0]&&t<r[1]);
  const frag=document.createDocumentFragment();
  for(const seg of state.transcript){
    const s=Number(seg.start),e=Number(seg.end);const parts=String(seg.text||'').trim().split(/\s+/).filter(Boolean);
    if(!Number.isFinite(s)||!Number.isFinite(e)||!parts.length)continue;
    parts.forEach((w,i)=>{
      const at=s+(e-s)*i/parts.length;
      const mid=s+(e-s)*(i+0.5)/parts.length;
      const span=document.createElement('span');span.className='tword'+(inCut(mid)?' tcut':'');span.textContent=w+' ';span.dataset.at=at.toFixed(2);
      span.onclick=()=>{goStep(1);setTimeout(()=>{playAt(Number(span.dataset.at)).catch(err=>notice(err.message,true));},60);};
      frag.append(span);
    });
  }
  tv.append(frag);
}
function render() {
  const p=state.project;
  $('videoStatus').textContent=p? p.videoPath.split(/[\\/]/).at(-1):'Sin video';
  {const ps=$('projStatus');if(ps)ps.textContent=p?('Proyecto actual: '+p.videoPath.split(/[\\/]/).at(-1)):'Sin proyecto abierto.';}
  const videoKey=(p?.videoPath||'')+'|'+(p?.previewPath||'');
  if(p?.videoPath!==lastSourceVideo){lastSourceVideo=p?.videoPath||'';selected=new Set();selectedPauses=new Set();matchFingerprint='';selectionHydrated=false;}
  if(!selectionHydrated){selectedPauses=new Set(state.selection?.selectedPauseIds||[]);selectionHydrated=true;}
  if(videoKey!==lastVideo){lastVideo=videoKey;playerSourceOffset=0;playerIsCutPreview=false;const unsupported=p&&!p.previewPath&&/\.(mpg|mpeg|mkv|avi)$/i.test(p.videoPath||'');if(unsupported){$('video').removeAttribute('src');$('playerEmpty').textContent='Preparando la vista previa de este formato… aparecerá en unos momentos.';}else{$('video').src=p?'/api/video?d='+Date.now():'';$('playerEmpty').textContent='Aquí podrás revisar el video y saltar a cada coincidencia.';}$('video').parentElement.classList.toggle('ready',!!p&&!unsupported);$('videoPath').value=p?.videoPath||'';}
  $('termCount').textContent=`${state.dictionary.filter(d=>d.enabled).length} activas`;
  $('matchCount').textContent=`${state.matches.length} coincidencias`;
  buildTranscript();
  buildTimeline();
  // Auto-preparar el video al abrirlo (como CapCut): vista previa si el formato no se ve + miniaturas + onda.
  if(p && state.job.status!=='running'){
    const needPrev=!p.previewPath && /\.(mpg|mpeg|mkv|avi)$/i.test(p.videoPath||'');
    const needStrip=!state.filmstrip;
    if((needPrev||needStrip) && autoPrepKey!==p.videoPath){ autoPrepKey=p.videoPath; api('/api/project/prepare',{}).then(refresh).catch(()=>{}); }
  }
  const fp=state.matches.map(m=>m.id).join('|');
  if(fp!==matchFingerprint){selected=state.selection?new Set(state.selection.selectedIds):new Set(state.matches.filter(m=>m.note!=='Revisar contexto'&&!m.approximate).map(m=>m.id));matchFingerprint=fp;}
  const terms=$('terms');terms.replaceChildren();
  state.dictionary.forEach((entry,i)=>{const row=document.createElement('div');row.className='term';const cb=document.createElement('input');cb.type='checkbox';cb.checked=entry.enabled;cb.onchange=()=>entry.enabled=cb.checked;const text=document.createElement('div');text.className='termText';const strong=document.createElement('strong');strong.textContent=entry.term;const small=document.createElement('small');small.textContent=entry.note||'Palabra o frase';text.append(strong,small);const del=document.createElement('button');del.className='delete';del.textContent='×';del.title='Quitar término';del.onclick=()=>{state.dictionary.splice(i,1);render();};row.append(cb,text,del);terms.append(row);});
  const matches=$('matches');matches.replaceChildren();matches.classList.toggle('empty',!state.matches.length);
  if(!state.matches.length) matches.textContent='Las coincidencias aparecerán aquí después de transcribir o importar subtítulos.';
  else state.matches.forEach(m=>{const row=document.createElement('div');row.className='match';const cb=document.createElement('input');cb.type='checkbox';cb.checked=selected.has(m.id);cb.onchange=()=>{cb.checked?selected.add(m.id):selected.delete(m.id);persistSelection();};const body=document.createElement('div');body.className='matchBody';const title=document.createElement('div');title.className='matchTitle';title.textContent=m.term;const ctx=document.createElement('div');ctx.className='matchContext';ctx.textContent=m.context;body.append(title,ctx);if(m.note==='Revisar contexto'){const flag=document.createElement('span');flag.className='reviewFlag';flag.textContent='revisar';title.append(flag)}const when=document.createElement('span');when.className='matchTime';when.textContent=fmt(m.start);const play=document.createElement('button');play.className='play';play.textContent='▶';play.title='Escuchar en el video';play.onclick=()=>playAt(m.start).catch(e=>notice(e.message,true));
    const adjust=document.createElement('details');adjust.className='cutAdjust';const summary=document.createElement('summary');summary.textContent=(state.adjustments||{})[m.id]?'Corte ajustado':'Ajustar corte';const fields=document.createElement('div');fields.className='cutFields';const override=(state.adjustments||{})[m.id];const start=document.createElement('input');start.type='number';start.step='.01';start.min='0';start.value=(override?.start??m.start).toFixed(2);start.setAttribute('aria-label',`Inicio del corte de ${m.term}`);const end=document.createElement('input');end.type='number';end.step='.01';end.min='0';end.value=(override?.end??m.end).toFixed(2);end.setAttribute('aria-label',`Final del corte de ${m.term}`);const save=document.createElement('button');save.className='secondary';save.textContent='Guardar';save.onclick=safe(async()=>{await api('/api/cuts/adjust',{id:m.id,start:Number(start.value),end:Number(end.value)});notice('Corte ajustado. Escucha el salto antes de exportar.');});const reset=document.createElement('button');reset.className='secondary';reset.textContent='Restablecer';reset.onclick=safe(async()=>{await api('/api/cuts/adjust',{id:m.id,reset:true});notice('Corte automático restablecido.');});const preview=document.createElement('button');preview.className='secondary';preview.textContent='Escuchar salto';preview.onclick=safe(async()=>{const result=await api('/api/cuts/preview',{id:m.id});const video=$('video');playerIsCutPreview=true;video.parentElement.classList.add('ready');video.src=result.url;video.ontimeupdate=null;video.onloadedmetadata=()=>video.play().catch(()=>{});video.scrollIntoView({behavior:'smooth',block:'center'});notice('Vista previa del corte lista.');});fields.append(start,end,save,reset,preview);adjust.append(summary,fields);body.append(adjust);
    row.append(cb,body,when);if(m.approximate){const a=document.createElement('span');a.className='approx';a.textContent='revisar tiempo';a.title='Tiempo aproximado o inusual: escucha la palabra y ajusta el inicio y el final antes de seleccionarla.';row.append(a)}row.append(play);matches.append(row);});
  $('pauseCount').textContent=`${(state.pauses||[]).length} pausas`;
  const pauses=$('pauses');pauses.replaceChildren();pauses.classList.toggle('empty',!(state.pauses||[]).length);
  if(!(state.pauses||[]).length) pauses.textContent='Todavía no se ha analizado el audio o no hay pausas largas.';
  else state.pauses.forEach(pause=>{const row=document.createElement('div');row.className='match';const cb=document.createElement('input');cb.type='checkbox';cb.checked=selectedPauses.has(pause.id);cb.onchange=()=>{cb.checked?selectedPauses.add(pause.id):selectedPauses.delete(pause.id);persistSelection();};const body=document.createElement('div');body.className='matchBody';const title=document.createElement('div');title.className='matchTitle';title.textContent=`Pausa de ${pause.duration.toFixed(1)} s`;const ctx=document.createElement('div');ctx.className='matchContext';ctx.textContent=`Se quitarían ${(pause.end-pause.start).toFixed(1)} s del medio`;body.append(title,ctx);const time=document.createElement('span');time.className='matchTime';time.textContent=fmt(pause.start);const play=document.createElement('button');play.className='play';play.textContent='▶';play.onclick=()=>playAt(pause.start).catch(e=>notice(e.message,true));row.append(cb,body,time,play);pauses.append(row);});
  const manual=$('manualCuts');manual.replaceChildren();
  for(const cut of state.manualCuts||[]){const row=document.createElement('div');row.className='match';const body=document.createElement('div');body.className='matchBody';body.textContent=`${cut.label} · ${cut.start.toFixed(2)}–${cut.end.toFixed(2)} s`;const preview=document.createElement('button');preview.className='secondary';preview.textContent='Escuchar salto';preview.onclick=safe(async()=>{const result=await api('/api/cuts/preview',{id:cut.id});const video=$('video');playerIsCutPreview=true;video.parentElement.classList.add('ready');video.src=result.url;video.ontimeupdate=null;video.onloadedmetadata=()=>video.play().catch(()=>{});video.scrollIntoView({behavior:'smooth',block:'center'});notice('Vista previa del corte manual lista.');});const remove=document.createElement('button');remove.className='delete';remove.textContent='×';remove.title='Eliminar corte manual';remove.onclick=safe(async()=>{await api('/api/cuts/manual/delete',{id:cut.id});notice('Corte manual eliminado.');});row.append(body,preview,remove);manual.append(row);}
  $('shortCount').textContent=`${state.shorts.length} propuestas`;
  const shortList=$('shorts'); shortList.replaceChildren(); shortList.classList.toggle('empty',!state.shorts.length);
  if(!state.shorts.length) shortList.textContent='Transcribe el video para generar propuestas.';
  else state.shorts.forEach(s=>{const row=document.createElement('div');row.className='shortItem';const top=document.createElement('div');top.className='shortTop';const title=document.createElement('strong');title.textContent=`#${s.rank} · ${fmt(s.start)}–${fmt(s.end)} · ${Math.round(s.end-s.start)} s`;const score=document.createElement('span');score.className='shortScore';score.textContent=s.method==='modelo local'?`Editorial ${s.editorialScore}/100`:`Ritmo ${s.score}/100`;score.title='Evaluación local; no predice vistas';top.append(title,score);const quote=document.createElement('p');quote.textContent=s.opening+'…';const reason=document.createElement('small');reason.textContent=s.reason;const buttons=document.createElement('div');buttons.className='shortActions';const preview=document.createElement('button');preview.className='secondary';preview.textContent='Ver clip completo';preview.onclick=()=>playAt(s.start,s.end-s.start).catch(e=>notice(e.message,true));const renderButton=document.createElement('button');renderButton.className='primary';renderButton.textContent='Crear Short vertical';renderButton.disabled=state.job.status==='running';renderButton.onclick=safe(async()=>{await api('/api/shorts/render',{id:s.id});notice('Creando Short con subtítulos. Aparecerá en Archivos creados.');});buttons.append(preview,renderButton);row.append(top,quote,reason,buttons);shortList.append(row);});
  Array.from(shortList.querySelectorAll('.shortItem')).forEach((row,i)=>{const s=state.shorts[i];const editor=document.createElement('div');editor.className='hookEditor';const field=document.createElement('input');field.type='text';field.maxLength=40;field.placeholder='Gancho arriba del video (opcional)';field.value=s.hook||'';field.setAttribute('aria-label',`Gancho del Short ${s.rank}`);const save=document.createElement('button');save.className='secondary';save.textContent='Guardar gancho';save.onclick=safe(async()=>{await api('/api/shorts/hook',{id:s.id,hook:field.value});notice('Gancho guardado para el Short '+s.rank+'.');});editor.append(field,save);row.insertBefore(editor,row.querySelector('.shortActions'));addMetaEditor(row,s);addCaptionEditor(row,s);addShortControls(row,s);});
  $('ffmpegPath').value=state.config.ffmpeg||'';$('ffprobePath').value=state.config.ffprobe||'';$('whisperPath').value=state.config.whisper||'';$('modelPath').value=state.config.model||'';$('brandHandle').value=state.config.brandHandle||'';$('brandMark').value=state.config.brandMark||'';
  const ready=state.readiness;$('engineStatus').textContent=`Versión ${state.version||'?'} · FFmpeg: ${ready.ffmpeg?'listo':'falta'} · FFprobe: ${ready.ffprobe?'listo':'falta'} · Whisper: ${ready.whisper?(ready.whisperGpu?'GPU ⚡':'CPU'):'falta'} · Modelo: ${ready.model?ready.model.split(/[\\/]/).at(-1):'falta'}`;
  const qsel=$('exportQuality');if(qsel && !qsel.dataset.filled && (state.qualities||[]).length){for(const q of state.qualities){const o=document.createElement('option');o.value=q.id;o.textContent=q.label;qsel.append(o);}qsel.dataset.filled='1';}
  ['introTpl','outroTpl'].forEach(id=>{const sel=$(id);if(sel && !sel.dataset.filled && (state.brandTemplates||[]).length){for(const t of state.brandTemplates){const o=document.createElement('option');o.value=t.id;o.textContent=t.label;sel.append(o);}sel.value='none';sel.dataset.filled='1';}});
  ['clipIn','clipOut'].forEach(id=>{const sel=$(id);if(sel && !sel.dataset.filled){for(const [v,l] of [['none','Ninguna'],['negro','Fade negro'],['blanco','Fade blanco']]){const o=document.createElement('option');o.value=v;o.textContent=l;sel.append(o);}sel.value='none';sel.dataset.filled='1';}});
  const av=$('auVoice'),avWrap=$('auVoiceWrap'),gd=$('getDf');
  if(av){av.disabled=!state.dfReady;if(!state.dfReady)av.checked=false;}
  if(avWrap)avWrap.classList.toggle('disabled',!state.dfReady);
  if(gd)gd.hidden=!!state.dfReady;
  const rb=$('readyBar');const miss=[];if(!ready.ffmpeg)miss.push('FFmpeg');if(!ready.whisper)miss.push('Whisper');if(!ready.model)miss.push('modelo de voz');rb.hidden=false;if(miss.length){rb.className='readyBar warn';rb.textContent='⚠️ Falta configurar: '+miss.join(', ')+'. Ábrelo en “Configuración de motores” (abajo a la derecha).';}else{rb.className='readyBar ok';rb.textContent=p?'✅ Todo listo. Transcribe el video y busca tus momentos.':'✅ Todo listo. Abre un video para empezar.';}
  const j=state.job;$('exportInfo').textContent=j.status==='running'?j.message:j.status==='done'?j.message:'';
  const running=j.status==='running';
  $('jobBar').hidden=!running;
  if(running){const pct=Math.max(0,Math.min(100,j.percent||0));$('jobFill').style.width=(pct||4)+'%';$('jobFill').classList.toggle('indeterminate',pct===0);$('jobPct').textContent=pct===0?'…':pct+'%';$('jobLabel').textContent=j.message||'Procesando…';$('cancelJob').disabled=!!j.cancelRequested;$('cancelJob').textContent=j.cancelRequested?'Cancelando…':'Cancelar';}
  const exported=$('exportedFiles');exported.replaceChildren();if(state.exports.length){const label=document.createElement('strong');label.textContent='Archivos creados';exported.append(label);for(const file of state.exports){const rowf=document.createElement('div');rowf.className='exportRow';const link=document.createElement('a');link.href='/api/export-file?name='+encodeURIComponent(file.name);link.target='_blank';link.rel='noopener';link.textContent=file.name;link.className='exportName';const dl=document.createElement('button');dl.className='copyBtn';dl.textContent='💾 Guardar como…';dl.type='button';dl.onclick=async()=>{try{dl.disabled=true;notice('Elige dónde guardar en el explorador de Windows…');const r=await api('/api/save-as',{name:file.name});if(r.cancelled){notice('Guardado cancelado.');}else{notice('✅ Guardado en: '+r.path);}}catch(e){notice(e.message,true);}finally{dl.disabled=false;}};rowf.append(link,dl);exported.append(rowf);}}
  if(j.status==='error'&&j.message!==lastJob){notice(j.message,true);lastJob=j.message}else if((j.status==='done'||j.status==='cancelled')&&j.message!==lastJob){notice(j.message);lastJob=j.message}
  $('transcribe').disabled=!p||j.status==='running';$('analyzePauses').disabled=!p||j.status==='running';$('export').disabled=!p||j.status==='running';$('makePreview').disabled=!p||j.status==='running';$('suggestShorts').disabled=!p||!state.transcript.length||j.status==='running';$('renderAllShorts').disabled=!state.shorts.length||j.status==='running';
}
function safe(handler){return async()=>{try{await handler();await refresh();}catch(e){notice(e.message,true)}}}
$('newProject').onclick=safe(async()=>{if(!confirm('¿Empezar un proyecto nuevo? Se quita el video y los clips actuales (los archivos ya exportados se conservan).'))return;await api('/api/project/clear',{});goStep(1);notice('Nuevo proyecto. Abre un video para empezar.');});
$('pickVideo').onclick=safe(async()=>{notice('Elige el video en el explorador de Windows…');const r=await api('/api/pick-video',{});if(r.cancelled){notice('Abrir cancelado.');return;}$('videoPath').value=r.path;await api('/api/project/open',{path:r.path});notice('Video abierto. Ahora pulsa “Transcribir video”.');});
$('openVideo').onclick=safe(async()=>{await api('/api/project/open',{path:$('videoPath').value});notice('Video abierto. Ya puedes transcribirlo.');});
$('videoFile').onchange=safe(async()=>{const f=$('videoFile').files[0];if(!f)return;notice('Copiando video a la app…');await upload('/api/project/upload',f);notice('Video listo.');});
$('transcriptFile').onchange=safe(async()=>{const f=$('transcriptFile').files[0];if(!f)return;await upload('/api/transcript/upload',f);selected=new Set();notice('Transcripción importada. Revisa los tiempos de los cortes.');});
$('transcribe').onclick=safe(async()=>{await api('/api/transcribe',{});notice('Transcripción iniciada. Puede tardar varios minutos.');});
$('analyzePauses').onclick=safe(async()=>{selectedPauses=new Set();await api('/api/pauses/analyze',{});notice('Analizando silencios del audio.');});
$('makePreview').onclick=safe(async()=>{await api('/api/preview',{});notice('Creando vista previa. Puedes esperar a que termine mientras la app sigue abierta.');});
$('grabFrame').onclick=safe(async()=>{let at;try{at=sourcePlayerTime();}catch(e){throw Error('Mueve el reproductor al momento que quieras (video original o un fragmento sin cortar).');}const r=await api('/api/frame',{at});notice('📸 Frame guardado: '+r.name+'. En el paso 4 → Archivos creados puedes abrirlo o Guardar como.');});
$('tlZoomIn').onclick=()=>{tlZoom=Math.min(40,tlZoom*1.6);buildTimeline();};
$('tlZoomOut').onclick=()=>{tlZoom=Math.max(1,tlZoom/1.6);buildTimeline();};
$('tlBackF').onclick=()=>frameStep(-1/30);
$('tlFwdF').onclick=()=>frameStep(1/30);
$('tlBack1s').onclick=()=>frameStep(-1);
$('tlFwd1s').onclick=()=>frameStep(1);
$('tlPlay').onclick=()=>{const v=$('video');if(!v)return;v.paused?v.play().catch(()=>{}):v.pause();};
$('tlLoadStrip').onclick=safe(async()=>{if(!state.project)throw Error('Abre un video primero.');await api('/api/filmstrip',{});notice('Generando miniaturas y onda de audio… (puedes cancelar arriba)');});
(function(){const bar=$('timeline');if(!bar)return;
  bar.addEventListener('mousedown',e=>{
    if(e.target.closest('.tl-tick')||e.target.closest('.tl-cutx'))return;
    if(tlCutMode||e.shiftKey){selDragging=true;selStart=tlTimeFromX(e.clientX);selEnd=selStart;refreshOverlays();e.preventDefault();return;}
    tlDrag=true;tlSeekFromX(e.clientX);e.preventDefault();
  });
  window.addEventListener('mousemove',e=>{
    if(selDragging){selEnd=tlTimeFromX(e.clientX);refreshOverlays();return;}
    if(tlDrag)tlSeekFromX(e.clientX);
  });
  window.addEventListener('mouseup',()=>{
    if(selDragging){selDragging=false;if(selStart!=null&&selEnd!=null){const a=Math.min(selStart,selEnd),b=Math.max(selStart,selEnd);if(b-a<0.04){clearSelection();}else{selStart=a;selEnd=b;notice('Tramo '+fmt(a)+'–'+fmt(b)+' seleccionado. Pulsa “Quitar tramo” (o Supr) para eliminarlo.');}}refreshOverlays();}
    tlDrag=false;
  });
})();
$('video').addEventListener('timeupdate',()=>{positionHead();updateTlTime();});
// ---- Cortes visuales en la timeline ----
$('tlCutMode').onclick=()=>{tlCutMode=!tlCutMode;if(!tlCutMode)selDragging=false;updateCutButtons();notice(tlCutMode?'Modo corte ON: arrastra sobre la barra para seleccionar un tramo.':'Modo corte OFF: la barra vuelve a buscar en el video.');};
$('tlMark').onclick=()=>tlMark();
$('tlDelSel').onclick=()=>deleteSelection();
$('tlClearSel').onclick=()=>{clearSelection();notice('Selección borrada.');};
$('tlKeyMark').onchange=()=>{tlKeyMark=$('tlKeyMark').value||'s';try{localStorage.setItem('eirl_cutkey',tlKeyMark);}catch{}updateCutButtons();};
$('tlGoCut').onclick=()=>{goStep(4);const c=document.querySelector('input[name="censorMode"][value="cut"]');if(c){c.checked=true;c.dispatchEvent(new Event('change',{bubbles:true}));}notice('Modo “Cortar” elegido: al Exportar MP4 se quitan los tramos rojos y el video se une solo.');};
try{$('tlKeyMark').value=tlKeyMark;}catch{}
window.addEventListener('keydown',e=>{
  const step1=!document.querySelector('.step[data-step="1"]').hidden;
  if(!step1)return;
  const t=e.target,tag=(t&&t.tagName||'').toLowerCase();
  if(tag==='input'||tag==='textarea'||tag==='select'||(t&&t.isContentEditable))return;
  const k=e.key.toLowerCase();
  if(k===tlKeyMark){e.preventDefault();tlMark();return;}
  if(e.key==='Delete'||e.key==='Backspace'){if(selStart!=null&&selEnd!=null){e.preventDefault();deleteSelection();}return;}
  if(e.key==='ArrowLeft'){e.preventDefault();frameStep(e.shiftKey?-1:-1/30);return;}
  if(e.key==='ArrowRight'){e.preventDefault();frameStep(e.shiftKey?1:1/30);return;}
  if(e.key===' '){e.preventDefault();$('tlPlay').click();return;}
});
$('getDf').onclick=async()=>{const b=$('getDf');try{b.disabled=true;b.textContent='Descargando… (25 MB)';await api('/api/download-df',{});notice('✅ Voz Estudio activada. Marca “Realzar voz · Estudio” en el panel de audio.');await refresh();const av=$('auVoice');if(av)av.checked=true;}catch(e){notice('No se pudo activar: '+e.message,true);}finally{b.disabled=false;b.textContent='⬇️ Activar voz Estudio (25 MB)';}};
$('auOff').onclick=()=>{['auDenoise','auCompress','auNormalize','auVoice'].forEach(id=>{const el=$(id);if(el)el.checked=false;});notice('Audio sin procesar: saldrá igual que el original (con las groserías silenciadas).');};
$('animPreviewIn').onclick=()=>previewAnim('in');
$('animPreviewOut').onclick=()=>previewAnim('out');
$('themeToggle').onclick=toggleTheme; applyThemeIcon();
// Si la pestaña se oculta a media previa, limpia el overlay (las animaciones se pausan al ocultar).
document.addEventListener('visibilitychange',()=>{if(document.hidden)stopAnimPreview();});
$('takeManualStart').onclick=()=>{try{$('manualStart').value=sourcePlayerTime().toFixed(2);}catch(e){notice(e.message,true);}};
$('takeManualEnd').onclick=()=>{try{$('manualEnd').value=sourcePlayerTime().toFixed(2);}catch(e){notice(e.message,true);}};
$('addManualCut').onclick=safe(async()=>{await api('/api/cuts/manual',{start:Number($('manualStart').value),end:Number($('manualEnd').value),label:$('manualLabel').value});$('manualLabel').value='';notice('Corte manual agregado. Escucha el salto para revisar el resultado.');});
function toSeconds(v){v=String(v||'').trim();if(!v)return NaN;if(/^\d+(\.\d+)?$/.test(v))return Number(v);let m=v.match(/^(\d+):(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/);if(m)return (+m[1])*3600+(+m[2])*60+(+m[3]);m=v.match(/^(\d+):(\d{1,2}(?:\.\d+)?)$/);if(m)return (+m[1])*60+(+m[2]);return NaN;}
$('addManualShort').onclick=safe(async()=>{const s=toSeconds($('msStart').value),e=toSeconds($('msEnd').value);if(!Number.isFinite(s)||!Number.isFinite(e))throw Error('Escribe los tiempos como mm:ss (ej. 12:00) o en segundos.');if(e<=s)throw Error('El final debe ser mayor que el inicio.');await api('/api/shorts/manual',{start:s,end:e,hook:$('msHook').value});$('msHook').value='';notice('Short agregado arriba en la lista. Pulsa "Crear Short vertical" para renderizarlo con subtítulos y zoom.');});
$('suggestShorts').onclick=safe(async()=>{await api('/api/shorts/suggest',{});notice('Evaluando propuestas en tu computadora. La lista se actualizará al terminar.');});
$('renderAllShorts').onclick=safe(async()=>{await api('/api/shorts/render-all',{});notice('Creando los cinco Shorts en esta computadora. Irán apareciendo en Archivos creados.');});
$('addTerm').onclick=()=>{const terms=$('newTerm').value.split(/[,;\n]/).map(x=>x.trim()).filter(Boolean);for(const term of terms){if(!state.dictionary.some(e=>e.term.toLocaleLowerCase('es-MX')===term.toLocaleLowerCase('es-MX')))state.dictionary.push({term,enabled:true,note:'Personalizado'});}$('newTerm').value='';render();};
$('newTerm').onkeydown=e=>{if(e.key==='Enter')$('addTerm').click()};
$('saveTerms').onclick=safe(async()=>{await api('/api/dictionary',{entries:state.dictionary});selected=new Set();matchFingerprint='';notice('Diccionario guardado. Se actualizaron las coincidencias.');});
$('saveConfig').onclick=safe(async()=>{await api('/api/config',{ffmpeg:$('ffmpegPath').value,ffprobe:$('ffprobePath').value,whisper:$('whisperPath').value,model:$('modelPath').value,brandHandle:$('brandHandle').value,brandMark:$('brandMark').value});notice('Configuración guardada.');});
$('selectAll').onclick=()=>{selected=new Set(state.matches.map(m=>m.id));persistSelection();render();};
$('selectNone').onclick=()=>{selected.clear();persistSelection();render();};
$('export').onclick=safe(async()=>{await selectionSave;const mode=(document.querySelector('input[name="censorMode"]:checked')||{}).value==='cut'?'cut':'mute';const ids=[...selected];const pauseIds=[...selectedPauses];if(mode==='mute'){if(!ids.length&&!(state.manualCuts||[]).length)throw Error('Para silenciar, selecciona al menos una palabra o agrega un corte manual. (Las pausas solo aplican al modo Cortar.)');}else if(!ids.length&&!pauseIds.length&&!(state.manualCuts||[]).length)throw Error('Selecciona palabras, pausas o agrega un corte manual.');const enhance={denoise:$('auDenoise')?.checked,compress:$('auCompress')?.checked,normalize:$('auNormalize')?.checked,voice:$('auVoice')?.checked&&!$('auVoice')?.disabled};const r=await api('/api/export',{selectedIds:ids,selectedPauseIds:pauseIds,mode,quality:($('exportQuality')||{}).value||'original',enhance,intro:($('introTpl')||{}).value||'none',outro:($('outroTpl')||{}).value||'none',clipIn:($('clipIn')||{}).value||'none',clipOut:($('clipOut')||{}).value||'none',clipDur:Number(($('clipDur')||{}).value)||0.8});notice(mode==='mute'?`Silenciando ${r.cuts} ${r.cuts===1?'grosería':'groserías'}. El archivo aparecerá en exports.`:`Exportación iniciada con ${r.cuts} cortes. El archivo aparecerá en exports.`);});
$('cancelJob').onclick=safe(async()=>{await api('/api/job/cancel',{});notice('Cancelando el proceso…');});
$('checkUpdate').onclick=async()=>{const info=$('updateInfo');try{$('checkUpdate').disabled=true;info.replaceChildren();info.textContent='Revisando…';const r=await api('/api/update/check',{});info.replaceChildren();if(!r.hasUpdate){info.textContent='✅ Estás en la última versión ('+r.current+').';return;}const txt=document.createElement('span');txt.textContent='Nueva versión '+r.latest+(r.notes?' · '+r.notes:'')+'  ';const go=document.createElement('button');go.className='primary compact';go.type='button';go.textContent='Actualizar ahora';go.onclick=async()=>{try{go.disabled=true;go.textContent='Actualizando…';const a=await api('/api/update/apply',{});info.replaceChildren();info.textContent='✅ '+a.message;}catch(e){info.textContent='Error al actualizar: '+e.message;}};info.append(txt,go);}catch(e){info.replaceChildren();info.textContent='No se pudo revisar: '+e.message;}finally{$('checkUpdate').disabled=false;}};
// Asistente por pasos (wizard)
function goStep(n){n=Math.max(1,Math.min(4,Number(n)||1));document.querySelectorAll('.step').forEach(s=>{s.hidden=Number(s.dataset.step)!==n;});document.querySelectorAll('.wstep').forEach(b=>{const bn=Number(b.dataset.step);b.classList.toggle('active',bn===n);b.classList.toggle('done',bn<n);});try{localStorage.setItem('eirl_step',String(n));}catch{}window.scrollTo({top:0,behavior:'smooth'});if(n===1){const tl=document.getElementById('timeline');if(tl)tl.dataset.fp='';setTimeout(()=>{try{buildTimeline();}catch{}},90);}}
document.querySelectorAll('.wstep').forEach(b=>b.addEventListener('click',()=>goStep(b.dataset.step)));
document.querySelectorAll('[data-go]').forEach(b=>b.addEventListener('click',()=>goStep(b.dataset.go)));
goStep(1); // siempre empezar en el paso 1 (como CapCut), no en el último
refresh().catch(e=>notice(e.message,true));
setInterval(()=>{if(state?.job.status==='running')refresh().catch(()=>{});},1000);
