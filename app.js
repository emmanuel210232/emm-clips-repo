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
let silenceApplied = 0; // evita re-aplicar el mismo escaneo de silencios
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
// ============ EDITOR DE CLIPS tipo CapCut (tiempo de SALIDA + ripple) ============
// clips = segmentos de la fuente que forman el video final, en orden. Al borrar uno, el hueco se CIERRA (ripple).
let clips=null, selectedClipIdx=-1, clipsVideo='', clipUndo=[], multiSel=new Set();
function clipsKey(){return 'eirl_clips_'+(state?.project?.videoPath||'');}
function keptFromCuts(cuts,dur){const sorted=[...(cuts||[])].map(c=>({start:+c.start,end:+c.end})).sort((a,b)=>a.start-b.start);const keep=[];let cur=0;for(const c of sorted){if(c.start>cur+0.015)keep.push({start:cur,end:c.start});cur=Math.max(cur,c.end);}if(dur>cur+0.015)keep.push({start:cur,end:dur});return keep.length?keep:[{start:0,end:dur}];}
function loadClips(){const dur=tlDuration();
  try{const raw=JSON.parse(localStorage.getItem(clipsKey())||'null');if(Array.isArray(raw)&&raw.length&&raw.every(c=>Number.isFinite(c.start)&&Number.isFinite(c.end)&&c.end>c.start)){clips=raw.map(c=>({start:+c.start,end:+c.end}));return;}}catch{}
  // Sin clips guardados: si el proyecto ya trae cortes, derivo los clips conservados (consistente con el export).
  if(dur && (state?.manualCuts||[]).length){ clips=keptFromCuts(state.manualCuts,dur); saveClips(); return; }
  clips=dur?[{start:0,end:dur}]:[];}
function saveClips(){try{localStorage.setItem(clipsKey(),JSON.stringify(clips));}catch{}}
function ensureClips(){const dur=tlDuration();if(!clips)loadClips();if((!clips||!clips.length)&&dur)clips=[{start:0,end:dur}];return clips||[];}
function clipsSig(){return (clips||[]).map(c=>c.start.toFixed(1)+'-'+c.end.toFixed(1)).join(',');}
function totalOut(){return (clips||[]).reduce((a,c)=>a+(c.end-c.start),0);}
function clipOutBounds(){let acc=0;return (clips||[]).map(c=>{const o={outStart:acc,outEnd:acc+(c.end-c.start)};acc=o.outEnd;return o;});}
function outToSource(outT){let acc=0;for(const c of (clips||[])){const d=c.end-c.start;if(outT<=acc+d+1e-6)return c.start+Math.max(0,Math.min(d,outT-acc));acc+=d;}const last=(clips||[])[(clips||[]).length-1];return last?last.end:0;}
function sourceToOut(srcT){let acc=0;for(const c of (clips||[])){const d=c.end-c.start;if(srcT>=c.start-1e-6&&srcT<=c.end+1e-6)return acc+(srcT-c.start);acc+=d;}return null;}
function nearestKeptSource(srcT){for(const c of (clips||[])){if(srcT<=c.end)return Math.max(c.start,Math.min(srcT,c.end));}const last=(clips||[])[(clips||[]).length-1];return last?last.end:0;}
function pushUndo(){try{clipUndo.push(JSON.stringify(clips));if(clipUndo.length>40)clipUndo.shift();}catch{}}
function undoClip(){if(!clipUndo.length)return notice('Nada que deshacer.');try{clips=JSON.parse(clipUndo.pop());saveClips();selectedClipIdx=-1;multiSel.clear();syncRemoved();buildTimeline();notice('↶ Deshecho.');}catch{}}
// Une clips contiguos (quita divisiones sin quitar contenido). Si hay varios seleccionados, une esos; si no, une todos.
function mergeClips(){
  ensureClips(); if(clips.length<2) return notice('No hay nada que unir.');
  const sel = multiSel.size>=2 ? multiSel : new Set(clips.map((_,i)=>i));
  const out=[]; let merged=0;
  for(let i=0;i<clips.length;){
    let cur={start:clips[i].start,end:clips[i].end};
    while(i+1<clips.length && sel.has(i) && sel.has(i+1) && Math.abs(clips[i+1].start-cur.end)<0.06){ cur.end=clips[i+1].end; i++; merged++; }
    out.push(cur); i++;
  }
  if(!merged) return notice('Esos clips no son seguidos (tienen cortes en medio), no se pueden unir.',true);
  pushUndo(); clips=out; saveClips(); multiSel.clear(); selectedClipIdx=-1; syncRemoved(); buildTimeline();
  notice('🔗 Clips unidos ('+merged+' división'+(merged>1?'es':'')+' quitada'+(merged>1?'s':'')+').');
}
function toggleZoom(){
  ensureClips();
  if(multiSel.size){ pushUndo(); const on=![...multiSel].every(i=>clips[i]&&clips[i].zoom); multiSel.forEach(i=>{if(clips[i])clips[i].zoom=on;}); saveClips(); buildTimeline(); notice(on?'🔍 Zoom puesto en '+multiSel.size+' clips.':'Zoom quitado.'); return; }
  if(selectedClipIdx<0||selectedClipIdx>=clips.length)return notice('Pica un clip para ponerle (o quitarle) zoom.',true);
  pushUndo(); clips[selectedClipIdx].zoom=!clips[selectedClipIdx].zoom; saveClips(); buildTimeline();
  notice(clips[selectedClipIdx].zoom?'🔍 Zoom (acercamiento) puesto en este clip. Se aplica al exportar.':'Zoom quitado de este clip.');
}
// Parte un clip en pedazos según las ventanas de zoom (en tiempo de la fuente); los pedazos dentro de una ventana quedan con zoom.
function splitClipByWindows(clip, windows){
  const pts=[clip.start,clip.end];
  for(const w of windows){ if(w.end>clip.start+0.05 && w.start<clip.end-0.05){ pts.push(Math.max(clip.start,w.start),Math.min(clip.end,w.end)); } }
  const uniq=[...new Set(pts.map(p=>+p.toFixed(3)))].sort((a,b)=>a-b);
  const out=[];
  for(let i=0;i<uniq.length-1;i++){ const a=uniq[i],b=uniq[i+1]; if(b-a<0.12)continue; const mid=(a+b)/2; const z=windows.some(w=>mid>=w.start&&mid<=w.end); out.push({start:+a.toFixed(3),end:+b.toFixed(3),zoom:z||!!clip.zoom}); }
  return out.length?out:[{...clip}];
}
async function suggestZooms(){
  ensureClips();
  notice('✨ Escuchando el audio para sugerir acercamientos…');
  const r=await api('/api/suggest-zooms',{});
  const windows=(r&&r.windows)||[];
  if(!windows.length){ return notice('No encontré momentos claros para acercar. Puedes poner zoom a mano con 🔍.',true); }
  pushUndo();
  const next=[]; for(const c of clips){ for(const sc of splitClipByWindows(c,windows)) next.push(sc); }
  clips=next; selectedClipIdx=-1; multiSel.clear(); saveClips(); syncRemoved(); buildTimeline();
  const z=clips.filter(c=>c.zoom).length;
  notice('✨ Puse '+z+' acercamiento(s) en los momentos más enfáticos. Revisa y quita los que no quieras con 🔍 (o ↶ Deshacer).');
}
// Parte los clips en cada tiempo dado (de la fuente), conservando zoom/trans del pedazo original.
function splitClipsAt(times){
  let arr=clips;
  for(const t of [...times].sort((a,b)=>a-b)){
    const out=[];
    for(const c of arr){ if(t>c.start+0.12&&t<c.end-0.12){ out.push({start:c.start,end:+t.toFixed(3),zoom:c.zoom,trans:c.trans},{start:+t.toFixed(3),end:c.end,zoom:c.zoom}); } else out.push(c); }
    arr=out;
  }
  return arr;
}
async function suggestTransitions(){
  ensureClips();
  notice('🎬 La IA está leyendo la transcripción para hallar cambios de tema…');
  const r=await api('/api/topics',{});
  const bounds=(r&&r.boundaries)||[];
  if(!bounds.length){ return notice('No encontré cambios de tema claros. Puedes dividir (D) y poner un efecto a mano.',true); }
  pushUndo();
  clips=splitClipsAt(bounds);
  let n=0;
  for(const b of bounds){ const idx=clips.findIndex(c=>Math.abs(c.start-b)<0.25); if(idx>0){ clips[idx].trans=true; n++; } }
  selectedClipIdx=-1; multiSel.clear(); saveClips(); syncRemoved(); buildTimeline();
  notice('🎬 Puse '+n+' transición(es) en los cambios de tema. Al exportar se ven como un fundido suave. Quita las que no quieras con ↶ Deshacer.');
}
function selectClipsInRange(x0,x1){
  const a=Math.min(x0,x1), b=Math.max(x0,x1);
  const oa=tlOutFromX(a), ob=tlOutFromX(b); const bounds=clipOutBounds();
  multiSel.clear(); selectedClipIdx=-1;
  bounds.forEach((bn,i)=>{ if(bn.outStart<ob && bn.outEnd>oa) multiSel.add(i); });
  drawSelection();
  if(multiSel.size) notice(multiSel.size+' clip(s) seleccionado(s). Pulsa 🔗 Unir o Supr para borrarlos.');
}
function splitAtPlayhead(){
  const v=$('video');const src=(v?.currentTime||0)+(playerSourceOffset||0);ensureClips();
  const out=[];let done=false;
  for(const c of clips){ if(src>c.start+0.12&&src<c.end-0.12){out.push({start:c.start,end:+src.toFixed(3)},{start:+src.toFixed(3),end:c.end});done=true;} else out.push(c); }
  if(!done)return notice('Pon la línea del tiempo DENTRO de un clip (no en el borde) y pulsa D.',true);
  pushUndo();clips=out;saveClips();selectedClipIdx=clips.findIndex(c=>Math.abs(c.end-src)<0.13);buildTimeline();
  notice('✂️ Dividido en '+fmt(src)+'. Pica un clip y pulsa Supr para borrarlo.');
}
async function syncRemoved(){
  const dur=tlDuration();const sorted=[...clips].sort((a,b)=>a.start-b.start);const rem=[];let cur=0;
  for(const c of sorted){if(c.start>cur+0.02)rem.push({start:cur,end:c.start});cur=Math.max(cur,c.end);}
  if(dur>cur+0.02)rem.push({start:cur,end:dur});
  try{state=await api('/api/cuts/manual/set',{cuts:rem});}catch(e){notice(e.message,true);}
}
// Quita el tramo [a,b] de la secuencia (ripple) — lo usa "Marcar para cortar" de la revisión IA.
function cutRange(a,b){
  ensureClips();const out=[];
  for(const c of clips){
    if(c.end<=a+0.02||c.start>=b-0.02){out.push(c);continue;}
    if(c.start<a-0.02)out.push({start:c.start,end:a});
    if(c.end>b+0.02)out.push({start:b,end:c.end});
  }
  const kept=out.filter(c=>c.end-c.start>0.1);
  if(!kept.length)return notice('Ese corte quitaría todo el video.',true);
  pushUndo();clips=kept;saveClips();selectedClipIdx=-1;syncRemoved();buildTimeline();
  notice('🗑️ Cortado '+fmt(a)+'–'+fmt(b)+'. Revisa el salto y exporta cuando termines.');
}
const SCAN_CAT_LABEL={beso:'Beso/intimidad',desnudez:'Desnudez',pelea:'Pelea/golpes',drogas:'Alcohol/drogas'};
function buildScanResults(){
  const box=$('scanResults'); if(!box) return;
  const sc=state.sensitiveScan; const info=$('scanInfo');
  if(!sc){ if(box.childElementCount)box.replaceChildren(); box.dataset.fp=''; if(info)info.textContent=''; return; }
  if(info)info.textContent=`${sc.ranges.length} marca(s) · ${sc.frames} fotogramas`;
  const fp=(sc.scannedAt||0)+'|'+sc.ranges.length;
  if(box.dataset.fp===fp && box.childElementCount) return; box.dataset.fp=fp; box.replaceChildren();
  if(!sc.ranges.length){ const p=document.createElement('p'); p.className='hint'; p.textContent='✅ La IA no marcó nada sospechoso en este video.'; box.append(p); return; }
  for(const r of sc.ranges){
    const row=document.createElement('div'); row.className='scanRow risk-'+(r.riesgo||'bajo');
    const img=document.createElement('img'); img.className='scanThumb'; img.loading='lazy'; img.src='/api/scan-thumb?i='+r.thumb;
    const body=document.createElement('div'); body.className='scanBody';
    const t=document.createElement('div'); t.className='scanTitle'; t.textContent=(r.cats||[]).map(c=>SCAN_CAT_LABEL[c]||c).join(', ')+' · riesgo '+(r.riesgo||'?');
    const sub=document.createElement('div'); sub.className='scanSub'; sub.textContent=fmt(r.start)+'–'+fmt(r.end)+(r.nota?' · '+r.nota:'');
    body.append(t,sub);
    const acts=document.createElement('div'); acts.className='scanActs';
    const go=document.createElement('button'); go.type='button'; go.className='secondary compact'; go.textContent='▶ Ir'; go.onclick=()=>{goStep(1);playAt(r.start).catch(()=>{});};
    const cut=document.createElement('button'); cut.type='button'; cut.className='tl-btn danger'; cut.textContent='🗑️ Marcar para cortar'; cut.onclick=()=>cutRange(r.start,r.end);
    acts.append(go,cut); row.append(img,body,acts); box.append(row);
  }
}
async function deleteSelectedClip(){
  ensureClips();
  if(clips.length<=1)return notice('Es el único clip. Divide primero con D y luego borra la parte que no quieras.',true);
  if(multiSel.size){ // borrar varios (multi-selección por arrastre)
    const toDel=new Set(multiSel); const kept=clips.filter((_,i)=>!toDel.has(i));
    if(!kept.length)return notice('Eso borraría todo el video.',true);
    pushUndo();clips=kept;saveClips();multiSel.clear();selectedClipIdx=-1;await syncRemoved();buildTimeline();positionHead();updateTlTime();
    notice('🗑️ '+toDel.size+' clips borrados y el hueco se cerró. Ctrl+Z para deshacer.'); return;
  }
  if(selectedClipIdx<0||selectedClipIdx>=clips.length)return notice('Pica un clip en la línea del tiempo para seleccionarlo.',true);
  const idx=selectedClipIdx;
  const inner=tlInner();const block=inner&&inner.querySelector('.tl-clip[data-i="'+idx+'"]');
  const finish=async()=>{
    pushUndo();const startOut=clipOutBounds()[idx]?.outStart||0;
    clips=clips.filter((_,i)=>i!==idx);saveClips();selectedClipIdx=Math.min(idx,clips.length-1);
    await syncRemoved();buildTimeline();
    try{const v=$('video');const src=outToSource(Math.min(startOut,Math.max(0,totalOut()-0.05)));if(v&&Number.isFinite(src))v.currentTime=Math.max(0,src);}catch{}
    positionHead();updateTlTime();
    notice('🗑️ Clip borrado y el hueco se cerró. Pulsa ↶ Deshacer si te equivocaste.');
  };
  if(block){block.classList.add('removing');setTimeout(finish,230);} else finish();
}
function tlInner(){const h=$('tlHead');return h&&h.parentElement;}
function tlOutFromX(clientX){const inner=tlInner();const T=totalOut();if(!inner||!T)return 0;const r=inner.getBoundingClientRect();const x=Math.max(0,Math.min(inner.offsetWidth,clientX-r.left));return x/inner.offsetWidth*T;}
function tlXofOut(o){const inner=tlInner();const T=totalOut();if(!inner||!T)return 0;return Math.max(0,Math.min(inner.offsetWidth,o/T*inner.offsetWidth));}
function updateCutButtons(){
  const n=multiSel.size;
  const canDelete=clips&&clips.length>1&&(n>0||(selectedClipIdx>=0&&selectedClipIdx<clips.length));
  const del=$('tlDelSel');if(del)del.disabled=!canDelete;
  const mg=$('tlMerge');if(mg)mg.disabled=!(clips&&clips.length>1);
  const zb=$('tlZoomClip');if(zb)zb.disabled=!(clips&&(n>0||selectedClipIdx>=0));
  const un=$('tlUndo');if(un)un.disabled=!clipUndo.length;
  const edited=clipsEdited();
  const info=$('tlCutInfo');if(info){
    if(n>1) info.textContent=n+' clips seleccionados';
    else { const c=clips&&clips[selectedClipIdx]; info.textContent=(selectedClipIdx>=0&&c)?('Clip '+(selectedClipIdx+1)+'/'+(clips.length)+' · '+fmt(c.end-c.start)):(edited?('Editado · '+(clips.length)+' clips · '+fmt(totalOut())):''); }
  }
  const go=$('tlGoCut');if(go)go.hidden=!edited;
}
function drawSelection(){const inner=tlInner();if(!inner)return;inner.querySelectorAll('.tl-clip').forEach(b=>{const i=+b.dataset.i;b.classList.toggle('selected',i===selectedClipIdx||multiSel.has(i));});updateCutButtons();}
function drawMarquee(x0,x1){const inner=tlInner();if(!inner)return;let m=inner.querySelector('.tl-marquee');if(!m){m=document.createElement('div');m.className='tl-marquee';inner.append(m);}const r=inner.getBoundingClientRect();const a=Math.max(0,Math.min(inner.offsetWidth,x0-r.left)),b=Math.max(0,Math.min(inner.offsetWidth,x1-r.left));m.style.left=Math.min(a,b)+'px';m.style.width=Math.abs(b-a)+'px';}
function clearMarquee(){const inner=tlInner();if(inner){const m=inner.querySelector('.tl-marquee');if(m)m.remove();}}
function refreshOverlays(){drawSelection();}
function tlDuration(){const v=$('video');if(v&&v.duration&&isFinite(v.duration))return v.duration;const t=state?.transcript;return t&&t.length?Number(t[t.length-1].end)||0:0;}
function positionHead(){const head=$('tlHead');if(!head)return;const v=$('video');const src=(v?.currentTime||0)+(playerSourceOffset||0);let o=sourceToOut(src);if(o==null)o=sourceToOut(nearestKeptSource(src));if(o==null)o=0;head.style.left=tlXofOut(o)+'px';}
// Scrub FLUIDO: mientras arrastras, muestra la miniatura del filmstrip más cercana sobre el preview
// (instantáneo, sin esperar el seek lento del <video>). Al soltar se hace un seek preciso y se ve el frame real.
function nearestStripIndex(src){const N=state.filmstrip?state.filmstrip.count:0;if(!N)return 0;const dur=tlDuration();if(!dur)return 0;const interval=dur/N;let k=Math.round(src/interval+0.5);return Math.max(1,Math.min(N,k));}
function showScrubThumb(src){const N=state.filmstrip?state.filmstrip.count:0;const img=$('scrubThumb');if(!img||!N)return;const k=nearestStripIndex(src);if(img.dataset.k!==String(k)){img.dataset.k=String(k);img.src='/api/strip?i='+k;}img.classList.add('show');}
function hideScrubThumb(){const img=$('scrubThumb');if(img)img.classList.remove('show');}
function scrubEndAt(clientX){const v=$('video');if(!v){hideScrubThumb();return;}let src;try{src=outToSource(tlOutFromX(clientX));}catch{src=v.currentTime;}
  const done=()=>{hideScrubThumb();v.removeEventListener('seeked',done);};v.addEventListener('seeked',done);setTimeout(done,500);
  try{v.currentTime=src;}catch{hideScrubThumb();}positionHead();updateTlTime();}
function tlSeekFromX(clientX){const inner=tlInner();if(!inner)return;const o=tlOutFromX(clientX);const src=outToSource(o);const v=$('video');if(v){try{if(tlDrag){v.pause();showScrubThumb(src);if(v.fastSeek){v.fastSeek(src);}else{v.currentTime=src;}}else{v.currentTime=src;}}catch{}}positionHead();updateTlTime();}
function updateTlTime(){const v=$('video'),el=$('tlTime');if(!el)return;const src=(v?.currentTime||0)+(playerSourceOffset||0);let o=sourceToOut(src);if(o==null)o=0;el.textContent=fmt(o)+' / '+fmt(totalOut());}
// Reproducción EDITADA: al reproducir, salta automáticamente los huecos borrados.
let editPlayGuard=0;
function editedPlaybackTick(){
  const v=$('video');if(!v||v.paused||!clips||clips.length<2)return;
  const src=(v.currentTime||0)+(playerSourceOffset||0);
  if(sourceToOut(src)==null){
    const next=(clips||[]).find(c=>c.start>src-0.001);const now=performance.now();
    if(next&&now-editPlayGuard>120){editPlayGuard=now;try{v.currentTime=next.start+0.002;}catch{}}
    else if(!next){try{v.pause();}catch{}}
  }
}
function buildTimeline(){
  const bar=$('timeline'); if(!bar) return;
  const dur=tlDuration(); ensureClips(); const T=totalOut();
  const fp=`${Math.round(dur)}|${tlZoom}|${state.filmstrip?state.filmstrip.count:0}|${clipsSig()}`;
  if(bar.dataset.fp===fp && bar.childElementCount){positionHead();drawSelection();return;}
  bar.dataset.fp=fp; bar.replaceChildren();
  if(!dur||!T){bar.innerHTML='<div class="tl-empty">Abre un video para ver la línea de tiempo.</div>';updateTlTime();return;}
  const inner=document.createElement('div');inner.className='timelineInner';
  // Fit-to-width: a zoom 1 todo el video (editado) cabe en la barra. Zoom >1 lo agranda para detalle.
  const px=Math.round((bar.clientWidth||700)*tlZoom);
  inner.style.width=px+'px';
  const outX=o=>Math.max(0,Math.min(px,o/T*px));
  // Regla en tiempo de SALIDA
  const ruler=document.createElement('div');ruler.className='tl-ruler';
  const approx=T/(px/90);
  const nice=[1,2,5,10,15,30,60,120,300,600,900].find(n=>n>=approx)||1200;
  for(let o=0;o<=T+0.1;o+=nice){const tick=document.createElement('div');tick.className='tl-tick';tick.style.left=outX(o)+'px';const lab=document.createElement('span');lab.textContent=fmt(o).replace(/^0:/,'');tick.append(lab);ruler.append(tick);}
  inner.append(ruler);
  // Clips como BLOQUES separados, cada uno con su rebanada de miniaturas
  const N=state.filmstrip?state.filmstrip.count:0, interval=N?dur/N:0, bounds=clipOutBounds();
  clips.forEach((c,i)=>{
    const L=outX(bounds[i].outStart), R=outX(bounds[i].outEnd), W=Math.max(6,R-L-3);
    const block=document.createElement('div');block.className='tl-clip'+(i===selectedClipIdx?' selected':'')+(c.zoom?' haszoom':'')+(c.trans?' hastrans':'');
    block.style.left=L+'px';block.style.width=W+'px';block.dataset.i=i;
    block.title='Clip '+(i+1)+' · '+fmt(c.end-c.start)+(c.zoom?' · 🔍 zoom':'')+' · pica para seleccionar · Supr para borrar';
    if(c.zoom){const z=document.createElement('div');z.className='tl-zoombadge';z.textContent='🔍';block.append(z);}
    if(c.trans){const tb=document.createElement('div');tb.className='tl-transbadge';tb.textContent='🎬';tb.title='Transición de tema (fundido) al entrar a este clip';block.append(tb);}
    if(N){const row=document.createElement('div');row.className='tl-clipstrip';for(let k=1;k<=N;k++){const tk=(k-0.5)*interval;if(tk>=c.start&&tk<c.end){const img=document.createElement('img');img.loading='lazy';img.draggable=false;img.src='/api/strip?i='+k;row.append(img);}}block.append(row);}
    const hl=document.createElement('div');hl.className='tl-handle l';block.append(hl);
    const hr=document.createElement('div');hr.className='tl-handle r';block.append(hr);
    inner.append(block);
  });
  const head=document.createElement('div');head.className='tl-head';head.id='tlHead';inner.append(head);
  bar.append(inner); positionHead(); updateTlTime(); drawSelection();
}
function frameStep(d){const v=$('video');if(!v)return;try{v.pause();v.currentTime=Math.max(0,(v.currentTime||0)+d);}catch{}positionHead();updateTlTime();}
// Vista previa de la animación del clip (simula el fade con un overlay sobre el reproductor).
// Usa la Web Animations API (más fiable que requestAnimationFrame, que se pausa si la pestaña no se ve).
let animHandle=null, animTick=null, animTimer=null;
function animColor(v){return (v&&v.toLowerCase().includes('blanc'))?'#ffffff':'#000000';}
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
  if(p?.videoPath!==clipsVideo){clipsVideo=p?.videoPath||'';selectedClipIdx=-1;clipUndo=[];clips=null;loadClips();}
  if(!selectionHydrated){selectedPauses=new Set(state.selection?.selectedPauseIds||[]);selectionHydrated=true;}
  if(videoKey!==lastVideo){lastVideo=videoKey;playerSourceOffset=0;playerIsCutPreview=false;const unsupported=p&&!p.previewPath&&/\.(mpg|mpeg|mkv|avi)$/i.test(p.videoPath||'');if(unsupported){$('video').removeAttribute('src');$('playerEmpty').textContent='Preparando la vista previa de este formato… aparecerá en unos momentos.';}else{$('video').src=p?'/api/video?d='+Date.now():'';$('playerEmpty').textContent='Aquí podrás revisar el video y saltar a cada coincidencia.';}$('video').parentElement.classList.toggle('ready',!!p&&!unsupported);$('videoPath').value=p?.videoPath||'';}
  $('termCount').textContent=`${state.dictionary.filter(d=>d.enabled).length} activas`;
  $('matchCount').textContent=`${state.matches.length} coincidencias`;
  buildTranscript();
  // Al terminar "Quitar silencios", aplica los pedazos a conservar como clips (una vez).
  if(p && state.silenceScan && state.silenceScan.scannedAt && state.silenceScan.scannedAt!==silenceApplied && state.job.status==='done' && (Date.now()-state.silenceScan.scannedAt<90000)){
    silenceApplied=state.silenceScan.scannedAt;
    const keep=(state.silenceScan.keep||[]).map(c=>({start:+c.start,end:+c.end}));
    if(keep.length){ ensureClips(); pushUndo(); clips=keep; saveClips(); syncRemoved();
      const sc=state.silenceScan;
      const si=$('silInfo'); if(si) si.textContent=`−${Math.round(sc.saved)}s · ${sc.removed} silencios`;
      notice(`🤫 Quité ${sc.removed} silencio(s): el video pasó de ${Math.floor(sc.total/60)}:${String(Math.round(sc.total%60)).padStart(2,'0')} a ${Math.floor(sc.kept/60)}:${String(Math.round(sc.kept%60)).padStart(2,'0')}. Revisa y exporta (deja "Suavizar cortes" para que no se note). Ctrl+Z para deshacer.`);
    }
  }
  buildTimeline();
  buildScanResults();
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
  ['clipIn','clipOut'].forEach(id=>{const sel=$(id);if(sel && !sel.dataset.filled && (state.clipFx||[]).length){for(const [v,l] of state.clipFx){const o=document.createElement('option');o.value=v;o.textContent=l;sel.append(o);}sel.value='none';sel.dataset.filled='1';}});
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
// Interacciones de clips: arrastrar el cuerpo = MOVER/reordenar · arrastrar el borde = RECORTAR (trim) · clic = seleccionar+ir · regla = scrub.
let dragMode=null, trimState=null, moveState=null;
function edgeHit(block,clientX){const r=block.getBoundingClientRect();if(clientX-r.left<=9)return 'L';if(r.right-clientX<=9)return 'R';return null;}
function doTrim(clientX){const t=trimState;if(!t)return;const c=clips[t.idx];if(!c)return;const dSrc=(clientX-t.startX)/(t.pxStart||1)*(t.totStart||0);
  if(t.side==='R')c.end=Math.max(c.start+0.3,Math.min(tlDuration(),t.startVal+dSrc));
  else c.start=Math.max(0,Math.min(c.end-0.3,t.startVal+dSrc));
  const now=performance.now();if(now-(t.last||0)>70){t.last=now;buildTimeline();}}
function commitTrim(){const c=clips[trimState.idx];saveClips();syncRemoved();buildTimeline();if(c)notice('✂️ Clip recortado a '+fmt(c.end-c.start)+'.');}
function moveClipTo(fromIdx,targetOut){const b=clipOutBounds();let ins=b.findIndex(x=>targetOut<(x.outStart+x.outEnd)/2);if(ins<0)ins=clips.length;
  pushUndo();const[clip]=clips.splice(fromIdx,1);if(ins>fromIdx)ins--;ins=Math.max(0,Math.min(clips.length,ins));clips.splice(ins,0,clip);
  saveClips();selectedClipIdx=ins;syncRemoved();buildTimeline();notice('↔ Clip movido al lugar '+(ins+1)+'.');}
(function(){const bar=$('timeline');if(!bar)return;
  let marquee=null;
  bar.addEventListener('mousedown',e=>{
    if(e.target.closest('.tl-cutx'))return;
    if(e.target.closest('.tl-ruler')){ dragMode='scrub'; tlDrag=true; tlSeekFromX(e.clientX); e.preventDefault(); return; }
    const block=e.target.closest('.tl-clip');
    if(block&&clips&&clips.length){
      const idx=+block.dataset.i;
      // Ctrl/⌘/Shift + clic = agregar/quitar de la selección múltiple (para Unir o borrar varios)
      if(e.ctrlKey||e.metaKey||e.shiftKey){ if(multiSel.has(idx))multiSel.delete(idx); else multiSel.add(idx); if(multiSel.size)selectedClipIdx=-1; drawSelection(); updateCutButtons&&updateCutButtons(); e.preventDefault(); return; }
      if(!multiSel.has(idx)){ multiSel.clear(); selectedClipIdx=idx; } drawSelection();
      const edge=edgeHit(block,e.clientX);
      if(edge){ dragMode='trim'; trimState={idx,side:edge,startX:e.clientX,startVal:edge==='L'?clips[idx].start:clips[idx].end,pxStart:tlInner().offsetWidth,totStart:totalOut(),last:0}; e.preventDefault(); return; }
      // cuerpo del clip → clic = seleccionar (sin mover la barra) · arrastrar = MOVER/reordenar el clip
      dragMode='pending'; moveState={idx,startX:e.clientX,moved:false}; e.preventDefault(); return;
    }
    // espacio vacío (arriba/abajo de los clips) → marquee de selección
    dragMode='marqueePending'; marquee={x0:e.clientX,x1:e.clientX,moved:false}; e.preventDefault();
  });
  window.addEventListener('mousemove',e=>{
    if(dragMode==='scrub'){ tlSeekFromX(e.clientX); return; }
    if(dragMode==='trim'){ doTrim(e.clientX); return; }
    if(dragMode==='pending'&&moveState){ if(Math.abs(e.clientX-moveState.startX)>8){dragMode='move';moveState.moved=true;const bl=tlInner()&&tlInner().querySelector('.tl-clip[data-i="'+moveState.idx+'"]');if(bl)bl.classList.add('moving');} return; }
    if((dragMode==='marqueePending'||dragMode==='marquee')&&marquee){ marquee.x1=e.clientX; if(Math.abs(marquee.x1-marquee.x0)>5){dragMode='marquee';marquee.moved=true;drawMarquee(marquee.x0,marquee.x1);} }
  });
  window.addEventListener('mouseup',e=>{
    if(dragMode==='trim'){ commitTrim(); }
    else if(dragMode==='move'&&moveState){ moveClipTo(moveState.idx,tlOutFromX(e.clientX)); }
    else if(dragMode==='scrub'){ scrubEndAt(e.clientX); }   // seek preciso + ocultar la miniatura
    // 'pending' (clic en clip sin arrastrar) = solo seleccionar (ya hecho en mousedown); NO mueve la barra
    else if(dragMode==='marquee'&&marquee){ clearMarquee(); selectClipsInRange(marquee.x0,marquee.x1); }
    else if(dragMode==='marqueePending'&&marquee){ multiSel.clear(); selectedClipIdx=-1; drawSelection(); }
    dragMode=null; trimState=null; moveState=null; marquee=null; tlDrag=false;
  });
})();
$('video').addEventListener('timeupdate',()=>{editedPlaybackTick();positionHead();updateTlTime();});
// Reconstruye la timeline cuando cambia su ancho (fit-to-width): al mostrarse o al redimensionar la ventana.
(function(){const bar=$('timeline');if(!bar||!window.ResizeObserver)return;let lastW=0;const ro=new ResizeObserver(()=>{const w=bar.clientWidth;if(w>0&&Math.abs(w-lastW)>8){lastW=w;bar.dataset.fp='';buildTimeline();}});ro.observe(bar);})();
// ---- Cortes visuales en la timeline ----
$('tlSplit').onclick=()=>splitAtPlayhead();
$('tlDelSel').onclick=()=>deleteSelectedClip();
$('tlMerge').onclick=()=>mergeClips();
$('tlZoomClip').onclick=()=>toggleZoom();
$('tlZoomAuto').onclick=safe(suggestZooms);
$('tlTopics').onclick=safe(suggestTransitions);
$('tlUndo').onclick=()=>undoClip();
$('tlClearSel').onclick=()=>{selectedClipIdx=-1;drawSelection();notice('Clip deseleccionado.');};
$('tlGoCut').onclick=()=>{goStep(4);const c=document.querySelector('input[name="censorMode"][value="cut"]');if(c){c.checked=true;c.dispatchEvent(new Event('change',{bubbles:true}));}notice('Modo “Cortar” elegido: al Exportar MP4 se quitan los clips borrados y el video se une solo.');};
window.addEventListener('keydown',e=>{
  const step1=!document.querySelector('.step[data-step="1"]').hidden;
  if(!step1)return;
  const t=e.target,tag=(t&&t.tagName||'').toLowerCase();
  if(tag==='input'||tag==='textarea'||tag==='select'||(t&&t.isContentEditable))return;
  const k=e.key.toLowerCase();
  if(k==='d'){e.preventDefault();splitAtPlayhead();return;}
  if((e.ctrlKey||e.metaKey)&&k==='z'){e.preventDefault();undoClip();return;}
  if(k==='z'&&!e.ctrlKey&&!e.metaKey){e.preventDefault();toggleZoom();return;}
  if((e.key==='['||e.key===']')&&clips&&selectedClipIdx>=0){e.preventDefault();const to=selectedClipIdx+(e.key==='['?-1:1);if(to>=0&&to<clips.length){pushUndo();const[c]=clips.splice(selectedClipIdx,1);clips.splice(to,0,c);saveClips();selectedClipIdx=to;syncRemoved();buildTimeline();notice('↔ Clip movido al lugar '+(to+1)+'.');}return;}
  if(e.key==='Delete'||e.key==='Backspace'){
    e.preventDefault();
    deleteSelectedClip();
    return;
  }
  if(e.key==='ArrowLeft'){e.preventDefault();frameStep(e.shiftKey?-1:-1/30);return;}
  if(e.key==='ArrowRight'){e.preventDefault();frameStep(e.shiftKey?1:1/30);return;}
  if(e.key===' '){e.preventDefault();$('tlPlay').click();return;}
});
$('getDf').onclick=async()=>{const b=$('getDf');try{b.disabled=true;b.textContent='Descargando… (25 MB)';await api('/api/download-df',{});notice('✅ Voz Estudio activada. Marca “Realzar voz · Estudio” en el panel de audio.');await refresh();const av=$('auVoice');if(av)av.checked=true;}catch(e){notice('No se pudo activar: '+e.message,true);}finally{b.disabled=false;b.textContent='⬇️ Activar voz Estudio (25 MB)';}};
$('auOff').onclick=()=>{['auDenoise','auCompress','auNormalize','auVoice'].forEach(id=>{const el=$(id);if(el)el.checked=false;});notice('Audio sin procesar: saldrá igual que el original (con las groserías silenciadas).');};
$('animPreviewIn').onclick=()=>previewAnim('in');
$('animPreviewOut').onclick=()=>previewAnim('out');
$('themeToggle').onclick=toggleTheme; applyThemeIcon();
$('rmSilence').onclick=safe(async()=>{
  if(!state.project)throw Error('Abre un video primero.');
  const sens=$('silSens').value;
  const p=sens==='suave'?{noise:35,minSil:1.0}:sens==='fuerte'?{noise:27,minSil:0.35}:sens==='max'?{noise:24,minSil:0.25}:{noise:30,minSil:0.6};
  await api('/api/silences',{...p,pad:0.12});
  notice('🤫 Buscando silencios en el audio… (puedes cancelar arriba). Al terminar los quito y uno el video.');
});
$('scanRun').onclick=safe(async()=>{
  if(!state.project)throw Error('Abre un video primero.');
  const cats=[];if($('scBeso').checked)cats.push('beso');if($('scDesnudez').checked)cats.push('desnudez');if($('scPelea').checked)cats.push('pelea');if($('scDrogas').checked)cats.push('drogas');
  if(!cats.length)throw Error('Marca al menos una cosa que quieras que la IA busque.');
  await api('/api/scan-sensitive',{cats,sensitivity:$('scSens').value,step:Number($('scStep').value)||4,max:400,mode:($('scMode')||{}).value||'rapido'});
  notice('🛡️ Analizando el video con IA (necesita Ollama abierto). Puedes cancelar arriba. Verás las marcas aquí al terminar.');
});
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
function clipsEdited(){ensureClips();if(!clips||!clips.length)return false;if(clips.some(c=>c.zoom))return true;const dur=tlDuration();if(clips.length>1)return true;const c=clips[0];return c.start>0.15||c.end<dur-0.15;}
$('export').onclick=safe(async()=>{await selectionSave;
  const edited=clipsEdited();
  let mode=(document.querySelector('input[name="censorMode"]:checked')||{}).value==='cut'?'cut':'mute';
  const ids=[...selected];const pauseIds=[...selectedPauses];
  let segments=null;
  if(edited){ mode='cut'; segments=clips.map(c=>({start:+c.start.toFixed(3),end:+c.end.toFixed(3),zoom:!!c.zoom,trans:!!c.trans})); }
  else { if(mode==='mute'){if(!ids.length&&!(state.manualCuts||[]).length)throw Error('Para silenciar, selecciona al menos una palabra o agrega un corte manual. (Las pausas solo aplican al modo Cortar.)');}else if(!ids.length&&!pauseIds.length&&!(state.manualCuts||[]).length)throw Error('Selecciona palabras, pausas, o edita clips en la línea del tiempo (Paso 1).'); }
  const enhance={denoise:$('auDenoise')?.checked,compress:$('auCompress')?.checked,normalize:$('auNormalize')?.checked,voice:$('auVoice')?.checked&&!$('auVoice')?.disabled};
  const smooth=edited && !!$('silSmooth')?.checked;
  const r=await api('/api/export',{selectedIds:ids,selectedPauseIds:pauseIds,mode,segments,smooth,quality:($('exportQuality')||{}).value||'original',enhance,intro:($('introTpl')||{}).value||'none',outro:($('outroTpl')||{}).value||'none',clipIn:($('clipIn')||{}).value||'none',clipOut:($('clipOut')||{}).value||'none',clipDur:Number(($('clipDur')||{}).value)||0.8});
  notice(edited?`Exportando tu edición (${segments.length} clip${segments.length>1?'s':''}). El archivo aparecerá en exports.`:(mode==='mute'?`Silenciando ${r.cuts} ${r.cuts===1?'grosería':'groserías'}. El archivo aparecerá en exports.`:`Exportación iniciada con ${r.cuts} cortes. El archivo aparecerá en exports.`));});
$('cancelJob').onclick=safe(async()=>{await api('/api/job/cancel',{});notice('Cancelando el proceso…');});
$('checkUpdate').onclick=async()=>{const info=$('updateInfo');try{$('checkUpdate').disabled=true;info.replaceChildren();info.textContent='Revisando…';const r=await api('/api/update/check',{});info.replaceChildren();if(!r.hasUpdate){info.textContent='✅ Estás en la última versión ('+r.current+').';return;}const txt=document.createElement('span');txt.textContent='Nueva versión '+r.latest+(r.notes?' · '+r.notes:'')+'  ';const go=document.createElement('button');go.className='primary compact';go.type='button';go.textContent='Actualizar ahora';go.onclick=async()=>{try{go.disabled=true;go.textContent='Actualizando…';const a=await api('/api/update/apply',{});info.replaceChildren();info.textContent='✅ '+a.message;}catch(e){info.textContent='Error al actualizar: '+e.message;}};info.append(txt,go);}catch(e){info.replaceChildren();info.textContent='No se pudo revisar: '+e.message;}finally{$('checkUpdate').disabled=false;}};
// Asistente por pasos (wizard)
function goStep(n){n=Math.max(1,Math.min(4,Number(n)||1));document.querySelectorAll('.step').forEach(s=>{s.hidden=Number(s.dataset.step)!==n;});document.querySelectorAll('.wstep').forEach(b=>{const bn=Number(b.dataset.step);b.classList.toggle('active',bn===n);b.classList.toggle('done',bn<n);});try{localStorage.setItem('eirl_step',String(n));}catch{}window.scrollTo({top:0,behavior:'smooth'});if(n===1){const tl=document.getElementById('timeline');if(tl)tl.dataset.fp='';setTimeout(()=>{try{buildTimeline();}catch{}},90);}}
document.querySelectorAll('.wstep').forEach(b=>b.addEventListener('click',()=>goStep(b.dataset.step)));
document.querySelectorAll('[data-go]').forEach(b=>b.addEventListener('click',()=>goStep(b.dataset.go)));
goStep(1); // siempre empezar en el paso 1 (como CapCut), no en el último
refresh().catch(e=>notice(e.message,true));
setInterval(()=>{if(state?.job.status==='running')refresh().catch(()=>{});},1000);
