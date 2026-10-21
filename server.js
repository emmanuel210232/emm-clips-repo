'use strict';

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { normalize, findMatches, buildCuts, keptIntervals, adjustedCuts, parseSrt, parseWhisperJson, tokenizeTranscript } = require('./lib/core');
const { suggestShorts, makeAss, captionStyles, CAPTION_STYLES, FORMATS } = require('./lib/shorts');
const { assessCandidate, summarizeAssessment, writePackage } = require('./lib/editorial');
const { detectSubjectX, smoothTrack, cropExpression, zoomExpression } = require('./lib/framing');
const channelStyle = require('./channel_style.json');

const ROOT = __dirname;
const DATA = path.join(ROOT, 'data');
const EXPORTS = path.join(ROOT, 'exports');
const PORT = Number(process.env.EDITOR_IRL_PORT || 4177);
const files = { project: path.join(DATA, 'project.json'), config: path.join(DATA, 'config.json'), transcript: path.join(DATA, 'transcript.json'), shorts: path.join(DATA, 'shorts.json'), adjustments:path.join(DATA,'cut_adjustments.json'), pauses:path.join(DATA,'pauses.json'), manualCuts:path.join(DATA,'manual_cuts.json'), selection:path.join(DATA,'selection.json'), sensitive:path.join(DATA,'sensitive.json'), dictionary: path.join(ROOT, 'dictionary.json') };
fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(EXPORTS, { recursive: true });

function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
function writeJson(file, value) { fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8'); }
let project = readJson(files.project, null);
let config = { ffmpeg: '', ffprobe: '', whisper: '', model: '', brandHandle: channelStyle.brandHandle || '', brandMark: channelStyle.brandMark || '', ...readJson(files.config, {}) };
let dictionary = readJson(files.dictionary, []);
let transcript = readJson(files.transcript, []);
let shorts = readJson(files.shorts, []);
let adjustments = readJson(files.adjustments, {});
let pauses = readJson(files.pauses, []);
let manualCuts = readJson(files.manualCuts, []);
let selection = readJson(files.selection, null);
let sensitiveScan = readJson(files.sensitive, null);
let job = { status: 'idle', message: '', progress: '', percent: 0 };
let activeProc = null; // proceso ffmpeg/whisper en curso (para poder cancelar)
let filmstrip = null; // {count, interval, wave} de la línea de tiempo del video actual
try { if (project) { const sd=path.join(DATA,'strip'); if (fs.existsSync(sd)) { const c=fs.readdirSync(sd).filter(f=>f.endsWith('.jpg')).length; if (c>0) filmstrip={count:c, wave:fs.existsSync(path.join(DATA,'wave.png'))}; } } } catch {}

function parseProgressSeconds(s) {
  // ffmpeg imprime time=00:01:23.45 ; whisper-cli imprime [00:01:23.000 --> ...]
  let m = s.match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (m) return (+m[1])*3600 + (+m[2])*60 + (+m[3]);
  m = s.match(/\[(\d+):(\d+):(\d+(?:\.\d+)?)\s*--?>/);
  if (m) return (+m[1])*3600 + (+m[2])*60 + (+m[3]);
  return null;
}
function progress(total, label) {
  return s => {
    const sec = parseProgressSeconds(s);
    if (sec != null && total > 0) job.percent = Math.max(0, Math.min(99, Math.round(sec/total*100)));
    job.progress = (label ? label+' · ' : '') + (job.percent||0) + '%';
  };
}

function executable(explicit, name) {
  if (explicit && fs.existsSync(explicit)) return explicit;
  const local = path.join(ROOT, 'tools', process.platform === 'win32' ? `${name}.exe` : name);
  if (fs.existsSync(local)) return local;
  const probe = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', [name], { encoding: 'utf8', windowsHide: true });
  return probe.status === 0 ? probe.stdout.trim().split(/\r?\n/)[0] : '';
}
function resolveWhisper() {
  if (config.whisper && fs.existsSync(config.whisper)) return config.whisper;
  const gpu = path.join(ROOT, 'tools-gpu', 'whisper-cli.exe'); // build CUDA (si está, se usa la GPU)
  if (fs.existsSync(gpu)) return gpu;
  return executable('', 'whisper-cli');
}
function readiness() { const preferred=path.join(ROOT,'tools','ggml-large-v3-turbo-q5_0.bin'), fallback=path.join(ROOT,'tools','ggml-small.bin'); const whisper=resolveWhisper(); return { ffmpeg: executable(config.ffmpeg, 'ffmpeg'), ffprobe: executable(config.ffprobe, 'ffprobe'), whisper, whisperGpu: whisper.includes('tools-gpu'), model: config.model && fs.existsSync(config.model) ? config.model : fs.existsSync(preferred) ? preferred : fs.existsSync(fallback) ? fallback : '' }; }
function listExports() { return fs.readdirSync(EXPORTS).filter(name=>/\.(mp4|png|jpe?g)$/i.test(name)).map(name=>({name,modified:fs.statSync(path.join(EXPORTS,name)).mtimeMs})).sort((a,b)=>b.modified-a.modified).slice(0,24); }
function state() { return { project, config, dictionary, transcript, shorts, adjustments, pauses, manualCuts, selection, exports:listExports(), matches: findMatches(transcript, dictionary), readiness: readiness(), captionStyles: captionStyles(), qualities: qualityLabels(), brandTemplates: brandTemplates(), clipFx: clipFxLabels(), dfReady: dfReady(), filmstrip, sensitiveScan, version: APP_VERSION, job }; }
function respond(res, code, data) { const body = JSON.stringify(data); res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), 'access-control-allow-origin': 'http://127.0.0.1:' + PORT }); res.end(body); }
function error(res, err, code = 400) { respond(res, code, { error: String(err.message || err) }); }
async function jsonBody(req) { let size = 0; const chunks=[]; for await (const chunk of req) { size += chunk.length; if (size > 1024*1024) throw Error('Solicitud demasiado grande'); chunks.push(chunk); } return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
function run(exe, args, onOutput = () => {}) { return new Promise((resolve, reject) => { const child = spawn(exe, args, { windowsHide: true, cwd: ROOT }); activeProc = child; let stderr=''; child.stderr.on('data', b => { const s=b.toString(); stderr=(stderr+s).slice(-5000); onOutput(s); }); child.stdout.on('data', b => onOutput(b.toString())); child.on('error', e => { if (activeProc===child) activeProc=null; reject(e); }); child.on('close', code => { if (activeProc===child) activeProc=null; if (code === 0) resolve(); else if (job.cancelRequested) reject(Error('Proceso cancelado por el usuario.')); else reject(Error(`${path.basename(exe)} terminó con código ${code}: ${stderr.slice(-700)}`)); }); }); }
function capture(exe,args,maxBytes=30*1024*1024) { return new Promise((resolve,reject)=>{ const child=spawn(exe,args,{windowsHide:true,cwd:ROOT}); const chunks=[];let size=0,stderr='';child.stdout.on('data',b=>{size+=b.length;if(size>maxBytes){child.kill();reject(Error('Demasiados fotogramas para analizar.'));return;}chunks.push(b)});child.stderr.on('data',b=>{stderr=(stderr+b.toString()).slice(-2000)});child.on('error',reject);child.on('close',code=>code===0?resolve(Buffer.concat(chunks)):reject(Error(`FFmpeg no pudo analizar el encuadre: ${stderr.slice(-500)}`)));}); }
// Diálogos nativos de Windows (abrir/guardar) — la app corre en la PC del usuario.
function nativeDialog(kind, defaultName='') {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve('');
    const safeDefault=String(defaultName).replace(/'/g,"''");
    // Formulario dueño invisible y TopMost: fuerza a que el explorador salga ENCIMA de todo
    // (si no, Windows lo abre detrás del navegador porque node corre oculto).
    const owner = `Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; $o=New-Object System.Windows.Forms.Form; $o.StartPosition='CenterScreen'; $o.Size=New-Object System.Drawing.Size(1,1); $o.Opacity=0; $o.ShowInTaskbar=$false; $o.TopMost=$true; $o.Show(); $o.Activate(); [System.Windows.Forms.Application]::DoEvents();`;
    const ps = kind==='save'
      ? `${owner} $f=New-Object System.Windows.Forms.SaveFileDialog; $f.Filter='Video MP4|*.mp4|Todos los archivos|*.*'; $f.FileName='${safeDefault}'; $f.Title='Guardar video como'; $f.OverwritePrompt=$true; $r=$f.ShowDialog($o); $o.Close(); if($r -eq [System.Windows.Forms.DialogResult]::OK){[Console]::Out.Write($f.FileName)}`
      : `${owner} $f=New-Object System.Windows.Forms.OpenFileDialog; $f.Filter='Videos|*.mp4;*.mov;*.mkv;*.webm;*.avi;*.m4v;*.mpg;*.mpeg|Todos los archivos|*.*'; $f.Title='Elige el video del directo'; $r=$f.ShowDialog($o); $o.Close(); if($r -eq [System.Windows.Forms.DialogResult]::OK){[Console]::Out.Write($f.FileName)}`;
    const child=spawn('powershell.exe',['-NoProfile','-STA','-Command',ps],{windowsHide:true});
    let out=''; child.stdout.on('data',b=>out+=b.toString()); child.on('error',()=>resolve('')); child.on('close',()=>resolve(out.trim()));
  });
}
// ===== Auto-actualizador (descarga el codigo nuevo desde GitHub) =====
const APP_VERSION = '1.5.0';
const UPDATE_RAW = 'https://raw.githubusercontent.com/emmanuel210232/emm-clips-repo/main/';
const UPDATE_ALLOW = new Set(['.js','.html','.css','.cmd','.ps1','.json']);
function cmpVer(a,b){const pa=String(a).split('.').map(n=>parseInt(n,10)||0),pb=String(b).split('.').map(n=>parseInt(n,10)||0);for(let i=0;i<3;i++){if((pa[i]||0)>(pb[i]||0))return 1;if((pa[i]||0)<(pb[i]||0))return -1;}return 0;}
async function fetchText(url){const r=await fetch(url,{signal:AbortSignal.timeout(20000),cache:'no-store'});if(!r.ok)throw Error('No se pudo descargar ('+r.status+')');return r.text();}
async function checkUpdate(){
  const manifest=JSON.parse(await fetchText(UPDATE_RAW+'version.json?t='+Date.now()));
  const latest=String(manifest.version||'0');
  return {current:APP_VERSION, latest, hasUpdate:cmpVer(latest,APP_VERSION)>0, notes:String(manifest.notes||''), files:Array.isArray(manifest.files)?manifest.files:[]};
}
async function applyUpdate(){
  const info=await checkUpdate();
  if(!info.hasUpdate) return {applied:0, message:'Ya tienes la última versión ('+APP_VERSION+').'};
  let applied=0;
  for(const rel of info.files){
    const safe=String(rel).replace(/\\/g,'/');
    if(safe.includes('..')||safe.startsWith('/')||/^[a-zA-Z]:/.test(safe)) throw Error('Ruta insegura en la actualización: '+rel);
    if(!UPDATE_ALLOW.has(path.extname(safe).toLowerCase())) throw Error('Tipo de archivo no permitido: '+rel);
    const content=await fetchText(UPDATE_RAW+safe+'?t='+Date.now());
    const dest=path.join(ROOT,safe);
    if(!dest.startsWith(ROOT)) throw Error('Destino fuera de la app: '+rel);
    await fsp.mkdir(path.dirname(dest),{recursive:true});
    await fsp.writeFile(dest,content,'utf8');
    applied++;
  }
  return {applied, latest:info.latest, message:`Actualizado a la versión ${info.latest}. Cierra y vuelve a abrir la app para aplicar los cambios.`};
}
function videoDimensions(videoPath) { const bin=readiness().ffprobe;if(!bin) throw Error('Configura ffprobe antes de crear el Short.'); const out=spawnSync(bin,['-v','error','-select_streams','v:0','-show_entries','stream=width,height','-of','json',videoPath],{encoding:'utf8',windowsHide:true}); const stream=JSON.parse(out.stdout||'{}').streams?.[0]; if(out.status!==0||!stream?.width||!stream?.height) throw Error('No pude leer el tamaño del video.'); return stream; }
async function framingForClip(clip,bin,width,height) {
  if(width<=height*9/16) return {portrait:true};
  if(clip.framingMode==='blur') return null;
  if(clip.framingMode==='manual') {const cropWidth=Math.floor((height*9/16)/2)*2,maxLeft=width-cropWidth;return {track:[{t:0,x:+Math.max(0,Math.min(maxLeft,(Number(clip.cropCenter)||.5)*width-cropWidth/2)).toFixed(1)}],cropWidth,confidence:1};}
  const interval=3,frameBytes=320*180*3;
  const raw=await capture(bin,['-hide_banner','-loglevel','error','-ss',String(clip.start),'-t',String(clip.end-clip.start),'-i',project.videoPath,'-vf',`fps=1/${interval},scale=320:180,format=rgb24`,'-f','rawvideo','pipe:1']);
  const observations=[];
  for(let i=0;i+frameBytes<=raw.length;i+=frameBytes) observations.push({t:observations.length*interval,subject:detectSubjectX(raw.subarray(i,i+frameBytes),320,180)});
  return smoothTrack(observations,width,height);
}
async function durationOf(videoPath) {
  const bin = readiness().ffprobe;
  if (!bin) throw Error('Configura ffprobe para leer la duración del video.');
  const out = spawnSync(bin, ['-v','error','-show_entries','format=duration','-of','default=noprint_wrappers=1:nokey=1',videoPath], { encoding:'utf8', windowsHide:true });
  const seconds = Number(out.stdout?.trim());
  if (out.status !== 0 || !Number.isFinite(seconds) || seconds <= 0) throw Error('No se pudo leer la duración del video.');
  return seconds;
}
async function importTranscript(file) {
  const input = await fsp.readFile(file, 'utf8');
  const parsed = path.extname(file).toLowerCase() === '.json' ? parseWhisperJson(JSON.parse(input)) : parseSrt(input);
  if (!parsed.length) throw Error('La transcripción no tiene segmentos válidos. Usa SRT o JSON de whisper.cpp.');
  transcript = parsed;
  writeJson(files.transcript, transcript);
  adjustments={};writeJson(files.adjustments,adjustments);
  selection=null;writeJson(files.selection,selection);
  shorts = [];
  writeJson(files.shorts, shorts);
  if (project) { project.transcriptSource = file; writeJson(files.project, project); }
}
async function transcribe() {
  const bins = readiness();
  if (!project?.videoPath) throw Error('Abre un video primero.');
  if (!bins.ffmpeg || !bins.whisper || !bins.model) throw Error('Configura FFmpeg, whisper-cli y un modelo multilingüe antes de transcribir.');
  if (job.status === 'running') throw Error('Ya hay un proceso en curso.');
  const total = await durationOf(project.videoPath).catch(() => 0);
  job = { status:'running', message:'Extrayendo audio…', progress:'', percent:0, cancelRequested:false };
  const wav = path.join(DATA, 'audio.wav');
  const outputBase = path.join(DATA, 'whisper');
  (async () => {
    try {
      await run(bins.ffmpeg, ['-y','-i',project.videoPath,'-vn','-ar','16000','-ac','1','-c:a','pcm_s16le',wav], progress(total,'Audio'));
      job.message='Transcribiendo en español…'; job.progress=''; job.percent=0;
      const prompt = channelStyle.transcriptionPrompt || 'Conversación informal en español de México. Directo, chat, güey, no mames.';
      await run(bins.whisper, ['-m',bins.model,'-f',wav,'-l','es','-ml','1','-sow','-ojf','-of',outputBase,'--prompt',prompt], progress(total,'Texto'));
      await importTranscript(outputBase + '.json');
      job = { status:'done', message:`Transcripción lista: ${transcript.length} segmentos.`, progress:'', percent:100 };
    } catch (e) { job = { status: job.cancelRequested?'cancelled':'error', message:e.message, progress:'', percent:0 }; }
    finally { fsp.unlink(wav).catch(() => {}); }
  })();
}
// Cadena de mejora de voz (denoise + compresor + nivelado tipo estudio). Local, sin modelos externos.
const AUDIO_ENHANCE = "highpass=f=90,afftdn=nr=12,acompressor=threshold=-18dB:ratio=3:attack=5:release=120,loudnorm=I=-16:TP=-1.5:LRA=11";
// Construye la cadena de audio a partir de la configuración elegida.
// enhance puede ser: 'none' | 'std' | 'studio' | true  (compatibilidad),
// o un objeto {denoise, compress, normalize, voice} desde el panel de audio.
function buildAudioFilter(enhance){
  if(enhance==='none'||enhance===false||enhance==null) return {chain:'',studio:false};
  if(enhance==='std'||enhance===true) return {chain:AUDIO_ENHANCE,studio:false};
  if(enhance==='studio') return {chain:'',studio:dfReady()}; // DeepFilterNet nivela por su cuenta
  if(typeof enhance==='object'){
    const studio = !!enhance.voice && dfReady();
    const parts=[];
    if(enhance.denoise){ parts.push('highpass=f=90','afftdn=nr=12'); }
    if(enhance.compress){ parts.push('acompressor=threshold=-18dB:ratio=3:attack=5:release=120'); }
    if(enhance.normalize && !studio){ parts.push('loudnorm=I=-16:TP=-1.5:LRA=11'); } // studio ya nivela
    return {chain:parts.join(','),studio};
  }
  return {chain:'',studio:false};
}
// Presets de calidad de exportación.
const QUALITY = {
  original: { label:'Original · máxima calidad (recomendado)', copy:true },
  hd60:     { label:'1080p · 60 fps', scale:'scale=-2:1080', fps:60, crf:20 },
  hd30:     { label:'1080p · 30 fps', scale:'scale=-2:1080', fps:30, crf:20 },
  lite:     { label:'Comprimido (1080p, liviano)', scale:'scale=-2:1080', crf:24 },
};
function qualityLabels(){ return Object.entries(QUALITY).map(([id,q])=>({id,label:q.label})); }
// Reencodeo visualmente SIN pérdida (crf 18 = calidad alta, conserva resolución original). Se usa cuando no se puede copiar el stream tal cual.
const HQ_VIDEO = ['-c:v','libx264','-preset','medium','-crf','18','-pix_fmt','yuv420p'];
// Plantillas de intro/outro (fondo + color de texto; animación fade). Propias, no de CapCut.
// Plantillas de intro/outro: cada una combina un LOOK (colores) con un MOVIMIENTO del texto.
// El clip siempre funde a/desde negro en los bordes → transición suave con el video.
const BRAND_TPL = {
  none:       { label:'Sin animación' },
  fundNegro:  { label:'Fundido · negro + verde', bg:'black',    fg:'0x18FC53', motion:'fade' },
  fundVerde:  { label:'Fundido · verde Kick',     bg:'0x18FC53', fg:'black',    motion:'fade' },
  fundBlanco: { label:'Fundido · blanco limpio',  bg:'white',    fg:'0x1f6b33', motion:'fade' },
  deslizNegro:{ label:'Deslizar · negro + verde', bg:'black',    fg:'0x18FC53', motion:'slide' },
  deslizVerde:{ label:'Deslizar · verde Kick',    bg:'0x18FC53', fg:'black',    motion:'slide' },
  subeNegro:  { label:'Subir · negro + verde',    bg:'black',    fg:'0x18FC53', motion:'rise' },
  destelloKick:{label:'Destello · verde Kick',    bg:'0x18FC53', fg:'black',    motion:'flash' },
};
function brandTemplates(){ return Object.entries(BRAND_TPL).map(([id,t])=>({id,label:t.label})); }
function videoFps(p){ const bin=readiness().ffprobe; const out=spawnSync(bin,['-v','error','-select_streams','v:0','-show_entries','stream=avg_frame_rate','-of','default=nw=1:nk=1',p],{encoding:'utf8',windowsHide:true}); const m=String(out.stdout).trim().match(/(\d+)\/(\d+)/); const f=m&&+m[2]?Math.round(+m[1]/+m[2]):30; return (f>=1&&f<=120)?f:30; }
async function makeBrandClip(bin,isOutro,template,W,H,fps,handle,out){
  const t=BRAND_TPL[template]||BRAND_TPL.fundNegro, dur=2.5, fontsize=Math.round(H/11);
  const text=String(handle||'@TuCanal').replace(/[':\\%]/g,'').slice(0,40)||'@TuCanal';
  const motion=t.motion||'fade';
  const inD=0.6, outD=0.6;
  const prog=`min(1,t/${inD})`;                       // 0→1 durante la entrada
  const outP=`max(0,(t-(${dur}-${outD}))/${outD})`;   // 0→1 durante la salida
  let x='(w-text_w)/2', y='(h-text_h)/2', alpha='1';
  if(motion==='slide'){
    x = isOutro ? `(w-text_w)/2 + ((w+text_w)/2)*${outP}` : `-text_w + ((w+text_w)/2)*${prog}`;
  } else if(motion==='rise'){
    y = isOutro ? `(h-text_h)/2 + (h/2)*${outP}` : `(h-text_h)/2 + (h/2)*(1-${prog})`;
  } else if(motion==='flash'){
    alpha = `if(lt(t,0.35),0.25+0.75*abs(sin(t*28)),1)`;
  }
  // x/y/alpha van entre comillas: pueden contener comas (min(1,t)…) que ffmpeg leería como separador de filtros.
  const dt=`drawtext=fontfile='C\\:/Windows/Fonts/ariblk.ttf':text='${text}':fontcolor=${t.fg}:fontsize=${fontsize}:x='${x}':y='${y}':alpha='${alpha}'`;
  const vf=`${dt},fade=t=in:st=0:d=0.3:color=black,fade=t=out:st=${(dur-0.3).toFixed(2)}:d=0.3:color=black`;
  await run(bin,['-y','-f','lavfi','-i',`color=c=${t.bg}:s=${W}x${H}:d=${dur}:r=${fps}`,'-f','lavfi','-i','anullsrc=r=48000:cl=stereo','-t',String(dur),'-vf',vf,'-c:v','libx264','-pix_fmt','yuv420p','-r',String(fps),'-c:a','aac','-ar','48000','-shortest',out]);
}
// DeepFilterNet (voz nivel estudio, IA local). Binario opcional en tools/.
const DF_BIN = path.join(ROOT,'tools', process.platform==='win32'?'deep-filter.exe':'deep-filter');
function dfReady(){ return fs.existsSync(DF_BIN); }
async function studioEnhance(bin,inVideo,outVideo){
  const base=path.join(DATA,`df_${crypto.randomUUID()}`), inDir=base+'_in', outDir=base+'_out';
  await fsp.mkdir(inDir,{recursive:true}); await fsp.mkdir(outDir,{recursive:true});
  const inWav=path.join(inDir,'a.wav');
  await run(bin,['-y','-i',inVideo,'-vn','-ar','48000','-ac','2',inWav]);
  await run(DF_BIN,[inWav,'-o',outDir]);
  const enhWav=path.join(outDir,'a.wav');
  if(!fs.existsSync(enhWav)) throw Error('DeepFilterNet no generó el audio.');
  await run(bin,['-y','-i',inVideo,'-i',enhWav,'-map','0:v:0','-map','1:a:0','-af','loudnorm=I=-16:TP=-1.5:LRA=11','-c:v','copy','-c:a','aac','-b:a','192k','-movflags','+faststart',outVideo]);
  await fsp.rm(inDir,{recursive:true,force:true}).catch(()=>{});
  await fsp.rm(outDir,{recursive:true,force:true}).catch(()=>{});
}
// Animación del clip (fade in/out sencillo, estilo CapCut) sobre el inicio/final del video.
// Catálogo de EFECTOS de entrada/salida del clip, usando las transiciones integradas de ffmpeg (xfade contra negro/blanco).
// Sin descargas: ffmpeg ya trae ~58 transiciones.
const CLIP_FX = {
  none:{},
  negro:{tr:'fade',color:'black'}, blanco:{tr:'fadewhite',color:'white'}, // compatibilidad con valores viejos
  fundNegro:{tr:'fade',color:'black'}, fundBlanco:{tr:'fadewhite',color:'white'},
  disolver:{tr:'dissolve',color:'black'},
  deslizaIzq:{tr:'slideleft',color:'black'}, deslizaDer:{tr:'slideright',color:'black'},
  deslizaArriba:{tr:'slideup',color:'black'}, deslizaAbajo:{tr:'slidedown',color:'black'},
  barrido:{tr:'wiperight',color:'black'}, circulo:{tr:'circleopen',color:'black'},
  pixeles:{tr:'pixelize',color:'black'}, zoom:{tr:'zoomin',color:'black'},
  radial:{tr:'radial',color:'black'}, cubrir:{tr:'coverright',color:'black'},
  desenfoque:{tr:'hblur',color:'black'}, persiana:{tr:'wipeup',color:'black'},
};
function clipFxLabels(){ return [
  ['none','Ninguno'],['fundNegro','Fundido negro'],['fundBlanco','Fundido blanco'],['disolver','Disolver'],
  ['deslizaIzq','Deslizar ←'],['deslizaDer','Deslizar →'],['deslizaArriba','Deslizar ↑'],['deslizaAbajo','Deslizar ↓'],
  ['barrido','Barrido'],['persiana','Persiana'],['circulo','Círculo'],['pixeles','Pixeles'],
  ['zoom','Zoom'],['radial','Radial'],['cubrir','Cubrir'],['desenfoque','Desenfoque'],
]; }
async function applyClipAnim(bin,inFile,outFile,clipIn,clipOut,dur){
  const total=await durationOf(inFile).catch(()=>0);
  const d=Math.max(0.3,Math.min(3,Number(dur)||0.8));
  const inFx=CLIP_FX[clipIn]||{}, outFx=CLIP_FX[clipOut]||{};
  const hasIn=!!inFx.tr, hasOut=!!outFx.tr && total>d*2;
  if(!hasIn&&!hasOut){ await fsp.rename(inFile,outFile); return; }
  const {width,height}=videoDimensions(inFile); const fps=videoFps(inFile);
  const inputs=['-i',inFile]; const parts=[`[0:v]settb=AVTB,fps=${fps},format=yuv420p,setsar=1[m]`];
  let vlabel='[m]', idx=1;
  if(hasIn){ inputs.push('-f','lavfi','-t',String(d),'-i',`color=c=${inFx.color}:s=${width}x${height}:r=${fps}`); parts.push(`[${idx}:v]settb=AVTB,fps=${fps},format=yuv420p,setsar=1[bi]`); parts.push(`[bi]${vlabel}xfade=transition=${inFx.tr}:duration=${d}:offset=0[vi]`); vlabel='[vi]'; idx++; }
  if(hasOut){ inputs.push('-f','lavfi','-t',String(d),'-i',`color=c=${outFx.color}:s=${width}x${height}:r=${fps}`); parts.push(`[${idx}:v]settb=AVTB,fps=${fps},format=yuv420p,setsar=1[bo]`); parts.push(`${vlabel}[bo]xfade=transition=${outFx.tr}:duration=${d}:offset=${(total-d).toFixed(3)}[vo]`); vlabel='[vo]'; idx++; }
  await run(bin,['-y',...inputs,'-filter_complex',parts.join(';'),'-map',vlabel,'-map','0:a?',...HQ_VIDEO,'-c:a','aac','-b:a','192k','-movflags','+faststart',outFile],progress(total||0,'Efecto'));
}
async function finalizeExport(bin,temporary,output,intro,outro,studio,clipIn='none',clipOut='none',clipDur=0.8){
  let main=temporary;
  if(studio && dfReady()){
    job.message='Mejorando voz (estudio / DeepFilterNet)…';
    const enh=path.join(DATA,`enh_${crypto.randomUUID()}.mp4`);
    await studioEnhance(bin,temporary,enh);
    await fsp.unlink(temporary).catch(()=>{});
    main=enh;
  }
  // Animación del clip (fade in/out). Reencoda el video completo solo si se eligió alguna.
  if((clipIn&&clipIn!=='none')||(clipOut&&clipOut!=='none')){
    job.message='Aplicando animación del clip…';
    const anim=path.join(DATA,`anim_${crypto.randomUUID()}.mp4`);
    await applyClipAnim(bin,main,anim,clipIn,clipOut,clipDur);
    await fsp.unlink(main).catch(()=>{});
    main=anim;
  }
  // Si no hay intro/outro, solo renombra. Si hay, genera los clips y concatena.
  if((!intro||intro==='none')&&(!outro||outro==='none')){ await fsp.rename(main,output); return; }
  job.message='Agregando intro/outro…';
  const {width,height}=videoDimensions(main); const fps=videoFps(main);
  const handle=config.brandHandle||channelStyle.brandHandle||'@TuCanal';
  const clips=[];
  if(intro&&intro!=='none'){ const p=path.join(DATA,`intro_${crypto.randomUUID()}.mp4`); await makeBrandClip(bin,false,intro,width,height,fps,handle,p); clips.push(p); }
  clips.push(main);
  if(outro&&outro!=='none'){ const p=path.join(DATA,`outro_${crypto.randomUUID()}.mp4`); await makeBrandClip(bin,true,outro,width,height,fps,handle,p); clips.push(p); }
  const inputs=[]; clips.forEach(c=>inputs.push('-i',c));
  const parts=[], labels=[];
  clips.forEach((_,i)=>{ parts.push(`[${i}:v]scale=${width}:${height},setsar=1,fps=${fps},format=yuv420p[v${i}];[${i}:a]aresample=48000,aformat=channel_layouts=stereo[a${i}]`); labels.push(`[v${i}][a${i}]`); });
  parts.push(`${labels.join('')}concat=n=${clips.length}:v=1:a=1[v][a]`);
  await run(bin,['-y',...inputs,'-filter_complex',parts.join(';'),'-map','[v]','-map','[a]',...HQ_VIDEO,'-c:a','aac','-b:a','192k','-movflags','+faststart',output]);
  for(const c of clips) await fsp.unlink(c).catch(()=>{});
}
async function exportVideo(selectedIds,selectedPauseIds=[],mode='mute',quality='original',enhance='std',intro='none',outro='none',clipIn='none',clipOut='none',clipDur=0.8,segments=null) {
  const q = QUALITY[quality] || QUALITY.original;
  const {chain:audioChain, studio:studioOn} = buildAudioFilter(enhance);
  const stdEnhance = !!audioChain;
  const bins = readiness();
  if (!project?.videoPath) throw Error('Abre un video primero.');
  if (!bins.ffmpeg || !bins.ffprobe) throw Error('Configura FFmpeg y ffprobe antes de exportar.');
  if (job.status === 'running') throw Error('Ya hay un proceso en curso.');
  const duration = await durationOf(project.videoPath);
  const matches = findMatches(transcript, dictionary);
  const words = tokenizeTranscript(transcript);
  const baseName = path.parse(project.videoPath).name.replace(/[^\p{L}\p{N}._-]+/gu,'_').slice(0,80);
  if (mode === 'mute') {
    // Silencia las groserías sin quitar tiempo: el video queda continuo (sin saltos) y solo se calla el audio.
    const ranges = adjustedCuts(matches, selectedIds, duration, words, adjustments, manualCuts);
    if (!ranges.length) throw Error('Selecciona al menos una palabra o agrega un corte manual para silenciar.');
    const pad = 0.15; // margen para cubrir el timing aproximado de whisper y no dejar oír la palabra
    const enable = ranges.map(r=>`between(t,${Math.max(0,r.start-pad).toFixed(3)},${Math.min(duration,r.end+pad).toFixed(3)})`).join('+');
    const output = path.join(EXPORTS, `${baseName}_censurado${q.copy?'':'_'+quality}_${Date.now()}.mp4`);
    const temporary = path.join(DATA, `export_${crypto.randomUUID()}.mp4`);
    let videoArgs;
    if(q.copy) videoArgs=['-c:v','copy'];
    else { const vf=[q.scale,q.fps?`fps=${q.fps}`:null].filter(Boolean).join(','); videoArgs=['-c:v','libx264','-preset','veryfast','-crf',String(q.crf||20),'-pix_fmt','yuv420p',...(vf?['-vf',vf]:[])]; }
    job = { status:'running', message:q.copy?`Silenciando ${ranges.length} ${ranges.length===1?'grosería':'groserías'}…`:`Silenciando y exportando (${q.label})…`, progress:'', percent:0, cancelRequested:false };
    (async () => {
      try {
        const af = `volume=enable='${enable}':volume=0`+(audioChain?`,${audioChain}`:'');
        const base=['-y','-i',project.videoPath,'-map','0:v:0','-map','0:a:0'];
        const tail=['-af',af,'-c:a','aac','-b:a','192k','-movflags','+faststart',temporary];
        try {
          await run(bins.ffmpeg, [...base,...videoArgs,...tail], progress(duration,q.copy?'Silenciando':'Exportando'));
        } catch(copyErr) {
          if(!q.copy||job.cancelRequested) throw copyErr;
          // El formato (p.ej. .mpg/MPEG-2) no deja copiar el video tal cual → reencoda SIN pérdida visible (crf 18, misma resolución).
          job.message='Reencodeando en máxima calidad (el formato no permitía copiar)…'; job.percent=0;
          await run(bins.ffmpeg, [...base,...HQ_VIDEO,...tail], progress(duration,'Exportando (máxima calidad)'));
        }
        await finalizeExport(bins.ffmpeg,temporary,output,intro,outro,studioOn,clipIn,clipOut,clipDur);
        job = { status:'done', message:`Video con groserías silenciadas: ${output}`, progress:'', percent:100, output };
      } catch (e) { await fsp.unlink(temporary).catch(()=>{}); job = { status: job.cancelRequested?'cancelled':'error', message: job.cancelRequested?e.message:`No se pudo silenciar: ${e.message}`, progress:'', percent:0 }; }
    })();
    return { output, cuts: ranges.length, mode };
  }
  // Si el editor de clips manda "segments" (los clips en orden), se concatenan EN ESE ORDEN (soporta reordenar/trim).
  let keep;
  if (Array.isArray(segments) && segments.length) {
    keep = segments.map(s=>({start:Math.max(0,+s.start),end:Math.min(duration,+s.end)})).filter(s=>Number.isFinite(s.start)&&Number.isFinite(s.end)&&s.end-s.start>=0.04);
    if (!keep.length) throw Error('Los clips no son válidos.');
  } else {
    const chosenPauses=pauses.filter(p=>selectedPauseIds.includes(p.id));
    const cuts = adjustedCuts(matches, selectedIds, duration, words, adjustments,[...chosenPauses,...manualCuts]);
    if (!cuts.length) throw Error('Selecciona al menos una palabra o pausa para cortar.');
    keep = keptIntervals(cuts, duration);
    if (!keep.length) throw Error('Los cortes eliminarían el video completo.');
  }
  const keptTotal = keep.reduce((a,k)=>a+(k.end-k.start),0);
  const filter = [];
  keep.forEach((k,i) => {
    filter.push(`[0:v]trim=start=${k.start.toFixed(3)}:end=${k.end.toFixed(3)},setpts=PTS-STARTPTS[v${i}]`);
    const length=k.end-k.start,fade=Math.min(.012,length/3);
    filter.push(`[0:a]atrim=start=${k.start.toFixed(3)}:end=${k.end.toFixed(3)},asetpts=PTS-STARTPTS,afade=t=in:st=0:d=${fade.toFixed(3)},afade=t=out:st=${(length-fade).toFixed(3)}:d=${fade.toFixed(3)}[a${i}]`);
  });
  filter.push(keep.map((_,i) => `[v${i}][a${i}]`).join('') + `concat=n=${keep.length}:v=1:a=1[v][a]`);
  const aLabel = stdEnhance ? '[aout]' : '[a]';
  if (stdEnhance) filter.push(`[a]${audioChain}[aout]`);
  let vLabel='[v]';
  if(!q.copy && (q.scale||q.fps)){const vf=[q.scale,q.fps?`fps=${q.fps}`:null].filter(Boolean).join(',');filter.push(`[v]${vf}[vout]`);vLabel='[vout]';}
  const cutCrf=String(q.crf||18);
  const script = path.join(DATA,'filter.txt');
  await fsp.writeFile(script, filter.join(';\n'), 'utf8');
  const name = path.parse(project.videoPath).name.replace(/[^\p{L}\p{N}._-]+/gu,'_').slice(0,80);
  const output = path.join(EXPORTS, `${name}_limpio_${Date.now()}.mp4`);
  const temporary = path.join(DATA, `export_${crypto.randomUUID()}.mp4`);
  job = { status:'running', message:'Exportando video limpio…', progress:'', percent:0, cancelRequested:false };
  (async () => {
    try {
      await run(bins.ffmpeg, ['-y','-i',project.videoPath,'-/filter_complex',script,'-map',vLabel,'-map',aLabel,'-c:v','libx264','-pix_fmt','yuv420p','-preset','medium','-crf',cutCrf,'-c:a','aac','-b:a','192k','-movflags','+faststart',temporary], progress(keptTotal,'Exportando'));
      await finalizeExport(bins.ffmpeg,temporary,output,intro,outro,studioOn,clipIn,clipOut,clipDur);
      job = { status:'done', message:`Video exportado: ${output}`, progress:'', percent:100, output };
    } catch (e) { await fsp.unlink(temporary).catch(()=>{});job = { status: job.cancelRequested?'cancelled':'error', message:e.message, progress:'', percent:0 }; }
  })();
  return { output, cuts:keep.length };
}
async function analyzePauses() {
  const bin=readiness().ffmpeg;
  if(!project?.videoPath||!bin) throw Error('Abre un video y configura FFmpeg.');
  if(job.status==='running') throw Error('Ya hay un proceso en curso.');
  const total=await durationOf(project.videoPath).catch(()=>0);
  job={status:'running',message:'Buscando pausas largas en el audio…',progress:'',percent:0,cancelRequested:false};
  (async()=>{
    try {
      let log='';
      const report=progress(total,'Pausas');
      await run(bin,['-hide_banner','-i',project.videoPath,'-vn','-af','silencedetect=noise=-35dB:d=1.5','-f','null','NUL'],s=>{log=(log+s).slice(-1000000);report(s);});
      const found=[];let start=null;
      for(const line of log.split(/\r?\n/)) {
        const a=line.match(/silence_start:\s*([\d.]+)/),b=line.match(/silence_end:\s*([\d.]+)/);
        if(a) start=Number(a[1]);
        if(b&&start!==null) {const end=Number(b[1]);if(end-start>=1.5&&end-start>.7)found.push({id:`p${Math.round(start*100)}`,start:+(start+.35).toFixed(2),end:+(end-.35).toFixed(2),duration:+(end-start).toFixed(2)});start=null;}
      }
      pauses=found.slice(0,500);writeJson(files.pauses,pauses);
      job={status:'done',message:`Encontré ${pauses.length} ${pauses.length===1?'pausa':'pausas'} para revisar. No se cortan hasta que las selecciones.`,progress:'',percent:100};
    }catch(e){job={status: job.cancelRequested?'cancelled':'error',message:e.message,progress:'',percent:0};}
  })();
  return {started:true};
}
async function proposeShorts() {
  if (!project?.videoPath || !transcript.length) throw Error('Abre y transcribe un video primero.');
  if (job.status==='running') throw Error('Espera a que termine el proceso actual.');
  const duration=await durationOf(project.videoPath);
  const candidates=suggestShorts(transcript,duration,16,{min:30,max:60});
  if (!candidates.length) throw Error('La transcripción no tiene suficientes momentos para Shorts.');
  const hooksById=new Map(shorts.map(s=>[s.id,s.hook||'']));
  const correctionsById=new Map(shorts.map(s=>[s.id,s.captionCorrections||[]]));
  const settingsById=new Map(shorts.map(s=>[s.id,{framingMode:s.framingMode||'auto',cropCenter:s.cropCenter??.5,zoomEnabled:s.zoomEnabled!==false,captionStyle:s.captionStyle||'verde'}]));
  job={status:'running',message:'Evaluando escenas con un modelo local…',progress:'',percent:0,cancelRequested:false};
  (async()=>{
    try {
      const model=process.env.EDITOR_IRL_MODEL||'gemma3:4b';
      const tags=await fetch('http://127.0.0.1:11434/api/tags',{signal:AbortSignal.timeout(3000)}).then(r=>r.json());
      if (!tags.models?.some(m=>m.name===model)) throw Error('Modelo local no disponible');
      const words=tokenizeTranscript(transcript);
      const evaluated=[];
      for (let i=0;i<candidates.length;i++) {
        if(job.cancelRequested) throw Error('__CANCELLED__');
        const candidate=candidates[i];
        const excerpt=words.filter(w=>w.start>=candidate.start&&w.start<candidate.end).map(w=>w.text.trim()).join(' ');
        let criteria=null, gancho='';
        try { const r=await assessCandidate(model,excerpt); criteria=r.criteria; gancho=r.gancho; } catch(err) { /* una escena mala no tumba el lote */ }
        if (criteria) { const summary=summarizeAssessment(criteria); evaluated.push({...candidate,criteria,editorialScore:summary.score,reason:summary.reason,gancho,method:'modelo local'}); }
        else { evaluated.push({...candidate,editorialScore:candidate.score,reason:'por ritmo (la IA no evaluó esta)',gancho:'',method:'ritmo'}); }
        job.percent=Math.round((i+1)/candidates.length*100);
        job.progress=`${i+1}/${candidates.length} escenas evaluadas`;
      }
      evaluated.sort((a,b)=>b.editorialScore-a.editorialScore||b.score-a.score);
      const picks=[];
      for (const item of evaluated) {
        if (picks.every(p=>Math.abs(p.start-item.start)>=90)) picks.push(item);
        if (picks.length===5) break;
      }
      shorts=picks.map((s,i)=>({...s,hook:hooksById.get(s.id)||s.gancho||'',captionCorrections:correctionsById.get(s.id)||[],...settingsById.get(s.id),framingMode:settingsById.get(s.id)?.framingMode||'auto',zoomEnabled:settingsById.get(s.id)?.zoomEnabled!==false,captionStyle:settingsById.get(s.id)?.captionStyle||'verde',rank:i+1}));
      writeJson(files.shorts,shorts);
      job={status:'done',message:`${shorts.length} propuestas evaluadas con ${model}. Revisa cada escena antes de publicarla.`,progress:'',percent:100};
    } catch(e) {
      if(job.cancelRequested){job={status:'cancelled',message:'Proceso cancelado por el usuario.',progress:'',percent:0};return;}
      shorts=candidates.slice(0,5).map((s,i)=>({...s,hook:hooksById.get(s.id)||'',captionCorrections:correctionsById.get(s.id)||[],...settingsById.get(s.id),framingMode:settingsById.get(s.id)?.framingMode||'auto',zoomEnabled:settingsById.get(s.id)?.zoomEnabled!==false,captionStyle:settingsById.get(s.id)?.captionStyle||'verde',rank:i+1,method:'ritmo'}));
      writeJson(files.shorts,shorts);
      job={status:'done',message:`${shorts.length} propuestas por ritmo. Modelo local no disponible: ${e.message}`,progress:'',percent:100};
    }
  })();
  return {started:true};
}
async function renderOneShort(clip,bin) {
  const dur=clip.end-clip.start, pad=0.15;
  const groserias=findMatches(transcript,dictionary).filter(m=>m.end>clip.start&&m.start<clip.end);
  const censorRanges=groserias.map(m=>({start:m.start,end:m.end}));
  const assFile=path.join(DATA,`captions_${clip.id}.ass`);
  await fsp.writeFile(assFile,makeAss(transcript,{...clip,censorRanges,brandHandle:config.brandHandle ?? channelStyle.brandHandle,brandMark:config.brandMark ?? channelStyle.brandMark}),'utf8');
  const output=path.join(EXPORTS,`short_${clip.rank}_${Date.now()}.mp4`);
  const temporary=path.join(DATA,`short_${crypto.randomUUID()}.mp4`);
  const [OW,OH]=FORMATS[clip.format]||FORMATS.vertical;
  const {width,height}=videoDimensions(project.videoPath);
  const captions=`ass=data/captions_${clip.id}.ass`;
  const zoom=clip.zoomEnabled===false?'1':zoomExpression(tokenizeTranscript(transcript),clip.start,clip.end);
  let filter;
  if(clip.format && clip.format!=='vertical') {
    // Cuadrado (1:1) u horizontal (16:9): escalar para cubrir + recorte centrado (sin reencuadre de cara).
    job.message=`Creando Short ${clip.rank} (${clip.format})…`;
    filter=`[0:v]fps=30,setpts=PTS-STARTPTS,scale=${OW}:${OH}:force_original_aspect_ratio=increase,crop=${OW}:${OH},zoompan=z='${zoom}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${OW}x${OH}:fps=30,${captions}[v]`;
  } else {
    let framing=null;
    if(clip.framingMode!=='blur') {
      job.message=`Analizando encuadre del Short ${clip.rank}…`;
      framing=await framingForClip(clip,bin,width,height);
    }
    if(framing) {
      const pan=`zoompan=z='${zoom}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${OW}x${OH}:fps=30`;
      if(framing.portrait) filter=`[0:v]fps=30,setpts=PTS-STARTPTS,scale=${OW}:${OH}:force_original_aspect_ratio=increase,crop=${OW}:${OH},${pan},${captions}[v]`;
      else filter=`[0:v]fps=30,setpts=PTS-STARTPTS,crop=w=${framing.cropWidth}:h=ih:x='${cropExpression(framing.track)}':y=0,${pan},${captions}[v]`;
    } else {
      job.message=`Usando fondo desenfocado en Short ${clip.rank}…`;
      const frontHeight=Math.max(2,Math.round((OW*height/width)/2)*2);
      filter=`[0:v]fps=30,setpts=PTS-STARTPTS,split=2[bg][fg];[bg]scale=${OW}:${OH}:force_original_aspect_ratio=increase,crop=${OW}:${OH},boxblur=15:2[back];[fg]scale=${OW}:-2,zoompan=z='${zoom}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${OW}x${frontHeight}:fps=30[front];[back][front]overlay=(W-w)/2:(H-h)/2,${captions}[v]`;
    }
  }
  job.message=`Creando Short ${clip.rank}…`; job.percent=0;
  // Silenciar groserías que caigan dentro de este Short (audio por filter_complex, sin tocar imagen)
  let fullFilter=filter, audioMap=['-map','0:a:0'];
  if(groserias.length) {
    const enable=groserias.map(m=>`between(t,${Math.max(0,m.start-clip.start-pad).toFixed(3)},${Math.min(dur,m.end-clip.start+pad).toFixed(3)})`).join('+');
    fullFilter=`${filter};[0:a]volume=enable='${enable}':volume=0[a]`;
    audioMap=['-map','[a]'];
  }
  try {
    await run(bin,['-y','-ss',String(clip.start),'-t',String(dur),'-i',project.videoPath,'-filter_complex',fullFilter,'-map','[v]',...audioMap,'-r','30','-c:v','libx264','-pix_fmt','yuv420p','-preset','fast','-crf','20','-c:a','aac','-b:a','160k','-movflags','+faststart',temporary],progress(dur,`Short ${clip.rank}`));
    await fsp.rename(temporary,output);
  } catch(e) {await fsp.unlink(temporary).catch(()=>{});throw e;}
  return output;
}
async function renderShort(id) {
  if (job.status==='running') throw Error('Espera a que termine el proceso actual.');
  if (!project?.videoPath) throw Error('Abre un video primero.');
  const clip=shorts.find(s=>s.id===id);
  if (!clip) throw Error('No encuentro esa propuesta de Short.');
  const bin=readiness().ffmpeg;
  if (!bin) throw Error('Configura FFmpeg antes de crear el Short.');
  job={status:'running',message:`Creando Short ${clip.rank} con subtítulos…`,progress:'',percent:0,cancelRequested:false};
  (async()=>{
    try {
      const output=await renderOneShort(clip,bin);
      job={status:'done',message:`Short listo: ${output}`,progress:'',percent:100,output};
    }catch(e){job={status: job.cancelRequested?'cancelled':'error',message:e.message,progress:'',percent:0};}
  })();
  return {started:true};
}
async function renderAllShorts() {
  if (job.status==='running') throw Error('Espera a que termine el proceso actual.');
  if (!project?.videoPath || !shorts.length) throw Error('Primero genera propuestas de Shorts.');
  const bin=readiness().ffmpeg;
  if (!bin) throw Error('Configura FFmpeg antes de crear los Shorts.');
  job={status:'running',message:'Creando 5 Shorts…',progress:'',percent:0,cancelRequested:false};
  (async()=>{
    const outputs=[];
    try {
      for(const clip of shorts) {
        if(job.cancelRequested) throw Error('Proceso cancelado por el usuario.');
        job.message=`Creando Short ${clip.rank} de ${shorts.length}…`;
        outputs.push(await renderOneShort(clip,bin));
      }
      job={status:'done',message:`Listos ${outputs.length} Shorts en exports.`,progress:'',percent:100,outputs};
    }catch(e){job={status: job.cancelRequested?'cancelled':'error',message:`Se crearon ${outputs.length} Shorts. ${e.message}`,progress:'',percent:0,outputs};}
  })();
  return {started:true};
}
function sendVideo(req,res) {
  if (!project?.videoPath || !fs.existsSync(project.videoPath)) return error(res,'No hay video abierto.',404);
  const videoPath=project.previewPath && fs.existsSync(project.previewPath) ? project.previewPath : project.videoPath;
  return serveMedia(req,res,videoPath);
}
function serveMedia(req,res,videoPath) {
  const stat = fs.statSync(videoPath), size=stat.size, range=req.headers.range;
  const ext=path.extname(videoPath).toLowerCase();
  const type=ext==='.png'?'image/png':(ext==='.jpg'||ext==='.jpeg')?'image/jpeg':ext==='.webm'?'video/webm':ext==='.mov'?'video/quicktime':'video/mp4';
  if (range) {
    const m=range.match(/bytes=(\d+)-(\d*)/); if (!m) return error(res,'Rango inválido',416);
    const start=Number(m[1]), end=m[2]?Math.min(Number(m[2]),size-1):Math.min(start+4*1024*1024,size-1);
    if (start>=size || end<start) return error(res,'Rango inválido',416);
    res.writeHead(206,{'content-type':type,'accept-ranges':'bytes','content-range':`bytes ${start}-${end}/${size}`,'content-length':end-start+1});
    fs.createReadStream(videoPath,{start,end}).pipe(res);
  } else { res.writeHead(200,{'content-type':type,'accept-ranges':'bytes','content-length':size}); fs.createReadStream(videoPath).pipe(res); }
}
async function reviewClip(at, requestedLength) {
  const bin=readiness().ffmpeg;
  if (!project?.videoPath) throw Error('Abre un video primero.');
  if (!bin) throw Error('Configura FFmpeg para revisar los cortes.');
  const seconds=Number(at);
  if (!Number.isFinite(seconds) || seconds<0) throw Error('Tiempo inválido.');
  const duration=await durationOf(project.videoPath);
  if (seconds>duration) throw Error('El tiempo está fuera del video.');
  const full=Number(requestedLength);
  if (requestedLength!==undefined && (!Number.isFinite(full)||full<3||full>90)) throw Error('El clip de revisión debe durar entre 3 y 90 segundos.');
  const start=requestedLength===undefined?Math.max(0,seconds-2):seconds;
  const length=Math.min(requestedLength===undefined?8:full,duration-start);
  const key=`review_${Math.round(seconds*100)}_${Math.round(length*100)}.mp4`;
  const output=path.join(DATA,key);
  if (!fs.existsSync(output)) await run(bin,['-y','-ss',String(start),'-t',String(length),'-i',project.videoPath,'-map','0:v:0','-map','0:a:0','-vf','scale=960:-2','-c:v','libx264','-preset','ultrafast','-crf','30','-c:a','aac','-b:a','96k','-movflags','+faststart',output]);
  return { url:'/api/review-video?key='+encodeURIComponent(key), seek:seconds-start };
}
async function reviewCut(id) {
  const bin=readiness().ffmpeg;
  if(!bin||!project?.videoPath) throw Error('Abre un video y configura FFmpeg.');
  const match=findMatches(transcript,dictionary).find(m=>m.id===id);
  const manual=manualCuts.find(c=>c.id===id);
  if(!match&&!manual) throw Error('No encuentro ese corte.');
  const duration=await durationOf(project.videoPath);
  const cut=match?adjustedCuts([match],[id],duration,tokenizeTranscript(transcript),adjustments)[0]:{start:manual.start,end:manual.end};
  if(!cut) throw Error('Tiempo de corte inválido.');
  const from=Math.max(0,cut.start-3),to=Math.min(duration,cut.end+3);
  const hash=crypto.createHash('sha1').update(`${project.videoPath}|${id}|${cut.start}|${cut.end}`).digest('hex').slice(0,16);
  const key=`review_cut_${hash}.mp4`,output=path.join(DATA,key);
  if(!fs.existsSync(output)) {
    const keep=[{start:0,end:cut.start-from},{start:cut.end-from,end:to-from}].filter(s=>s.end-s.start>.1);
    const filters=[];
    keep.forEach((s,i)=>{const len=s.end-s.start,fade=Math.min(.012,len/3);filters.push(`[0:v]trim=start=${s.start.toFixed(3)}:end=${s.end.toFixed(3)},setpts=PTS-STARTPTS[v${i}]`);filters.push(`[0:a]atrim=start=${s.start.toFixed(3)}:end=${s.end.toFixed(3)},asetpts=PTS-STARTPTS,afade=t=in:st=0:d=${fade.toFixed(3)},afade=t=out:st=${(len-fade).toFixed(3)}:d=${fade.toFixed(3)}[a${i}]`);});
    filters.push(keep.map((_,i)=>`[v${i}][a${i}]`).join('')+`concat=n=${keep.length}:v=1:a=1[joined][a]`);
    filters.push('[joined]scale=960:-2[v]');
    const script=path.join(DATA,`filter_${hash}.txt`);await fsp.writeFile(script,filters.join(';\n'),'utf8');
    await run(bin,['-y','-ss',String(from),'-t',String(to-from),'-i',project.videoPath,'-/filter_complex',script,'-map','[v]','-map','[a]','-c:v','libx264','-preset','ultrafast','-crf','30','-c:a','aac','-b:a','96k','-movflags','+faststart',output]);
  }
  return {url:'/api/review-video?key='+encodeURIComponent(key),cut};
}
// Formatos que el navegador NO reproduce → necesitan una vista previa MP4 para verse en la app.
function needsPreview(p=project?.videoPath){ return ['.mpg','.mpeg','.mkv','.avi'].includes(path.extname(p||'').toLowerCase()); }
function videoCodec(p){ const bin=readiness().ffprobe; if(!bin) return ''; const o=spawnSync(bin,['-v','error','-select_streams','v:0','-show_entries','stream=codec_name','-of','default=nk=1:nw=1',p],{encoding:'utf8',windowsHide:true}); return String(o.stdout||'').trim().split(/\r?\n/)[0]||''; }
// Genera la vista previa reproducible en el navegador (solo para VER; el export SIEMPRE usa el original).
async function buildPreviewFile(bin){
  const input=project.videoPath;
  const total=await durationOf(input).catch(()=>0);
  // Limpia vistas previas anteriores para no acumular archivos grandes.
  try{ for(const f of fs.readdirSync(DATA)){ if(/^preview_\d+\.mp4$/.test(f)) await fsp.unlink(path.join(DATA,f)).catch(()=>{}); } }catch{}
  const output=path.join(DATA,'preview_'+Date.now()+'.mp4');
  const scaled=['-y','-i',input,'-map','0:v:0','-map','0:a:0?','-vf','scale=960:-2','-c:v','libx264','-preset','ultrafast','-crf','32','-c:a','aac','-b:a','96k','-movflags','+faststart',output];
  if(videoCodec(input)==='h264'){
    // El video ya es H.264 (solo el contenedor .mpg/.mkv no se reproduce) → REMUX a mp4: casi instantáneo y calidad intacta.
    try{ await run(bin,['-y','-i',input,'-map','0:v:0','-map','0:a:0?','-c:v','copy','-c:a','aac','-b:a','160k','-movflags','+faststart',output],progress(total,'Vista previa')); }
    catch(e){ await run(bin,scaled,progress(total,'Vista previa')); }
  } else { await run(bin,scaled,progress(total,'Vista previa')); }
  if (project?.videoPath===input) { project.previewPath=output; writeJson(files.project,project); }
}
// Genera miniaturas (filmstrip) + onda de audio para la línea de tiempo, leyendo el ORIGINAL.
async function buildFilmstripFiles(bin){
  const dur=await durationOf(project.videoPath);
  const n=Math.max(24,Math.min(120,Math.round(dur/15)));
  const interval=dur/n;
  const stripDir=path.join(DATA,'strip');
  await fsp.rm(stripDir,{recursive:true,force:true}).catch(()=>{}); await fsp.mkdir(stripDir,{recursive:true});
  for(let i=0;i<n;i++){
    if(job.cancelRequested) throw Error('Proceso cancelado por el usuario.');
    const t=((i+0.5)*interval).toFixed(2);
    await run(bin,['-y','-ss',String(t),'-i',project.videoPath,'-frames:v','1','-vf','scale=160:-2','-q:v','6',path.join(stripDir,`t${String(i+1).padStart(4,'0')}.jpg`)]);
    job.percent=Math.round((i+1)/n*88);
  }
  job.message='Generando onda de audio…';
  await run(bin,['-y','-i',project.videoPath,'-filter_complex','showwavespic=s=1800x58:colors=0x18FC53','-frames:v','1',path.join(DATA,'wave.png')]).catch(()=>{});
  filmstrip={count:n, interval:+interval.toFixed(3), wave:fs.existsSync(path.join(DATA,'wave.png'))};
}
// Deja el proyecto LISTO al abrirlo (como CapCut): vista previa si hace falta + miniaturas + onda, en un solo paso.
function prepareProject(){
  const bin=readiness().ffmpeg;
  if(!bin||!project?.videoPath) return;
  if(job.status==='running') return;
  const input=project.videoPath;
  job={status:'running',message:'Preparando el video…',progress:'',percent:0,cancelRequested:false};
  (async()=>{
    try{
      if(needsPreview(input) && !(project.previewPath&&fs.existsSync(project.previewPath))){
        job.message='Preparando vista previa para reproducir…';
        await buildPreviewFile(bin);
        if(project?.videoPath!==input){ job={status:'done',message:'',percent:100}; return; }
      }
      job.message='Generando línea de tiempo (miniaturas y onda)…'; job.percent=0;
      await buildFilmstripFiles(bin);
      job={status:'done',message:'Video listo. ✅',progress:'',percent:100};
    }catch(e){ job={status: job.cancelRequested?'cancelled':'error', message:e.message, progress:'', percent:0}; }
  })();
}
// Compatibilidad: la vista previa manual usa el mismo generador.
async function preview() {
  const bin=readiness().ffmpeg;
  if (!project?.videoPath) throw Error('Abre un video primero.');
  if (!bin) throw Error('Configura FFmpeg para crear la vista previa.');
  if (job.status==='running') throw Error('Ya hay un proceso en curso.');
  const input=project.videoPath, total=await durationOf(input).catch(()=>0);
  job={status:'running',message:'Creando vista previa ligera…',progress:'',percent:0,cancelRequested:false};
  (async()=>{
    try { await buildPreviewFile(bin); job={status:'done',message:'Vista previa lista.',progress:'',percent:100}; }
    catch(e) {job={status: job.cancelRequested?'cancelled':'error',message:e.message,progress:'',percent:0};}
  })();
}
// ===== Detección IA de contenido sensible (gemma3:4b visión, local vía Ollama) =====
const OLLAMA = 'http://127.0.0.1:11434';
const SCAN_MODEL = 'gemma3:4b';
const SCAN_CATS = ['beso','desnudez','pelea','drogas']; // categorías que el modelo evalúa
async function ollamaHasVision(){
  try{ const r=await fetch(OLLAMA+'/api/tags',{signal:AbortSignal.timeout(4000)}); if(!r.ok) return false; const j=await r.json(); return (j.models||[]).some(m=>String(m.name||'').startsWith('gemma3')); }catch{ return false; }
}
function scanPrompt(){
  return 'Eres moderador de YouTube. Mira SOLO este fotograma de un video. '+
    'Marca ÚNICAMENTE lo que YouTube penaliza de verdad: desnudez explícita o genitales, acto sexual, beso apasionado o intimidad fuerte, pelea real con golpes o sangre, consumo visible de drogas. '+
    'NO marques lo normal: fiesta o antro, baile, una copa o cerveza social, ropa escotada o de fiesta, abrazos, gente conversando o posando. '+
    'Responde SOLO en JSON, sin texto extra: {"beso":true/false,"desnudez":true/false,"pelea":true/false,"drogas":true/false,"riesgo":"ninguno|bajo|medio|alto","nota":"máximo 8 palabras"}.';
}
async function classifyFrame(fp){
  let b64; try{ b64=await fsp.readFile(fp,{encoding:'base64'}); }catch{ return null; }
  try{
    const r=await fetch(OLLAMA+'/api/generate',{method:'POST',signal:AbortSignal.timeout(60000),headers:{'content-type':'application/json'},
      body:JSON.stringify({model:SCAN_MODEL,prompt:scanPrompt(),images:[b64],stream:false,options:{temperature:0}})});
    if(!r.ok) throw Error('Ollama '+r.status);
    const j=await r.json(); const txt=String(j.response||'');
    const m=txt.match(/\{[\s\S]*\}/); if(!m) return {beso:false,desnudez:false,pelea:false,drogas:false,riesgo:'ninguno',nota:''};
    const o=JSON.parse(m[0]);
    return {beso:!!o.beso,desnudez:!!o.desnudez,pelea:!!o.pelea,drogas:!!o.drogas,riesgo:String(o.riesgo||'ninguno'),nota:String(o.nota||'').slice(0,80)};
  }catch(e){ return null; } // un frame que falla no tumba el escaneo
}
const RISK_ORDER={ninguno:0,bajo:1,medio:2,alto:3};
function scanSensitive(opts){
  const bin=readiness().ffmpeg;
  if(!bin||!project?.videoPath) throw Error('Abre un video primero.');
  if(job.status==='running') throw Error('Espera a que termine el proceso actual.');
  const cats=(Array.isArray(opts.cats)&&opts.cats.length)?opts.cats.filter(c=>SCAN_CATS.includes(c)):SCAN_CATS.slice();
  const sens=['relajado','normal','estricto'].includes(opts.sensitivity)?opts.sensitivity:'normal';
  const minRisk=sens==='relajado'?3:sens==='estricto'?1:2; // umbral por sensibilidad
  const step=Math.max(2,Math.min(15,Number(opts.step)||4));
  const maxFrames=Math.max(10,Math.min(600,Number(opts.max)||250));
  job={status:'running',message:'Preparando análisis con IA…',progress:'',percent:0,cancelRequested:false};
  (async()=>{
    try{
      if(!(await ollamaHasVision())) throw Error('No encuentro gemma3 en Ollama. Abre Ollama y ten el modelo gemma3:4b instalado.');
      const dur=await durationOf(project.videoPath);
      const dir=path.join(DATA,'scan'); await fsp.rm(dir,{recursive:true,force:true}).catch(()=>{}); await fsp.mkdir(dir,{recursive:true});
      let times=[]; for(let t=1;t<dur-0.5;t+=step) times.push(+t.toFixed(2));
      if(times.length>maxFrames){ const k=Math.ceil(times.length/maxFrames); times=times.filter((_,i)=>i%k===0); }
      const frames=[];
      for(let i=0;i<times.length;i++){
        if(job.cancelRequested) throw Error('Análisis cancelado.');
        const t=times[i], fp=path.join(dir,`f${i}.jpg`);
        await run(bin,['-y','-ss',String(t),'-i',project.videoPath,'-frames:v','1','-vf','scale=512:-2','-q:v','4',fp]).catch(()=>{});
        if(fs.existsSync(fp)) frames.push({t,i,fp});
        job.message=`Sacando fotogramas… (${i+1}/${times.length})`; job.percent=Math.round((i+1)/times.length*35);
      }
      job.message='Revisando con IA (gemma3)…';
      const flagged=[];
      for(let n=0;n<frames.length;n++){
        if(job.cancelRequested) throw Error('Análisis cancelado.');
        const f=frames[n]; const r=await classifyFrame(f.fp);
        if(r){ const hit=cats.some(c=>r[c]) && (RISK_ORDER[r.riesgo]||0)>=minRisk; if(hit){ const which=cats.filter(c=>r[c]); flagged.push({t:f.t,i:f.i,cats:which,riesgo:r.riesgo,nota:r.nota}); } }
        job.message=`Revisando con IA… (${n+1}/${frames.length})`; job.percent=35+Math.round((n+1)/Math.max(1,frames.length)*63);
      }
      // Agrupa fotogramas marcados cercanos en TRAMOS
      const ranges=[]; const gap=step*2.2;
      for(const fl of flagged){
        const last=ranges[ranges.length-1];
        if(last && fl.t-last.endRaw<=gap){ last.endRaw=fl.t; last.end=Math.min(dur,fl.t+step); last.hits++; if((RISK_ORDER[fl.riesgo]||0)>(RISK_ORDER[last.riesgo]||0)){last.riesgo=fl.riesgo;last.nota=fl.nota;last.thumb=fl.i;} for(const c of fl.cats) if(!last.cats.includes(c)) last.cats.push(c); }
        else ranges.push({start:Math.max(0,fl.t-1),end:Math.min(dur,fl.t+step),endRaw:fl.t,cats:[...fl.cats],riesgo:fl.riesgo,nota:fl.nota,thumb:fl.i,hits:1});
      }
      ranges.forEach(r=>{delete r.endRaw;r.start=+r.start.toFixed(2);r.end=+r.end.toFixed(2);});
      sensitiveScan={ranges,scannedAt:Date.now(),frames:frames.length,cats,sensitivity:sens};
      writeJson(files.sensitive,sensitiveScan);
      job={status:'done',message:ranges.length?`Revisión lista: ${ranges.length} momento(s) a revisar.`:'Revisión lista: no se marcó nada sospechoso.',progress:'',percent:100};
    }catch(e){ job={status:job.cancelRequested?'cancelled':'error',message:e.message,progress:'',percent:0}; }
  })();
}
const staticFiles = { '/':'index.html', '/index.html':'index.html', '/app.js':'app.js', '/style.css':'style.css' };
const contentTypes = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8' };
const server=http.createServer(async (req,res) => {
  try {
    // Seguridad: solo aceptar peticiones dirigidas a esta PC (evita DNS-rebinding desde webs maliciosas).
    const hostHdr=(req.headers.host||'').toLowerCase();
    if (![`127.0.0.1:${PORT}`,`localhost:${PORT}`,`[::1]:${PORT}`].includes(hostHdr)) return error(res,'Host no permitido.',403);
    const url=new URL(req.url,`http://127.0.0.1:${PORT}`);
    if (req.method==='GET' && url.pathname==='/api/state') return respond(res,200,state());
    if (req.method==='GET' && url.pathname==='/api/video') return sendVideo(req,res);
    if (req.method==='GET' && url.pathname==='/api/export-file') {
      const name=String(url.searchParams.get('name')||'');
      if (!/^[\p{L}\p{N}._-]+\.(mp4|png|jpe?g)$/u.test(name)) return error(res,'Archivo inválido.',400);
      const file=path.join(EXPORTS,name);
      if (!fs.existsSync(file)) return error(res,'Archivo no encontrado.',404);
      return serveMedia(req,res,file);
    }
    if (req.method==='GET' && url.pathname==='/api/review-video') {
      const key=String(url.searchParams.get('key')||'');
      if (!/^review_(?:\d+(?:_\d+)?|cut_[a-f0-9]{16})\.mp4$/.test(key)) return error(res,'Fragmento inválido.',400);
      const file=path.join(DATA,key);
      if (!fs.existsSync(file)) return error(res,'Fragmento no encontrado.',404);
      return serveMedia(req,res,file);
    }
    if (req.method==='POST' && url.pathname==='/api/config') {
      const body=await jsonBody(req); config={ffmpeg:String(body.ffmpeg||''),ffprobe:String(body.ffprobe||''),whisper:String(body.whisper||''),model:String(body.model||''),brandHandle:String(body.brandHandle||'').slice(0,60),brandMark:String(body.brandMark||'').slice(0,8)}; writeJson(files.config,config); return respond(res,200,state());
    }
    if (req.method==='POST' && url.pathname==='/api/dictionary') {
      const body=await jsonBody(req);
      if (!Array.isArray(body.entries) || body.entries.length>500) throw Error('Diccionario inválido o demasiado grande.');
      dictionary=body.entries.map(e => ({term:String(e.term||'').trim().slice(0,100),enabled:Boolean(e.enabled),note:String(e.note||'').slice(0,150)})).filter(e=>e.term);
      writeJson(files.dictionary,dictionary);selection=null;writeJson(files.selection,selection);return respond(res,200,state());
    }
    if (req.method==='POST' && url.pathname==='/api/project/clear') {
      if (job.status==='running') throw Error('Espera a que termine el proceso actual.');
      project=null; transcript=[]; shorts=[]; adjustments={}; pauses=[]; manualCuts=[]; selection=null; filmstrip=null;
      writeJson(files.project,project); writeJson(files.transcript,transcript); writeJson(files.shorts,shorts); writeJson(files.adjustments,adjustments); writeJson(files.pauses,pauses); writeJson(files.manualCuts,manualCuts); writeJson(files.selection,selection);
      return respond(res,200,state());
    }
    if (req.method==='POST' && url.pathname==='/api/project/open') {
      if (job.status==='running') throw Error('Espera a que termine el proceso actual antes de cambiar de video.');
      const body=await jsonBody(req), videoPath=path.resolve(String(body.path||''));
      if (!fs.existsSync(videoPath) || !fs.statSync(videoPath).isFile()) throw Error('No encuentro ese archivo de video.');
      if (!['.mp4','.mov','.mkv','.webm','.avi','.m4v','.mpg','.mpeg'].includes(path.extname(videoPath).toLowerCase())) throw Error('Formato de video no admitido.');
      project={videoPath,openedAt:new Date().toISOString()}; transcript=[]; shorts=[]; adjustments={};pauses=[];manualCuts=[];selection=null;filmstrip=null;writeJson(files.project,project); writeJson(files.transcript,transcript); writeJson(files.shorts,shorts);writeJson(files.adjustments,adjustments);writeJson(files.pauses,pauses);writeJson(files.manualCuts,manualCuts);writeJson(files.selection,selection);
      prepareProject(); // genera vista previa (si hace falta) + miniaturas + onda automáticamente
      return respond(res,200,state());
    }
    if (req.method==='POST' && url.pathname==='/api/project/upload') {
      if (job.status==='running') throw Error('Espera a que termine el proceso actual antes de cambiar de video.');
      const original=String(url.searchParams.get('name')||'video.mp4'); const safe=path.basename(original).replace(/[^\p{L}\p{N}._-]+/gu,'_');
      if (!['.mp4','.mov','.mkv','.webm','.avi','.m4v','.mpg','.mpeg'].includes(path.extname(safe).toLowerCase())) throw Error('Formato de video no admitido.');
      const target=path.join(DATA,`${Date.now()}_${safe}`), stream=fs.createWriteStream(target);
      await new Promise((resolve,reject)=>{req.pipe(stream);req.on('error',reject);stream.on('error',reject);stream.on('finish',resolve);});
      project={videoPath:target,openedAt:new Date().toISOString()}; transcript=[]; shorts=[]; adjustments={};pauses=[];manualCuts=[];selection=null;filmstrip=null;writeJson(files.project,project); writeJson(files.transcript,transcript); writeJson(files.shorts,shorts);writeJson(files.adjustments,adjustments);writeJson(files.pauses,pauses);writeJson(files.manualCuts,manualCuts);writeJson(files.selection,selection);
      prepareProject(); // genera vista previa (si hace falta) + miniaturas + onda automáticamente
      return respond(res,200,state());
    }
    if (req.method==='POST' && url.pathname==='/api/transcript/import') {
      const body=await jsonBody(req), file=path.resolve(String(body.path||''));
      if (!fs.existsSync(file)) throw Error('No encuentro ese archivo de transcripción.');
      await importTranscript(file); return respond(res,200,state());
    }
    if (req.method==='POST' && url.pathname==='/api/transcript/upload') {
      const name=String(url.searchParams.get('name')||'transcript.srt');
      if (!['.srt','.vtt','.json'].includes(path.extname(name).toLowerCase())) throw Error('Usa SRT, VTT o JSON.');
      const target=path.join(DATA,`import_${Date.now()}${path.extname(name).toLowerCase()}`), stream=fs.createWriteStream(target);
      await new Promise((resolve,reject)=>{req.pipe(stream);req.on('error',reject);stream.on('error',reject);stream.on('finish',resolve);});
      await importTranscript(target); return respond(res,200,state());
    }
    if (req.method==='POST' && url.pathname==='/api/pick-video') {
      const picked=await nativeDialog('open');
      if(!picked) return respond(res,200,{cancelled:true});
      return respond(res,200,{path:picked});
    }
    if (req.method==='POST' && url.pathname==='/api/save-as') {
      const body=await jsonBody(req), name=path.basename(String(body.name||''));
      if(!/^[\p{L}\p{N}._ -]+\.(mp4|png|jpe?g)$/u.test(name)) throw Error('Nombre de archivo inválido.');
      const src=path.join(EXPORTS,name);
      if(!fs.existsSync(src)) throw Error('No encuentro ese archivo en exports.');
      const dest=await nativeDialog('save', name);
      if(!dest) return respond(res,200,{cancelled:true});
      await fsp.copyFile(src, dest);
      return respond(res,200,{saved:true, path:dest, name:path.basename(dest)});
    }
    if (req.method==='POST' && url.pathname==='/api/frame') {
      const bin=readiness().ffmpeg;
      if(!bin||!project?.videoPath) throw Error('Abre un video primero.');
      if(job.status==='running') throw Error('Espera a que termine el proceso actual.');
      const body=await jsonBody(req), at=Number(body.at);
      const d=await durationOf(project.videoPath);
      if(!Number.isFinite(at)||at<0||at>d) throw Error('Tiempo fuera del video.');
      const name=`miniatura_${Math.round(at*1000)}_${Date.now()}.png`;
      const out=path.join(EXPORTS,name);
      // seek rápido cerca + seek fino = exacto y rápido, a resolución completa
      const fast=Math.max(0,at-2), fine=Math.min(2,at-fast);
      await run(bin,['-y','-ss',String(fast),'-i',project.videoPath,'-ss',String(fine),'-frames:v','1',out]);
      return respond(res,200,{name, at});
    }
    if (req.method==='POST' && url.pathname==='/api/project/prepare') {
      if(!readiness().ffmpeg||!project?.videoPath) throw Error('Abre un video primero.');
      if(job.status==='running') return respond(res,202,{started:false,busy:true});
      prepareProject();
      return respond(res,202,{started:true});
    }
    if (req.method==='POST' && url.pathname==='/api/scan-sensitive') {
      const body=await jsonBody(req); scanSensitive(body||{}); return respond(res,202,{started:true});
    }
    if (req.method==='POST' && url.pathname==='/api/scan-sensitive/clear') {
      sensitiveScan=null; try{fs.unlinkSync(files.sensitive);}catch{} return respond(res,200,state());
    }
    if (req.method==='GET' && url.pathname==='/api/scan-thumb') {
      const i=parseInt(url.searchParams.get('i')||'-1',10);
      const fp=path.join(DATA,'scan',`f${i}.jpg`);
      if(!Number.isInteger(i)||i<0||!fs.existsSync(fp)) return error(res,'Miniatura no encontrada.',404);
      return serveMedia(req,res,fp);
    }
    if (req.method==='POST' && url.pathname==='/api/filmstrip') {
      const bin=readiness().ffmpeg;
      if(!bin||!project?.videoPath) throw Error('Abre un video primero.');
      if(job.status==='running') throw Error('Espera a que termine el proceso actual.');
      job={status:'running',message:'Generando miniaturas de la línea de tiempo…',progress:'',percent:0,cancelRequested:false};
      (async()=>{
        try{
          await buildFilmstripFiles(bin);
          job={status:'done',message:`Miniaturas listas (${filmstrip?filmstrip.count:0}).`,progress:'',percent:100};
        }catch(e){ job={status: job.cancelRequested?'cancelled':'error', message:e.message, progress:'', percent:0}; }
      })();
      return respond(res,202,{started:true});
    }
    if (req.method==='GET' && url.pathname==='/api/strip') {
      const i=parseInt(url.searchParams.get('i')||'0',10);
      if(!Number.isInteger(i)||i<1||i>99999) return error(res,'Índice inválido.',400);
      const f=path.join(DATA,'strip',`t${String(i).padStart(4,'0')}.jpg`);
      if(!fs.existsSync(f)) return error(res,'No encontrado.',404);
      return serveMedia(req,res,f);
    }
    if (req.method==='GET' && url.pathname==='/api/wave') {
      const f=path.join(DATA,'wave.png'); if(!fs.existsSync(f)) return error(res,'No encontrado.',404);
      return serveMedia(req,res,f);
    }
    if (req.method==='POST' && url.pathname==='/api/transcribe') { await transcribe(); return respond(res,202,state()); }
    if (req.method==='POST' && url.pathname==='/api/download-df') {
      if (dfReady()) return respond(res,200,{ready:true});
      const dfUrl='https://github.com/Rikorose/DeepFilterNet/releases/download/v0.5.6/deep-filter-0.5.6-x86_64-pc-windows-msvc.exe';
      const r=await fetch(dfUrl,{signal:AbortSignal.timeout(240000)});
      if(!r.ok) throw Error('No se pudo descargar ('+r.status+')');
      await fsp.writeFile(DF_BIN, Buffer.from(await r.arrayBuffer()));
      return respond(res,200,{ready:dfReady()});
    }
    if (req.method==='POST' && url.pathname==='/api/update/check') return respond(res,200,await checkUpdate());
    if (req.method==='POST' && url.pathname==='/api/update/apply') return respond(res,200,await applyUpdate());
    if (req.method==='POST' && url.pathname==='/api/job/cancel') {
      if (job.status!=='running') return respond(res,200,{cancelled:false,message:'No hay ningún proceso en curso.'});
      job.cancelRequested=true; job.message='Cancelando…';
      if (activeProc) { try { activeProc.kill(); } catch {} }
      return respond(res,200,{cancelled:true});
    }
    if (req.method==='POST' && url.pathname==='/api/pauses/analyze') return respond(res,202,await analyzePauses());
    if (req.method==='POST' && url.pathname==='/api/preview') { await preview(); return respond(res,202,state()); }
    if (req.method==='POST' && url.pathname==='/api/review-clip') { const body=await jsonBody(req); return respond(res,200,await reviewClip(body.at,body.length)); }
    if (req.method==='POST' && url.pathname==='/api/cuts/adjust') {
      if(job.status==='running') throw Error('Espera a que termine el proceso actual.');
      const body=await jsonBody(req),id=String(body.id||''),match=findMatches(transcript,dictionary).find(m=>m.id===id);
      if(!match) throw Error('No encuentro esa coincidencia.');
      if(body.reset===true) delete adjustments[id];
      else {const start=Number(body.start),end=Number(body.end);if(!Number.isFinite(start)||!Number.isFinite(end)||start<0||end<=start||start<match.start-1||end>match.end+1) throw Error('Ajusta el corte dentro de un segundo alrededor de la palabra.');adjustments[id]={start:+start.toFixed(3),end:+end.toFixed(3)};}
      writeJson(files.adjustments,adjustments);return respond(res,200,state());
    }
    if (req.method==='POST' && url.pathname==='/api/cuts/preview') {const body=await jsonBody(req);return respond(res,200,await reviewCut(String(body.id||'')));}
    if (req.method==='POST' && url.pathname==='/api/cuts/manual') {
      if (job.status==='running') throw Error('Espera a que termine el proceso actual.');
      if (!project?.videoPath) throw Error('Abre un video primero.');
      const body=await jsonBody(req),start=Number(body.start),end=Number(body.end),duration=await durationOf(project.videoPath);
      if (!Number.isFinite(start)||!Number.isFinite(end)||start<0||end>duration+0.5||end-start<.04||end-start>1800) throw Error('El corte debe durar entre 0.04 segundos y 30 minutos y estar dentro del video.');
      if (manualCuts.length>=500) throw Error('Límite de 500 cortes manuales.');
      const cut={id:'manual_'+crypto.randomUUID(),start:+start.toFixed(3),end:+end.toFixed(3),label:String(body.label||'Corte manual').trim().slice(0,80)||'Corte manual'};
      manualCuts.push(cut);writeJson(files.manualCuts,manualCuts);return respond(res,200,state());
    }
    if (req.method==='POST' && url.pathname==='/api/cuts/manual/delete') {
      if (job.status==='running') throw Error('Espera a que termine el proceso actual.');
      const body=await jsonBody(req),id=String(body.id||'');
      if (!manualCuts.some(c=>c.id===id)) throw Error('No encuentro ese corte manual.');
      manualCuts=manualCuts.filter(c=>c.id!==id);writeJson(files.manualCuts,manualCuts);return respond(res,200,state());
    }
    // Reemplaza TODOS los cortes manuales de un jalón (lo usa el editor de clips tipo CapCut al borrar/restaurar con ripple).
    if (req.method==='POST' && url.pathname==='/api/cuts/manual/set') {
      if (job.status==='running') throw Error('Espera a que termine el proceso actual.');
      if (!project?.videoPath) throw Error('Abre un video primero.');
      const body=await jsonBody(req), arr=Array.isArray(body.cuts)?body.cuts:[];
      if (arr.length>2000) throw Error('Demasiados cortes.');
      const dur=await durationOf(project.videoPath);
      const clean=[];
      for(const c of arr){ const s=Number(c.start),e=Number(c.end); if(Number.isFinite(s)&&Number.isFinite(e)&&e-s>=0.04&&s>=0&&e<=dur+0.5) clean.push({id:'manual_'+crypto.randomUUID(),start:+s.toFixed(3),end:+Math.min(e,dur).toFixed(3),label:String(c.label||'Clip borrado').slice(0,80)}); }
      manualCuts=clean; writeJson(files.manualCuts,manualCuts); return respond(res,200,state());
    }
    if (req.method==='POST' && url.pathname==='/api/cuts/selection') {
      const body=await jsonBody(req);
      if (!Array.isArray(body.selectedIds)||!Array.isArray(body.selectedPauseIds)||body.selectedIds.length>5000||body.selectedPauseIds.length>500) throw Error('Selección inválida.');
      const matchIds=new Set(findMatches(transcript,dictionary).map(m=>m.id)),pauseIds=new Set(pauses.map(p=>p.id));
      selection={selectedIds:[...new Set(body.selectedIds)].filter(id=>matchIds.has(id)),selectedPauseIds:[...new Set(body.selectedPauseIds)].filter(id=>pauseIds.has(id))};
      writeJson(files.selection,selection);return respond(res,200,{saved:true});
    }
    if (req.method==='POST' && url.pathname==='/api/shorts/suggest') return respond(res,202,await proposeShorts());
    if (req.method==='POST' && url.pathname==='/api/shorts/manual') {
      if (job.status==='running') throw Error('Espera a que termine el proceso actual.');
      if (!project?.videoPath) throw Error('Abre un video primero.');
      if (!transcript.length) throw Error('Transcribe el video primero para que el Short lleve subtítulos.');
      const body=await jsonBody(req);
      const start=Number(body.start), end=Number(body.end);
      const duration=await durationOf(project.videoPath);
      if(!Number.isFinite(start)||!Number.isFinite(end)||start<0||end>duration||end-start<10||end-start>100) throw Error('El momento debe durar entre 10 y 100 segundos y estar dentro del video.');
      if(shorts.length>=30) throw Error('Ya hay muchos Shorts en la lista. Borra algunos antes de agregar más.');
      const words=tokenizeTranscript(transcript);
      const opening=words.filter(w=>w.start>=start&&w.start<Math.min(end,start+10)).slice(0,20).map(w=>w.text.trim()).join(' ').replace(/\s+/g,' ').trim();
      const id='m'+Math.round(start*10)+'_'+Math.round(end*10);
      const clip={id,start:+start.toFixed(2),end:+end.toFixed(2),opening:opening||'(momento elegido por ti)',score:0,editorialScore:0,reason:'Momento elegido por ti',method:'manual',hook:String(body.hook||'').trim().slice(0,40),captionCorrections:[],framingMode:'auto',cropCenter:.5,zoomEnabled:true,captionStyle:'verde',format:'vertical'};
      shorts=[clip,...shorts.filter(s=>s.id!==id)].slice(0,30).map((s,i)=>({...s,rank:i+1}));
      writeJson(files.shorts,shorts);
      return respond(res,200,state());
    }
    if (req.method==='POST' && url.pathname==='/api/shorts/metadata') {
      const body=await jsonBody(req), clip=shorts.find(s=>s.id===String(body.id||''));
      if (!clip) throw Error('No encuentro esa propuesta de Short.');
      if (!transcript.length) throw Error('Transcribe el video primero.');
      const excerpt=tokenizeTranscript(transcript).filter(w=>w.start>=clip.start&&w.start<clip.end).map(w=>w.text.trim()).join(' ');
      const model=process.env.EDITOR_IRL_MODEL||'gemma3:4b';
      const meta=await writePackage(model,excerpt);
      clip.meta=meta; writeJson(files.shorts,shorts);
      return respond(res,200,{meta});
    }
    if (req.method==='POST' && url.pathname==='/api/shorts/hook') {
      if (job.status==='running') throw Error('Espera a que termine el proceso actual.');
      const body=await jsonBody(req), clip=shorts.find(s=>s.id===String(body.id||''));
      if (!clip) throw Error('No encuentro esa propuesta de Short.');
      clip.hook=String(body.hook||'').trim().slice(0,40);
      writeJson(files.shorts,shorts);
      return respond(res,200,{short:clip});
    }
    if (req.method==='POST' && url.pathname==='/api/shorts/settings') {
      if (job.status==='running') throw Error('Espera a que termine el proceso actual.');
      const body=await jsonBody(req),clip=shorts.find(s=>s.id===String(body.id||''));
      if(!clip) throw Error('No encuentro esa propuesta de Short.');
      if(!['auto','manual','blur'].includes(body.framingMode)) throw Error('Encuadre inválido.');
      const center=Number(body.cropCenter);
      if(!Number.isFinite(center)||center<0||center>1) throw Error('Posición de encuadre inválida.');
      clip.framingMode=body.framingMode;clip.cropCenter=center;clip.zoomEnabled=Boolean(body.zoomEnabled);
      if(body.captionStyle && CAPTION_STYLES[body.captionStyle]) clip.captionStyle=body.captionStyle;
      if(body.format && FORMATS[body.format]) clip.format=body.format;
      writeJson(files.shorts,shorts);return respond(res,200,{short:clip});
    }
    if (req.method==='POST' && url.pathname==='/api/shorts/timing') {
      if (job.status==='running') throw Error('Espera a que termine el proceso actual.');
      const body=await jsonBody(req),clip=shorts.find(s=>s.id===String(body.id||''));
      if(!clip) throw Error('No encuentro esa propuesta de Short.');
      const start=Number(body.start),end=Number(body.end),duration=await durationOf(project.videoPath);
      if(!Number.isFinite(start)||!Number.isFinite(end)||start<0||end>duration||end-start<10||end-start>100) throw Error('El Short debe durar entre 10 y 100 segundos dentro del video.');
      clip.start=+start.toFixed(2);clip.end=+end.toFixed(2);
      clip.opening=tokenizeTranscript(transcript).filter(w=>w.start>=start&&w.start<Math.min(end,start+10)).slice(0,20).map(w=>w.text.trim()).join(' ');
      writeJson(files.shorts,shorts);return respond(res,200,{short:clip});
    }
    if (req.method==='POST' && url.pathname==='/api/shorts/captions') {
      if (job.status==='running') throw Error('Espera a que termine el proceso actual.');
      const body=await jsonBody(req), clip=shorts.find(s=>s.id===String(body.id||''));
      if (!clip) throw Error('No encuentro esa propuesta de Short.');
      if (!Array.isArray(body.corrections)||body.corrections.length>20) throw Error('Puedes guardar hasta 20 correcciones por Short.');
      const words=tokenizeTranscript(transcript).filter(w=>w.start>=clip.start&&w.start<clip.end);
      const haystack=` ${words.map(w=>w.norm).join(' ')} `;
      const cleaned=body.corrections.map(c=>({from:String(c.from||'').trim().slice(0,100),to:String(c.to||'').trim().slice(0,100)}));
      for(const correction of cleaned) {
        if (!correction.from||!correction.to) throw Error('Escribe el texto detectado y su corrección.');
        if (!haystack.includes(` ${normalize(correction.from)} `)) throw Error(`No encuentro “${correction.from}” en la transcripción de este Short.`);
      }
      clip.captionCorrections=cleaned;
      writeJson(files.shorts,shorts);
      return respond(res,200,{short:clip});
    }
    if (req.method==='POST' && url.pathname==='/api/shorts/render') { const body=await jsonBody(req); return respond(res,202,await renderShort(String(body.id||''))); }
    if (req.method==='POST' && url.pathname==='/api/shorts/render-all') return respond(res,202,await renderAllShorts());
    if (req.method==='POST' && url.pathname==='/api/export') { const body=await jsonBody(req); const enh=(body.enhance!=null&&typeof body.enhance==='object')?body.enhance:String(body.enhance||'std'); const result=await exportVideo(Array.isArray(body.selectedIds)?body.selectedIds:[],Array.isArray(body.selectedPauseIds)?body.selectedPauseIds:[],body.mode==='cut'?'cut':'mute',String(body.quality||'original'),enh,String(body.intro||'none'),String(body.outro||'none'),String(body.clipIn||'none'),String(body.clipOut||'none'),Number(body.clipDur)||0.8,Array.isArray(body.segments)?body.segments.slice(0,2000):null); return respond(res,202,result); }
    if (req.method==='GET' && staticFiles[url.pathname]) { const p=path.join(ROOT,staticFiles[url.pathname]); const b=await fsp.readFile(p); res.writeHead(200,{'content-type':contentTypes[path.extname(p)],'content-length':b.length,'cache-control':'no-store'}); return res.end(b); }
    return error(res,'No encontrado.',404);
  } catch(e) { return error(res,e); }
});
server.listen(PORT,'127.0.0.1',()=>console.log(`Editor IRL: http://127.0.0.1:${PORT}`));
