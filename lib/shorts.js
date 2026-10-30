'use strict';

const { normalize, tokenizeTranscript } = require('./core');
const channelStyle = require('../channel_style.json');

const CUES = new Set(['mira','miren','espera','esperate','increible','dinero','perdi','gane','paso','resulta','problema','nunca','primera','ultima','mames','verga','pendejo','policia','robaron','perdimos','ganamos','sorpresa','ayuda','cuidado','locura','imposible','miedo','corre','corran']);
const LOGISTICS = new Set(['hotel','mapa','incluye','incluido','transportacion','precio','cuesta','tarifa','conexion','senal','celular','reservacion','paquete','dolares']);

function clipWords(words, start, end) {
  return words.filter(w => w.start >= start && w.start < end);
}

function nearestPause(words, target, radius = 6) {
  let choice = target, best = 0;
  for (let i = 1; i < words.length; i++) {
    const gap = words[i].start - words[i - 1].end;
    const at = (words[i - 1].end + words[i].start) / 2;
    const distance = Math.abs(at - target);
    if (distance <= radius && gap >= 0.35) {
      const score = gap / (1 + distance * 0.45);
      if (score > best) { best = score; choice = at; }
    }
  }
  return choice;
}

function scoreWindow(words, start, end, minWords = 65) {
  const slice = clipWords(words, start, end);
  if (slice.length < minWords) return null;
  const duration = end - start;
  const tokens = slice.map(w => w.norm).filter(Boolean);
  const unique = new Set(tokens.filter(t => t.length > 3));
  const density = Math.min(1, slice.length / (duration * 2.3));
  const variety = Math.min(1, unique.size / Math.max(1, slice.length * .43));
  const cues = tokens.filter(t => CUES.has(t)).length;
  const questions = slice.filter(w => /[?¿]/.test(w.text)).length;
  const exclamations = slice.filter(w => /[!¡]/.test(w.text)).length;
  const emotion = Math.min(1, (cues * 1.5 + Math.min(questions,4) + Math.min(exclamations,3) * 2) / 14);
  const first = clipWords(slice, start, start + 10);
  const firstCues = first.filter(w => CUES.has(w.norm) || /[?¿!¡]/.test(w.text)).length;
  const hook = Math.min(1, firstCues / 3);
  const gaps = slice.slice(1).filter((w,i) => w.start - slice[i].end > 2.5).length;
  const deadAir = Math.min(1, gaps / 5);
  const logistics = Math.min(1,tokens.filter(t=>LOGISTICS.has(t)).length/5);
  const score = 100 * (.3*density + .21*variety + .31*emotion + .18*hook - .16*deadAir - .12*logistics);
  return { score: Math.round(score), words: slice.length, firstCues, questions, exclamations,
    reason: [emotion > .5 ? 'preguntas y reacciones' : 'conversación activa', hook > .5 ? 'arranque con gancho' : null, density > .7 ? 'ritmo de voz alto' : null].filter(Boolean).join(' · ') };
}

function suggestShorts(segments, duration, count = 5, opts = {}) {
  const words = tokenizeTranscript(segments);
  const min = opts.min ?? channelStyle.durationSeconds.min;
  const max = opts.max ?? channelStyle.durationSeconds.max;
  const target = (min + max) / 2;
  const step = Math.max(8, Math.round(min / 4));
  const spacing = opts.spacing ?? Math.max(60, Math.round(max * 1.5));
  const minWords = Math.max(25, Math.round(min * 1.1));
  if (!words.length || duration < min) return [];
  const options = [];
  for (let rough = 0; rough + min < duration; rough += step) {
    const start = Math.max(0, nearestPause(words, rough));
    const end = Math.min(duration, nearestPause(words, start + target, 8));
    if (end - start < min || end - start > max) continue;
    const metrics = scoreWindow(words, start, end, minWords);
    if (!metrics) continue;
    const slice = clipWords(words, start, end);
    const opening = slice.slice(0, 20).map(w => w.text.trim()).join(' ').replace(/\s+/g,' ').trim();
    const id = `s${Math.round(start * 10)}_${Math.round(end * 10)}`;
    options.push({ id, start:+start.toFixed(2), end:+end.toFixed(2), opening, ...metrics });
  }
  options.sort((a,b) => b.score-a.score || a.start-b.start);
  const chosen=[];
  for (const item of options) {
    if (chosen.every(c => Math.abs(c.start-item.start) >= spacing && Math.max(c.start,item.start) >= Math.min(c.end,item.end))) chosen.push(item);
    if (chosen.length >= count) break;
  }
  return chosen.map((item,i) => ({ ...item, rank:i+1 }));
}

function assTime(seconds) {
  const n=Math.max(0,Math.round(seconds*100));
  return `${Math.floor(n/360000)}:${String(Math.floor(n%360000/6000)).padStart(2,'0')}:${String(Math.floor(n%6000/100)).padStart(2,'0')}.${String(n%100).padStart(2,'0')}`;
}

function applyCaptionCorrections(words, corrections=[]) {
  if (!Array.isArray(corrections) || !corrections.length) return words;
  const edits=corrections.map(c=>({
    from:normalize(c.from).split(' ').filter(Boolean),
    to:String(c.to||'').trim().split(/\s+/).filter(Boolean)
  })).filter(c=>c.from.length&&c.to.length);
  const corrected=[];
  for(let i=0;i<words.length;) {
    const edit=edits.find(c=>c.from.every((part,j)=>words[i+j]?.norm===part));
    if(!edit) { corrected.push(words[i++]); continue; }
    const start=words[i].start,end=words[i+edit.from.length-1].end;
    edit.to.forEach((item,j)=>corrected.push({text:item,norm:normalize(item),start:start+(end-start)*j/edit.to.length,end:start+(end-start)*(j+1)/edit.to.length,approximate:true}));
    i+=edit.from.length;
  }
  return corrected;
}

// Estilos de subtítulos. Colores en formato .ass &HBBGGRR& (azul,verde,rojo).
const CAPTION_STYLES={
  clasico:{label:'Clásico (amarillo)', size:47, active:'&H0000FFFF&', base:'&H00FFFFFF&', maxWords:4, maxChars:21, pop:100, outline:5},
  verde:{label:'Verde Kick', size:52, active:'&H0018FC53&', base:'&H00FFFFFF&', maxWords:3, maxChars:16, pop:106, outline:5},
  pop:{label:'Pop (1–2 palabras, grande)', size:66, active:'&H0000FFFF&', base:'&H00FFFFFF&', maxWords:2, maxChars:13, pop:114, outline:6},
  karaoke:{label:'Karaoke blanco', size:50, active:'&H00FFFFFF&', base:'&H00B8B8B8&', maxWords:4, maxChars:20, pop:108, outline:4},
  // Como Opus Clip: 1–2 palabras a la vez, letra gruesa tipo cómic, contorno grueso + sombra, clave en amarillo y
  // cada grupo entra con un "pop" (70 %→100 % en 90 ms). La fuente se baja sola (Luckiest Guy, Google Fonts).
  opus:{label:'Opus (1–2 palabras, cómic)', size:84, active:'&H0000FFFF&', base:'&H00FFFFFF&', maxWords:2, maxChars:12, pop:100, outline:8, shadow:4, font:'Luckiest Guy', mode:'group'},
};
function captionStyles() { return Object.entries(CAPTION_STYLES).map(([id,s])=>({id,label:s.label})); }

const FORMATS={vertical:[720,1280],square:[1080,1080],horizontal:[1280,720]};
function makeAss(segments, clip) {
  const st=CAPTION_STYLES[clip.captionStyle]||CAPTION_STYLES.opus;
  const [W,H]=FORMATS[clip.format]||FORMATS.vertical;
  const cx=Math.round(W/2), capY=Math.round(H*0.715), hookY=Math.round(H*0.12), brandY=Math.round(H*0.90);
  // Censura de groserías en el TEXTO del subtítulo (el audio se silencia aparte).
  const censor=Array.isArray(clip.censorRanges)?clip.censorRanges:[];
  const isCensored=w=>censor.some(r=>w.start<r.end&&w.end>r.start);
  const mask=t=>{const s=String(t);return s.length<=1?'*':s[0]+'*'.repeat(Math.min(s.length-1,6));};
  const words=applyCaptionCorrections(tokenizeTranscript(segments).filter(w => w.start >= clip.start && w.start < clip.end),clip.captionCorrections);
  const groups=[];
  for (let i=0;i<words.length;) {
    const group=[words[i++]];
    while (i<words.length && group.length<st.maxWords && words[i].start-group.at(-1).end<.6 && words[i].start-group[0].start<2.4 && group.map(w=>w.text.trim()).join(' ').length+1+words[i].text.trim().length<=st.maxChars) group.push(words[i++]);
    groups.push(group);
  }
  const header=`[Script Info]\nScriptType: v4.00+\nPlayResX: ${W}\nPlayResY: ${H}\nWrapStyle: 0\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Caption,${st.font||'Arial Black'},${st.size},&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,${st.outline},${st.shadow??1},5,35,35,0,1\nStyle: Hook,Arial Black,52,&H00000000,&H00000000,&H00FFFFFF,&H00FFFFFF,-1,0,0,0,100,100,0,0,3,14,0,7,46,35,0,1\nStyle: Brand,Arial Black,31,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,4,1,5,35,35,0,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;
  const clean=s=>String(s||'').replace(/[{}\\]/g,'').replace(/\s+/g,' ').trim();
  const fullEnd=assTime(clip.end-clip.start);
  const lines=[];
  const hook=clean(clip.hook).slice(0,70).toUpperCase();
  if(hook){
    const rows=[]; for(const w of hook.split(' ')){ if(rows.length&&(rows.at(-1)+' '+w).length<=17) rows[rows.length-1]+=' '+w; else rows.push(w); }
    lines.push(`Dialogue: 3,0:00:00.00,${assTime(Math.min(3.2,clip.end-clip.start))},Hook,,0,0,0,,{\\an7\\pos(${Math.round(W*0.06)},${Math.round(H*0.06)})\\fad(0,180)}${rows.slice(0,3).join('\\N')}`);
  }
  const brandHandle=clean(clip.brandHandle === undefined ? channelStyle.brandHandle : clip.brandHandle);
  const brandMark=clean(clip.brandMark === undefined ? (channelStyle.brandMark || 'K') : clip.brandMark);
  if(brandHandle) {
    const brandText=brandMark?`{\\1c&H0018FC53&}${brandMark}{\\1c&H00FFFFFF&}  ${brandHandle}`:brandHandle;
    lines.push(`Dialogue: 1,0:00:00.00,${fullEnd},Brand,,0,0,0,,{\\an5\\pos(${cx},${brandY})}${brandText}`);
  }
  // Resalta PALABRAS CLAVE (de impacto o con ¿?¡!) en el color de acento aunque no sean la palabra activa (look tipo OpusClip).
  const isKeyword=w=>CUES.has(w.norm)||/[!¡?¿]/.test(w.text)||(w.norm&&w.norm.length>=7);
  if(st.mode==='group'){
    for(const g of groups){
      const start=Math.max(0,g[0].start-clip.start), end=Math.min(clip.end-clip.start,Math.max(g.at(-1).end-clip.start,start+.25));
      const content=g.map(w=>`{\\1c${isKeyword(w)?st.active:st.base}}${(isCensored(w)?mask(clean(w.text)):clean(w.text)).toUpperCase()}`).join(' ');
      lines.push(`Dialogue: 2,${assTime(start)},${assTime(end)},Caption,,0,0,0,,{\\an5\\pos(${cx},${capY})\\fscx70\\fscy70\\t(0,90,\\fscx100\\fscy100)}${content}`);
    }
    return header+lines.join('\n')+'\n';
  }
  for(const g of groups) {
    for(let i=0;i<g.length;i++) {
      const start=Math.max(0,g[i].start-clip.start);
      const end=Math.min(clip.end-clip.start,Math.max(i<g.length-1?g[i+1].start-clip.start:g.at(-1).end-clip.start,start+.08));
      const content=g.map((w,j)=>`${j===i?`{\\1c${st.active}\\fscx${st.pop}\\fscy${st.pop}}`:(isKeyword(w)?`{\\1c${st.active}\\fscx100\\fscy100}`:`{\\1c${st.base}\\fscx100\\fscy100}`)}${(isCensored(w)?mask(clean(w.text)):clean(w.text)).toUpperCase()}`).join(' ');
      lines.push(`Dialogue: 2,${assTime(start)},${assTime(end)},Caption,,0,0,0,,{\\an5\\pos(${cx},${capY})}${content}`);
    }
  }
  return header+lines.join('\n')+'\n';
}

module.exports={ suggestShorts, makeAss, scoreWindow, applyCaptionCorrections, captionStyles, CAPTION_STYLES, FORMATS, nearestPause };
