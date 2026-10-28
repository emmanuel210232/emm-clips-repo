'use strict';

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');
const { normalize, findMatches, buildCuts, keptIntervals, adjustedCuts, parseSrt, parseWhisperJson, tokenizeTranscript } = require('./lib/core');
const { suggestShorts, makeAss, captionStyles, CAPTION_STYLES, FORMATS, nearestPause } = require('./lib/shorts');
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

// Copia el archivo exportado a la carpeta Descargas del usuario (como si se descargara).
function toDownloads(file){
  try{ const dl=path.join(os.homedir(),'Downloads'); if(!fs.existsSync(dl)) return null;
    let dest=path.join(dl, path.basename(file));
    if(fs.existsSync(dest)){ const p=path.parse(dest); dest=path.join(dl, `${p.name}_${Date.now().toString().slice(-5)}${p.ext}`); }
    fs.copyFileSync(file, dest); return dest;
  }catch{ return null; }
}
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
let silenceScan = null; // resultado transitorio de "quitar silencios"
// Config de la NUBE para el resumen del directo (API de Claude). La KEY se guarda local y NUNCA se expone en /api/state.
let cloud = readJson(path.join(DATA,'cloud.json'), {key:'', engine:'local', model:'claude-opus-5-5'});
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
// Reporte de REQUISITOS para la pantalla de comprobación (handoff): qué hay listo y qué falta en ESTA PC.
async function requirementsReport(){
  const r=readiness();
  const out={
    version:APP_VERSION,
    ffmpeg:!!r.ffmpeg, ffprobe:!!r.ffprobe,
    whisper:!!r.whisper, whisperGpu:!!r.whisperGpu,
    model:!!r.model, modelName:r.model?path.basename(r.model):'',
    deepfilter:dfReady(),
    cloudKey:!!cloud.key,
    ollama:false, gemma3:false, moondream:false, qwen:false
  };
  try{
    const resp=await fetch('http://127.0.0.1:11434/api/tags',{signal:AbortSignal.timeout(2500)});
    if(resp.ok){ out.ollama=true; const j=await resp.json(); const names=(j.models||[]).map(m=>String(m.name||''));
      out.gemma3=names.some(n=>n.startsWith('gemma3'));
      out.moondream=names.some(n=>n.startsWith('moondream'));
      out.qwen=names.some(n=>n.startsWith('qwen2.5:14b'));
    }
  }catch{}
  return out;
}
// CACHÉ de groserías: findMatches sobre transcripciones enormes (directos largos = decenas de miles de segmentos)
// cuesta mucho; recalcularlo en CADA /api/state (cada segundo) colgaba el servidor. Se recalcula solo si cambian transcripción o diccionario.
let _mCache={sig:null,val:[]};
function cachedMatches(){
  const t=transcript||[]; const lastEnd=t.length?t[t.length-1].end:0;
  const dsig=(dictionary||[]).filter(d=>d&&d.enabled).map(d=>d.term).join('|');
  const sig=t.length+':'+lastEnd+':'+dsig;
  if(_mCache.sig!==sig){ _mCache={sig,val:findMatches(t,dictionary)}; }
  return _mCache.val;
}
function state() { return { project, config, dictionary, transcript, shorts, adjustments, pauses, manualCuts, selection, exports:listExports(), matches: cachedMatches(), readiness: readiness(), captionStyles: captionStyles(), qualities: qualityLabels(), brandTemplates: brandTemplates(), clipFx: clipFxLabels(), dfReady: dfReady(), filmstrip, sensitiveScan, silenceScan, bestofScan, cloud:{engine:cloud.engine,model:cloud.model,keySet:!!cloud.key}, version: APP_VERSION, job }; }
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
    // Forzar UTF-8 en la salida: si el nombre/ruta tiene acentos, ñ o emojis, PowerShell los escribiría en la codificación
    // del sistema y Node (que lee UTF-8) los recibiría corruptos → la ruta "no existe". Con esto se devuelve tal cual.
    const owner = `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $OutputEncoding=[System.Text.Encoding]::UTF8; Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; $o=New-Object System.Windows.Forms.Form; $o.StartPosition='CenterScreen'; $o.Size=New-Object System.Drawing.Size(1,1); $o.Opacity=0; $o.ShowInTaskbar=$false; $o.TopMost=$true; $o.Show(); $o.Activate(); [System.Windows.Forms.Application]::DoEvents();`;
    const ps = kind==='save'
      ? `${owner} $f=New-Object System.Windows.Forms.SaveFileDialog; $f.Filter='Video MP4|*.mp4|Todos los archivos|*.*'; $f.FileName='${safeDefault}'; $f.Title='Guardar video como'; $f.OverwritePrompt=$true; $r=$f.ShowDialog($o); $o.Close(); if($r -eq [System.Windows.Forms.DialogResult]::OK){[Console]::Out.Write($f.FileName)}`
      : `${owner} $f=New-Object System.Windows.Forms.OpenFileDialog; $f.Filter='Videos|*.mp4;*.mov;*.mkv;*.webm;*.avi;*.m4v;*.mpg;*.mpeg|Todos los archivos|*.*'; $f.Title='Elige el video del directo'; $r=$f.ShowDialog($o); $o.Close(); if($r -eq [System.Windows.Forms.DialogResult]::OK){[Console]::Out.Write($f.FileName)}`;
    const child=spawn('powershell.exe',['-NoProfile','-STA','-Command',ps],{windowsHide:true});
    const chunks=[]; child.stdout.on('data',b=>chunks.push(b)); child.on('error',()=>resolve('')); child.on('close',()=>resolve(Buffer.concat(chunks).toString('utf8').trim()));
  });
}
// ===== Auto-actualizador (descarga el codigo nuevo desde GitHub) =====
const APP_VERSION = '1.21.1';
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
async function transcribe(opts) {
  const bins = readiness();
  if (!project?.videoPath) throw Error('Abre un video primero.');
  if (!bins.ffmpeg || !bins.whisper || !bins.model) throw Error('Configura FFmpeg, whisper-cli y un modelo multilingüe antes de transcribir.');
  if (job.status === 'running') throw Error('Ya hay un proceso en curso.');
  // VAD (saltar silencios): más rápido sin perder calidad; whisper mapea los tiempos a la línea original.
  const vadModel = path.join(ROOT,'tools','ggml-silero-v5.1.2.bin');
  const useVad = !!(opts&&opts.vad) && fs.existsSync(vadModel);
  const total = await durationOf(project.videoPath).catch(() => 0);
  job = { status:'running', message:'Extrayendo audio…', progress:'', percent:0, cancelRequested:false };
  const wav = path.join(DATA, 'audio.wav');
  const outputBase = path.join(DATA, 'whisper');
  (async () => {
    try {
      await run(bins.ffmpeg, ['-y','-i',project.videoPath,'-vn','-ar','16000','-ac','1','-c:a','pcm_s16le',wav], progress(total,'Audio'));
      job.message='Transcribiendo en español…'; job.progress=''; job.percent=0;
      const prompt = channelStyle.transcriptionPrompt || 'Conversación informal en español de México. Directo, chat, güey, no mames.';
      const wargs=['-m',bins.model,'-f',wav,'-l','es','-ml','1','-sow','-ojf','-of',outputBase,'--prompt',prompt];
      if(useVad){ wargs.push('--vad','--vad-model',vadModel); job.message='Transcribiendo en español (saltando silencios)…'; }
      await run(bins.whisper, wargs, progress(total,'Texto'));
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
// Devuelve el trozo de filtro (xfade contra negro) para el efecto de entrada/salida, aplicable DENTRO del comando principal (1 solo paso).
function clipFxParts(vIn, total, clipIn, clipOut, dur, W, H, fps, startIdx){
  const d=Math.max(0.3,Math.min(3,Number(dur)||0.8));
  const inFx=CLIP_FX[clipIn]||{}, outFx=CLIP_FX[clipOut]||{};
  const hasIn=!!inFx.tr, hasOut=!!outFx.tr && total>d*2;
  const inputs=[], parts=[]; let vlabel=vIn, idx=startIdx;
  if(hasIn){ inputs.push('-f','lavfi','-t',String(d),'-i',`color=c=${inFx.color}:s=${W}x${H}:r=${fps}`); parts.push(`[${idx}:v]settb=AVTB,fps=${fps},format=yuv420p,setsar=1[cfi]`); parts.push(`[cfi]${vlabel}xfade=transition=${inFx.tr}:duration=${d}:offset=0[vfi]`); vlabel='[vfi]'; idx++; }
  if(hasOut){ inputs.push('-f','lavfi','-t',String(d),'-i',`color=c=${outFx.color}:s=${W}x${H}:r=${fps}`); parts.push(`[${idx}:v]settb=AVTB,fps=${fps},format=yuv420p,setsar=1[cfo]`); parts.push(`${vlabel}[cfo]xfade=transition=${outFx.tr}:duration=${d}:offset=${(total-d).toFixed(3)}[vfo]`); vlabel='[vfo]'; idx++; }
  return {inputs, parts, label:vlabel, applied:hasIn||hasOut, nextIdx:idx};
}
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
async function exportVideo(selectedIds,selectedPauseIds=[],mode='mute',quality='original',enhance='std',intro='none',outro='none',clipIn='none',clipOut='none',clipDur=0.8,segments=null,smooth=false,censor=false,gpu=false) {
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
    // Con MUCHAS groserías, una sola expresión `enable='between()+between()+...'` gigante hace que ffmpeg se quede SIN MEMORIA.
    // Se parte en grupos y se encadenan varios filtros volume chicos → funciona con cualquier cantidad.
    const terms = ranges.map(r=>`between(t,${Math.max(0,r.start-pad).toFixed(3)},${Math.min(duration,r.end+pad).toFixed(3)})`);
    const CHUNK=20; const muteParts=[];
    for(let i=0;i<terms.length;i+=CHUNK){ muteParts.push(`volume=enable='${terms.slice(i,i+CHUNK).join('+')}':volume=0`); }
    const muteAf = muteParts.join(',');
    const output = path.join(EXPORTS, `${baseName}_censurado${q.copy?'':'_'+quality}_${Date.now()}.mp4`);
    const temporary = path.join(DATA, `export_${crypto.randomUUID()}.mp4`);
    let videoArgs;
    if(q.copy) videoArgs=['-c:v','copy'];
    else { const vf=[q.scale,q.fps?`fps=${q.fps}`:null].filter(Boolean).join(','); videoArgs=['-c:v','libx264','-preset','veryfast','-crf',String(q.crf||20),'-pix_fmt','yuv420p',...(vf?['-vf',vf]:[])]; }
    job = { status:'running', message:q.copy?`Silenciando ${ranges.length} ${ranges.length===1?'grosería':'groserías'}…`:`Silenciando y exportando (${q.label})…`, progress:'', percent:0, cancelRequested:false };
    (async () => {
      try {
        const af = muteAf+(audioChain?`,${audioChain}`:'');
        const fx=(clipIn&&clipIn!=='none')||(clipOut&&clipOut!=='none');
        let fxInFinalizeIn=clipIn, fxInFinalizeOut=clipOut;
        if(fx && !q.scale && !q.fps){
          // UN SOLO PASO: silenciar + efecto de entrada/salida juntos (no hay dos barras).
          const {width:EW,height:EH}=videoDimensions(project.videoPath); const efps=videoFps(project.videoPath);
          const fxg=clipFxParts('[m]', duration, clipIn, clipOut, clipDur, EW, EH, efps, 1);
          const parts=[`[0:v]settb=AVTB,fps=${efps},format=yuv420p,setsar=1[m]`, ...fxg.parts, `[0:a]${af}[ao]`];
          await run(bins.ffmpeg, ['-y','-i',project.videoPath,...fxg.inputs,'-filter_complex',parts.join(';'),'-map',fxg.label,'-map','[ao]',...HQ_VIDEO,'-c:a','aac','-b:a','192k','-movflags','+faststart',temporary], progress(duration,'Silenciando y aplicando efecto'));
          fxInFinalizeIn='none'; fxInFinalizeOut='none'; // ya aplicado
        } else {
          const base=['-y','-i',project.videoPath,'-map','0:v:0','-map','0:a:0'];
          const tail=['-af',af,'-c:a','aac','-b:a','192k','-movflags','+faststart',temporary];
          try {
            await run(bins.ffmpeg, [...base,...videoArgs,...tail], progress(duration,q.copy?'Silenciando':'Exportando'));
          } catch(copyErr) {
            if(!q.copy||job.cancelRequested) throw copyErr;
            job.message='Reencodeando en máxima calidad (el formato no permitía copiar)…'; job.percent=0;
            await run(bins.ffmpeg, [...base,...HQ_VIDEO,...tail], progress(duration,'Exportando (máxima calidad)'));
          }
        }
        await finalizeExport(bins.ffmpeg,temporary,output,intro,outro,studioOn,fxInFinalizeIn,fxInFinalizeOut,clipDur);
        const dl1=toDownloads(output); job = { status:'done', message:dl1?`✅ Listo y guardado en Descargas: ${path.basename(dl1)}`:`Video con groserías silenciadas: ${output}`, progress:'', percent:100, output, downloaded:dl1 };
      } catch (e) { await fsp.unlink(temporary).catch(()=>{}); job = { status: job.cancelRequested?'cancelled':'error', message: job.cancelRequested?e.message:`No se pudo silenciar: ${e.message}`, progress:'', percent:0 }; }
    })();
    return { output, cuts: ranges.length, mode };
  }
  // Si el editor de clips manda "segments" (los clips en orden), se concatenan EN ESE ORDEN (soporta reordenar/trim).
  let keep;
  if (Array.isArray(segments) && segments.length) {
    keep = segments.map(s=>({start:Math.max(0,+s.start),end:Math.min(duration,+s.end),zoom:!!s.zoom,trans:!!s.trans,join:!!s.join})).filter(s=>Number.isFinite(s.start)&&Number.isFinite(s.end)&&s.end-s.start>=0.04);
    if (!keep.length) throw Error('Los clips no son válidos.');
  } else {
    const chosenPauses=pauses.filter(p=>selectedPauseIds.includes(p.id));
    const cuts = adjustedCuts(matches, selectedIds, duration, words, adjustments,[...chosenPauses,...manualCuts]);
    if (!cuts.length) throw Error('Selecciona al menos una palabra o pausa para cortar.');
    keep = keptIntervals(cuts, duration);
    if (!keep.length) throw Error('Los cortes eliminarían el video completo.');
  }
  const keptTotal = keep.reduce((a,k)=>a+(k.end-k.start),0);
  // Censurar groserías DENTRO de los pedazos (modo Cortar + censor=true, p.ej. best-of): silencia por segmento,
  // con los tiempos relativos al inicio de cada pedazo (porque asetpts reinicia a 0).
  const CPAD=0.15;
  const censorRanges = censor ? (findMatches(transcript, dictionary)||[]).map(m=>({start:Number(m.start),end:Number(m.end)})).filter(r=>Number.isFinite(r.start)&&Number.isFinite(r.end)&&r.end>r.start) : [];
  const censorAf = (s,e)=>{
    if(!censorRanges.length) return '';
    const hits=censorRanges.filter(r=>r.end>s-CPAD && r.start<e+CPAD); if(!hits.length) return '';
    const terms=hits.map(r=>`between(t,${Math.max(0,r.start-CPAD-s).toFixed(3)},${Math.min(e-s,r.end+CPAD-s).toFixed(3)})`);
    let out=''; for(let i=0;i<terms.length;i+=20){ out+=`,volume=enable='${terms.slice(i,i+20).join('+')}':volume=0`; } // grupos para no agotar memoria
    return out;
  };
  const filter = [];
  let vLabel, aLabel;
  let smoothTotal = keptTotal; // duración REAL de salida con crossfade (los crossfades la acortan); para el fade de entrada/salida en 1 pasada
  // Zoom (punch-in) por segmento marcado con .zoom. Zoom ESTÁTICO (crop+scale): fiable, instantáneo
  // y sin colgarse (el zoompan de este ffmpeg se desboca generando miles de frames). Recorta ~1.12x al centro.
  const hasZoom = keep.some(k=>k.zoom);
  const {width:ZW,height:ZH} = hasZoom ? videoDimensions(project.videoPath) : {width:0,height:0};
  const zoomOf = (k)=> (k.zoom && ZW && ZH) ? `,crop=iw/1.12:ih/1.12,scale=${ZW}:${ZH},setsar=1` : '';
  const normOf = (k)=> zoomOf(k); // los pedazos sin zoom quedan en su tamaño nativo (ya coinciden para el concat)
  // Transición por tema (.trans = dissolve largo) y UNIR suave (.join = crossfade corto para que el corte no se note).
  const hasTrans = keep.some(k=>k.trans);
  const hasJoin = keep.some(k=>k.join);
  const canSmooth = (smooth||hasTrans||hasJoin) && keep.length>=2 && keep.length<=200 && keep.every(k=>k.end-k.start>0.25);
  if (canSmooth) {
    // Crossfade entre cada pedazo → une los cortes SIN que se note el brinco (estilo CapCut).
    // d por límite: 0.5s donde cambia el tema (.trans), 0.14s si se pidió suavizar, 0.05s en cortes normales (imperceptible).
    const fpsOut = q.fps || videoFps(project.videoPath);
    const Dxf=0.14;
    keep.forEach((k,i)=>{
      filter.push(`[0:v]trim=start=${k.start.toFixed(3)}:end=${k.end.toFixed(3)},setpts=PTS-STARTPTS${zoomOf(k)},settb=AVTB,fps=${fpsOut},format=yuv420p,setsar=1[v${i}]`);
      filter.push(`[0:a]atrim=start=${k.start.toFixed(3)}:end=${k.end.toFixed(3)},asetpts=PTS-STARTPTS${censorAf(k.start,k.end)}[a${i}]`);
    });
    let vp='[v0]', ap='[a0]', L=keep[0].end-keep[0].start;
    for(let i=1;i<keep.length;i++){
      const want = keep[i].trans ? 0.5 : keep[i].join ? 0.2 : (smooth ? Dxf : 0.05);
      const d=Math.min(want,(keep[i].end-keep[i].start)/2,(keep[i-1].end-keep[i-1].start)/2,L/2);
      filter.push(`${vp}[v${i}]xfade=transition=fade:duration=${d.toFixed(3)}:offset=${(L-d).toFixed(3)}[vx${i}]`);
      filter.push(`${ap}[a${i}]acrossfade=d=${d.toFixed(3)}[ax${i}]`);
      vp=`[vx${i}]`; ap=`[ax${i}]`; L=L+(keep[i].end-keep[i].start)-d;
    }
    vLabel=vp; aLabel=ap; smoothTotal=L; // L = largo real tras los crossfades
    if(stdEnhance){ filter.push(`${ap}${audioChain}[aout]`); aLabel='[aout]'; }
    if(q.scale){ filter.push(`${vLabel}${q.scale}[vout]`); vLabel='[vout]'; }
  } else {
    keep.forEach((k,i) => {
      filter.push(`[0:v]trim=start=${k.start.toFixed(3)}:end=${k.end.toFixed(3)},setpts=PTS-STARTPTS${normOf(k)}[v${i}]`);
      const length=k.end-k.start,fade=Math.min(.03,length/3);
      filter.push(`[0:a]atrim=start=${k.start.toFixed(3)}:end=${k.end.toFixed(3)},asetpts=PTS-STARTPTS${censorAf(k.start,k.end)},afade=t=in:st=0:d=${fade.toFixed(3)},afade=t=out:st=${(length-fade).toFixed(3)}:d=${fade.toFixed(3)}[a${i}]`);
    });
    filter.push(keep.map((_,i) => `[v${i}][a${i}]`).join('') + `concat=n=${keep.length}:v=1:a=1[v][a]`);
    aLabel = stdEnhance ? '[aout]' : '[a]';
    if (stdEnhance) filter.push(`[a]${audioChain}[aout]`);
    vLabel='[v]';
    if(!q.copy && (q.scale||q.fps)){const vf=[q.scale,q.fps?`fps=${q.fps}`:null].filter(Boolean).join(',');filter.push(`[v]${vf}[vout]`);vLabel='[vout]';}
  }
  // Efecto de entrada/salida fundido en el MISMO paso (una sola barra), salvo con crossfade o reescalado.
  let cutFxIn=clipIn, cutFxOut=clipOut, cutExtraInputs=[];
  // Fade de entrada/salida en la MISMA pasada (una sola barra), también CON transiciones/crossfade (antes eso forzaba una 2ª pasada).
  // Solo se difiere si hay reescalado (q.scale), caso raro.
  if(((clipIn&&clipIn!=='none')||(clipOut&&clipOut!=='none')) && !q.scale){
    const {width:EW,height:EH}=videoDimensions(project.videoPath); const efps=q.fps||videoFps(project.videoPath);
    filter.push(`${vLabel}settb=AVTB,fps=${efps},format=yuv420p,setsar=1[vnorm]`); // normaliza antes del xfade
    const fxg=clipFxParts('[vnorm]', canSmooth?smoothTotal:keptTotal, clipIn, clipOut, clipDur, EW, EH, efps, 1);
    if(fxg.applied){ fxg.parts.forEach(p=>filter.push(p)); vLabel=fxg.label; cutExtraInputs=fxg.inputs; cutFxIn='none'; cutFxOut='none'; }
    else { filter.pop(); } // no se aplicó efecto: quita la normalización que ya no se usa
  }
  const cutCrf=String(q.crf||18);
  // Render rápido cuando gpu=true: intenta GPU (NVENC) y, si el driver no lo soporta, cae solo a CPU veryfast.
  const cutVx264 = ['-c:v','libx264','-pix_fmt','yuv420p','-preset',gpu?'veryfast':'medium','-crf',cutCrf];
  const cutVnvenc = ['-c:v','h264_nvenc','-pix_fmt','yuv420p','-preset','p5','-rc','vbr','-cq',cutCrf,'-b:v','0'];
  const script = path.join(DATA,'filter.txt');
  await fsp.writeFile(script, filter.join(';\n'), 'utf8');
  const name = path.parse(project.videoPath).name.replace(/[^\p{L}\p{N}._-]+/gu,'_').slice(0,80);
  const output = path.join(EXPORTS, `${name}_limpio_${Date.now()}.mp4`);
  const temporary = path.join(DATA, `export_${crypto.randomUUID()}.mp4`);
  job = { status:'running', message:'Exportando video limpio…', progress:'', percent:0, cancelRequested:false };
  (async () => {
    try {
      const cutBase=['-y','-i',project.videoPath,...cutExtraInputs,'-/filter_complex',script,'-map',vLabel,'-map',aLabel];
      const cutTail=['-c:a','aac','-b:a','192k','-movflags','+faststart',temporary];
      try{
        await run(bins.ffmpeg, [...cutBase,...(gpu?cutVnvenc:cutVx264),...cutTail], progress(keptTotal,'Exportando'));
      }catch(gpuErr){
        if(!gpu || job.cancelRequested) throw gpuErr;
        job.message='El render por GPU no está disponible (actualiza el driver NVIDIA); exportando rápido por CPU…'; job.percent=0;
        await run(bins.ffmpeg, [...cutBase,...cutVx264,...cutTail], progress(keptTotal,'Exportando'));
      }
      await finalizeExport(bins.ffmpeg,temporary,output,intro,outro,studioOn,cutFxIn,cutFxOut,clipDur);
      const dl2=toDownloads(output); job = { status:'done', message:dl2?`✅ Listo y guardado en Descargas: ${path.basename(dl2)}`:`Video exportado: ${output}`, progress:'', percent:100, output, downloaded:dl2 };
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
// Sugiere ZOOMS automáticos: analiza la energía del audio por ventanas de 1s y marca los
// momentos más enfáticos (picos de volumen) para acercar ahí. Devuelve ventanas en tiempo de la fuente.
async function suggestZooms(){
  const bin=readiness().ffmpeg;
  if(!project?.videoPath||!bin) throw Error('Abre un video primero.');
  if(job.status==='running') throw Error('Espera a que termine el proceso actual.');
  const dur=await durationOf(project.videoPath).catch(()=>0);
  let out='';
  await run(bin,['-hide_banner','-i',project.videoPath,'-map','0:a:0','-af','aresample=16000,asetnsamples=n=16000,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-','-f','null','-'],s=>{out=(out+s).slice(-3000000);});
  const pts=[]; let curT=null;
  for(const line of out.split(/\r?\n/)){
    const mt=line.match(/pts_time:([\d.]+)/); if(mt){curT=Number(mt[1]);continue;}
    const mr=line.match(/RMS_level=(-?[\d.]+|-?inf|nan)/i);
    if(mr&&curT!=null){ let db=Number(mr[1]); if(!Number.isFinite(db)) db=-120; pts.push({t:curT,db}); curT=null; }
  }
  if(pts.length<4) return {peaks:[],windows:[]};
  const dbs=pts.map(p=>p.db); const mean=dbs.reduce((a,b)=>a+b,0)/dbs.length;
  const sd=Math.sqrt(dbs.reduce((a,b)=>a+(b-mean)*(b-mean),0)/dbs.length)||1;
  const thr=mean+0.6*sd; // picos claramente por encima del promedio
  const cand=[];
  for(let i=0;i<pts.length;i++){
    const p=pts[i], prev=(pts[i-1]&&pts[i-1].db)??-999, next=(pts[i+1]&&pts[i+1].db)??-999;
    if(p.db>=thr && p.db>=prev && p.db>=next) cand.push(p);
  }
  cand.sort((a,b)=>b.db-a.db);
  const chosen=[]; const minGap=6; const maxN=Math.max(3,Math.min(10,Math.round(dur/45)||3));
  for(const c of cand){ if(chosen.every(x=>Math.abs(x.t-c.t)>=minGap)){ chosen.push(c); if(chosen.length>=maxN) break; } }
  chosen.sort((a,b)=>a.t-b.t);
  const windows=chosen.map(c=>({start:Math.max(0,+(c.t-0.6).toFixed(2)),end:Math.min(dur,+(c.t+1.6).toFixed(2))})).filter(w=>w.end-w.start>0.5);
  return {peaks:chosen.map(c=>+c.t.toFixed(2)),windows};
}
// Detecta CAMBIOS DE TEMA con la IA (texto): agrupa la transcripción en bloques y le pide a gemma3
// los segundos donde empieza un tema nuevo → para meter una transición (fundido) ahí.
async function detectTopics(){
  if(!project?.videoPath) throw Error('Abre un video primero.');
  if(!Array.isArray(transcript)||!transcript.length) throw Error('Primero transcribe el video (Paso 2).');
  if(job.status==='running') throw Error('Espera a que termine el proceso actual.');
  const dur=await durationOf(project.videoPath).catch(()=>0);
  const build=(sec)=>{ const out=[]; let cur=null; for(const s of transcript){ const st=Number(s.start); const tx=String(s.text||'').trim(); if(!Number.isFinite(st)||!tx)continue; if(!cur||st-cur.t>=sec){ cur={t:st,text:tx}; out.push(cur);} else cur.text+=' '+tx; } return out; };
  let target=12, chunks=build(target);
  while(chunks.length>120){ target+=8; chunks=build(target); }
  if(chunks.length<3) return {boundaries:[]};
  const fmt=(s)=>{const m=Math.floor(s/60),x=Math.round(s%60);return `${m}:${String(x).padStart(2,'0')}`;};
  const list=chunks.map(c=>`[${fmt(c.t)}|${Math.round(c.t)}] ${c.text.replace(/\s+/g,' ').slice(0,150)}`).join('\n');
  const prompt=`Eres un editor de video que organiza un video de ${Math.round(dur)} segundos en CAPÍTULOS.\nAbajo está la transcripción en bloques; cada bloque empieza con [m:ss|SEGUNDOS].\nMarca SOLO los pocos momentos donde CLARAMENTE empieza un tema o segmento NUEVO (otra actividad, otro lugar, otro asunto). La mayoría de los videos tienen entre 2 y 6 capítulos. NO marques cada bloque; ignora repeticiones y charla del mismo tema.\nReglas: devuelve MÁXIMO 6 tiempos; cada tiempo DEBE ser uno de los SEGUNDOS que aparecen en la lista; no inventes números; no incluyas el 0.\nResponde SOLO con el arreglo JSON, ejemplo: [120, 340, 560]. Si no hay cambios claros, responde [].\n\n${list}`;
  let txt='';
  try{
    const r=await fetch(OLLAMA+'/api/generate',{method:'POST',signal:AbortSignal.timeout(120000),headers:{'content-type':'application/json'},body:JSON.stringify({model:SCAN_MODEL,prompt,stream:false,options:{temperature:0,num_predict:120}})});
    if(!r.ok) throw Error('Ollama '+r.status);
    const j=await r.json(); txt=String(j.response||'');
  }catch(e){ throw Error('No pude usar la IA de texto (¿Ollama abierto con gemma3:4b?). '+e.message); }
  // Parseo tolerante: intenta JSON; si viene cortado, saca los números después del primer "[".
  let arr=[]; const m=txt.match(/\[[\s\S]*?\]/);
  if(m){ try{ arr=JSON.parse(m[0]); }catch{} }
  if(!arr.length){ const br=txt.indexOf('['); if(br>=0){ arr=(txt.slice(br).match(/\d+(?:\.\d+)?/g)||[]).map(Number); } }
  const bounds=arr.map(Number).filter(n=>Number.isFinite(n)&&n>8&&n<dur-10).sort((a,b)=>a-b);
  const out=[]; for(const b of bounds){ if(out.every(x=>Math.abs(x-b)>=25)) out.push(b); }
  return {boundaries:out.slice(0,6).map(x=>+x.toFixed(2))};
}
// ===== RESUMEN DEL DIRECTO (best-of) =====
// Modelo pesado SOLO para esta sección (se carga bajo demanda). Combina texto (14B) + energía de audio (risas/gritos).
const BESTOF_MODEL='qwen2.5:14b-instruct';
let bestofScan=readJson(path.join(DATA,'bestof.json'), null); // se conserva al reiniciar
// Llama a la API de Claude (nube) en streaming para elegir los mejores momentos. Devuelve el texto (JSON).
async function cloudPick(prompt, model, onProgress){
  if(!cloud.key) throw Error('Falta la API key de la nube. Pégala en el motor de IA del resumen.');
  const r=await fetch('https://api.anthropic.com/v1/messages',{method:'POST',signal:AbortSignal.timeout(900000),
    headers:{'x-api-key':cloud.key,'anthropic-version':'2023-06-01','content-type':'application/json'},
    body:JSON.stringify({model:model||'claude-opus-5-5',max_tokens:8000,stream:true,messages:[{role:'user',content:prompt}]})});
  if(!r.ok){ let t=''; try{t=await r.text();}catch{} throw Error('La nube respondió '+r.status+(t?(': '+t.slice(0,180)):'')); }
  let txt='', buf=''; const dec=new TextDecoder();
  for await (const chunk of r.body){
    if(job.cancelRequested) throw Error('Análisis cancelado.');
    buf+=dec.decode(chunk,{stream:true}); let nl;
    while((nl=buf.indexOf('\n'))>=0){ const line=buf.slice(0,nl).trim(); buf=buf.slice(nl+1);
      if(line.startsWith('data:')){ const d=line.slice(5).trim(); if(!d||d==='[DONE]')continue;
        try{ const o=JSON.parse(d); if(o.type==='content_block_delta'&&o.delta&&o.delta.type==='text_delta'){ txt+=o.delta.text; onProgress&&onProgress(txt.length); } }catch{} } }
  }
  return txt;
}
async function detectBestMoments(opts){
  const bin=readiness().ffmpeg;
  if(!project?.videoPath||!bin) throw Error('Abre un video primero.');
  if(!Array.isArray(transcript)||!transcript.length) throw Error('Primero transcribe el video.');
  if(job.status==='running') throw Error('Espera a que termine el proceso actual.');
  const targetSec=Math.max(180,Math.min(2400,(Number(opts&&opts.minutes)||12)*60)); // objetivo de duración del resumen
  const want=Math.max(8,Math.min(45,Math.round(targetSec/55)+5)); // cuántos candidatos pedir al modelo
  const engine=((opts&&opts.engine)||cloud.engine||'local'); const useCloud=engine==='cloud'&&!!cloud.key;
  const cloudModel=(opts&&opts.model)||cloud.model||'claude-opus-5-5';
  job={status:'running',message:useCloud?'Analizando el directo con la nube…':'Analizando el directo con IA (modelo pesado)…',progress:'',percent:0,cancelRequested:false};
  (async()=>{
   try{
    if(engine==='cloud'&&!cloud.key) throw Error('Elegiste la nube pero falta la API key. Pégala en el motor de IA.');
    if(!useCloud && !(await ollamaHasModel('qwen2.5:14b'))) throw Error('Falta el modelo qwen2.5:14b-instruct en Ollama (ollama pull qwen2.5:14b-instruct).');
    const dur=await durationOf(project.videoPath).catch(()=>0);
    // 1) energía del audio por ventana de 1s (con progreso: útil en directos largos)
    job.message='Midiendo la energía del audio…'; job.percent=5;
    let out='';
    await run(bin,['-hide_banner','-i',project.videoPath,'-map','0:a:0','-af','aresample=16000,asetnsamples=n=16000,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-','-f','null','-'],s=>{
      out=(out+s).slice(-6000000);
      if(dur>0){ const mm=String(s).match(/pts_time:([\d.]+)/g); if(mm&&mm.length){ const last=+mm[mm.length-1].split(':')[1]; job.percent=5+Math.min(20,Math.round(last/dur*20)); job.message=`Midiendo la energía del audio… ${Math.round(last/dur*100)}%`; } }
    });
    const energy=[]; let curT=null;
    for(const line of out.split(/\r?\n/)){ const mt=line.match(/pts_time:([\d.]+)/); if(mt){curT=Number(mt[1]);continue;} const mr=line.match(/RMS_level=(-?[\d.]+|-?inf|nan)/i); if(mr&&curT!=null){ let db=Number(mr[1]); if(!Number.isFinite(db))db=-120; energy.push({t:curT,db}); curT=null; } }
    // 2) bloques ~20s con texto + su pico de energía
    job.message='Preparando la transcripción…'; job.percent=18;
    const build=(sec)=>{const o=[];let cur=null;for(const s of transcript){const t=Number(s.start);const tx=String(s.text||'').trim();if(!Number.isFinite(t)||!tx)continue;if(!cur||t-cur.t>=sec){cur={t,text:tx};o.push(cur);}else cur.text+=' '+tx;}return o;};
    const maxChunks=useCloud?1500:160; // la nube tiene contexto gigante: puede leer muchos más bloques
    let sec=useCloud?12:20, chunks=build(sec); while(chunks.length>maxChunks && sec<3600){ sec=Math.ceil(sec*1.6)+5; chunks=build(sec); } // intervalo SIEMPRE crece (antes oscilaba = bucle infinito en directos largos)
    if(chunks.length<2) throw Error('La transcripción es muy corta para un resumen.');
    let emin=Infinity,emax=-Infinity; for(const e of energy){ if(e.db<emin)emin=e.db; if(e.db>emax)emax=e.db; } if(!Number.isFinite(emin)){emin=-60;emax=-20;} const span=(emax-emin)||1;
    for(const c of chunks){ let peak=emin; for(const e of energy){ if(e.t>=c.t&&e.t<c.t+20&&e.db>peak)peak=e.db; } c.e10=Math.round((peak-emin)/span*10); }
    const fmt=s=>{const m=Math.floor(s/60),x=Math.round(s%60);return `${m}:${String(x).padStart(2,'0')}`;};
    const sliceLen=useCloud?600:170; // la nube lee el texto COMPLETO de cada bloque; el local solo una muestra
    const list=chunks.map(c=>`[${Math.round(c.t)}|${fmt(c.t)}|energia ${c.e10}/10] ${c.text.replace(/\s+/g,' ').slice(0,sliceLen)}`).join('\n');
    // 3) el 14B elige los mejores momentos (streaming para mostrar progreso real)
    job.message='La IA está eligiendo los mejores momentos… (modelo pesado, tarda)'; job.percent=30;
    const tgtMin=Math.round(targetSec/60);
    // La instrucción va DESPUÉS del texto (el modelo sigue mejor lo último) + objeto JSON (sin esto, en directos largos el 14B "resume" en prosa).
    const prompt=`DIRECTO (bloques [SEGUNDOS|m:ss|energia X/10] texto; energia alta = risas/gritos/reaccion):\n${list}\n\n=====\nTAREA: de los bloques de ARRIBA, extrae los ${want} MEJORES momentos para un video de clips de un streamer mexicano (lo mas gracioso, polemico, sorprendente, emotivo o con reaccion fuerte). Evita relleno y saludos; reparte a lo largo del directo. Cada momento dura de 45 a 120 segundos.\nResponde SOLO este JSON, sin texto ni resumen en prosa: {"momentos":[{"ini":<segundos del bloque>,"dur":<45-120>,"gancho":"<TITULO MAYUSCULAS>","por":"<1 frase>","score":<1-10>}]}`;
    const NP=useCloud?8000:3000;
    let txt='';
    if(useCloud){
      // NUBE (Claude): lee el directo completo y elige con mejor criterio. Streaming para progreso.
      job.message=`La nube (${cloudModel.replace('claude-','').replace('-',' ')}) está leyendo el directo completo…`; job.percent=32;
      const expect=Math.max(1500, want*110); // estimación de chars de respuesta para la barra
      txt=await cloudPick(prompt, cloudModel, (len)=>{ job.percent=32+Math.min(55,Math.round(len/expect*55)); job.message='La nube está eligiendo los mejores momentos…'; });
    } else {
      // LOCAL (Ollama 14B). num_ctx subido para que quepa todo el directo (Ollama por defecto lo corta).
      const estTok=Math.ceil(prompt.length/3.5)+NP+600;
      const numCtx=Math.min(16384, Math.max(4096, Math.ceil(estTok/2048)*2048));
      job.message='La IA está leyendo el directo completo…';
      const res=await fetch(OLLAMA+'/api/generate',{method:'POST',signal:AbortSignal.timeout(2400000),headers:{'content-type':'application/json'},body:JSON.stringify({model:BESTOF_MODEL,prompt,stream:true,format:'json',options:{temperature:0.4,num_predict:NP,num_ctx:numCtx}})});
      if(!res.ok) throw Error('Ollama '+res.status);
      let sbuf='', toks=0; const dec=new TextDecoder();
      for await (const chunk of res.body){
        if(job.cancelRequested) throw Error('Análisis cancelado.');
        sbuf+=dec.decode(chunk,{stream:true});
        let nl; while((nl=sbuf.indexOf('\n'))>=0){ const line=sbuf.slice(0,nl); sbuf=sbuf.slice(nl+1); if(!line.trim())continue; try{ const o=JSON.parse(line); if(o.response){ txt+=o.response; toks++; } }catch{} }
        job.percent=30+Math.min(57,Math.round(toks/NP*57));
        job.message=`La IA está eligiendo los mejores momentos… ${job.percent}% (modelo pesado)`;
      }
    }
    job.percent=88; job.message='Ordenando los momentos…';
    let arr=[]; try{ const pj=JSON.parse(txt); arr=Array.isArray(pj)?pj:(pj.momentos||pj.moments||[]); }catch{}
    if(!arr.length){ const m=txt.match(/\[[\s\S]*\]/); if(m){ try{ arr=JSON.parse(m[0]); }catch{} } }
    const cands=[];
    for(const o of (Array.isArray(arr)?arr:[])){
      const ini=Math.max(0,Number(o.ini)); let d=Math.max(30,Math.min(130,Number(o.dur)||70));
      if(!Number.isFinite(ini)||ini>=dur-2) continue;
      const end=Math.min(dur,ini+d); if(end-ini<12) continue;
      const win=energy.filter(e=>e.t>=ini&&e.t<end); const peak=win.length?Math.max(...win.map(e=>e.db)):emin;
      cands.push({start:+ini.toFixed(2),end:+end.toFixed(2),gancho:String(o.gancho||'').slice(0,40),por:String(o.por||'').slice(0,120),score:Math.max(1,Math.min(10,Number(o.score)||5)),energia:Math.round((peak-emin)/span*10)});
    }
    // Selección QUALITY-FIRST: los momentos del modelo son SUS mejores; se toman por score, sin solaparse.
    // La duración es un TOPE máximo, NO un mínimo: si solo hay pocos momentos buenos, se dejan pocos — NO se fuerza relleno.
    cands.sort((a,b)=> b.score-a.score || b.energia-a.energia);
    const picked=[]; let tot=0;
    for(const c of cands){ if(!picked.every(p=>c.start>=p.end-1||c.end<=p.start+1)) continue; picked.push(c); tot+=c.end-c.start; if(tot>=targetSec) break; }
    // Red de seguridad SOLO si el modelo casi no encontró nada (falló): ofrece unos POCOS picos de audio (máx 6), sin rellenar a la fuerza.
    if(picked.length<3){
      const dbs2=energy.map(e=>e.db); const mean2=dbs2.reduce((a,b)=>a+b,0)/(dbs2.length||1);
      const sd2=Math.sqrt(dbs2.reduce((a,b)=>a+(b-mean2)*(b-mean2),0)/(dbs2.length||1))||1;
      const peaks=[]; for(let i=1;i<energy.length-1;i++){ const p=energy[i]; if(p.db>=mean2+0.8*sd2 && p.db>=energy[i-1].db && p.db>=energy[i+1].db) peaks.push(p); }
      peaks.sort((a,b)=>b.db-a.db);
      for(const pk of peaks){ if(picked.length>=6) break; const st=Math.max(0,pk.t-25), en=Math.min(dur,pk.t+35); if(en-st<20) continue;
        if(!picked.every(p=>st>=p.end-1||en<=p.start+1)) continue;
        const e10=Math.round((pk.db-emin)/span*10);
        picked.push({start:+st.toFixed(2),end:+en.toFixed(2),gancho:'MOMENTO FUERTE',por:'Pico de reacción/risas (detectado por audio).',score:5,energia:e10}); tot+=en-st;
      }
    }
    picked.sort((a,b)=>a.start-b.start);
    bestofScan={candidates:picked,scannedAt:Date.now(),model:useCloud?cloudModel:BESTOF_MODEL,engine:useCloud?'cloud':'local',total:dur,count:picked.length,targetMin:Math.round(targetSec/60),durMin:+(tot/60).toFixed(1)};
    writeJson(path.join(DATA,'bestof.json'),bestofScan);
    job={status:'done',message:`Resumen listo: ${picked.length} momentos (~${Math.round(tot/60)} min). Revisa y ajusta.`,progress:'',percent:100};
   }catch(e){ job={status:job.cancelRequested?'cancelled':'error',message:e.message,progress:'',percent:0}; }
  })();
}
// Detecta silencios y calcula los PEDAZOS A CONSERVAR (como "quitar silencios" de CapCut).
function detectSilences(opts){
  const bin=readiness().ffmpeg;
  if(!project?.videoPath||!bin) throw Error('Abre un video primero.');
  if(job.status==='running') throw Error('Ya hay un proceso en curso.');
  const noise=Math.max(10,Math.min(60,Number(opts.noise)||30)); // dB bajo cero
  const minSil=Math.max(0.25,Math.min(5,Number(opts.minSil)||0.6)); // silencio mínimo para cortar
  const pad=Math.max(0,Math.min(0.5,opts.pad==null?0.12:Number(opts.pad))); // margen que se conserva a cada lado
  job={status:'running',message:'Buscando silencios en el audio…',progress:'',percent:0,cancelRequested:false};
  (async()=>{
    try{
      const total=await durationOf(project.videoPath).catch(()=>0);
      let log=''; const report=progress(total,'Silencios');
      await run(bin,['-hide_banner','-i',project.videoPath,'-vn','-af',`silencedetect=noise=-${noise}dB:d=${minSil}`,'-f','null','NUL'],s=>{log=(log+s).slice(-4000000);report(s);});
      // tramos de silencio (encogidos por el margen pad)
      const sil=[]; let start=null;
      for(const line of log.split(/\r?\n/)){
        const a=line.match(/silence_start:\s*(-?[\d.]+)/), b=line.match(/silence_end:\s*([\d.]+)/);
        if(a) start=Math.max(0,Number(a[1]));
        if(b&&start!==null){ const end=Number(b[1]); const s=start+pad, e=end-pad; if(e-s>0.12) sil.push({start:+s.toFixed(3),end:+e.toFixed(3)}); start=null; }
      }
      // conservar = complemento de los silencios dentro de [0,total]
      const keep=[]; let cur=0;
      for(const s of sil){ if(s.start>cur+0.1) keep.push({start:+cur.toFixed(3),end:+s.start.toFixed(3)}); cur=Math.max(cur,s.end); }
      if(total>cur+0.1) keep.push({start:+cur.toFixed(3),end:+total.toFixed(3)});
      const keptSec=keep.reduce((a,k)=>a+(k.end-k.start),0);
      silenceScan={keep,removed:sil.length,total:+total.toFixed(2),kept:+keptSec.toFixed(2),saved:+(total-keptSec).toFixed(2),noise,minSil,pad,scannedAt:Date.now()};
      job={status:'done',message:sil.length?`Encontré ${sil.length} silencio(s). El video pasaría de ${fmtSec(total)} a ${fmtSec(keptSec)}.`:'No encontré silencios que quitar con esa sensibilidad.',progress:'',percent:100,silence:true};
    }catch(e){ job={status:job.cancelRequested?'cancelled':'error',message:e.message,progress:'',percent:0}; }
  })();
  return {started:true};
}
function fmtSec(s){s=Math.max(0,Math.round(s));return `${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`;}
// SELECCIÓN DE SHORTS POR NUBE (Opus/Sonnet/Haiku) — estilo OpusClip: la IA LEE TODO el directo + la energía del audio
// y elige los mejores momentos virales de 30-60s con gancho, en vez del algoritmo por ritmo + modelo chico.
async function cloudShorts(model, want, onProgress){
  const bin=readiness().ffmpeg;
  const dur=await durationOf(project.videoPath).catch(()=>0);
  // 1) energía del audio (reacciones/risas/gritos)
  job.message='Midiendo reacciones (audio)…'; job.percent=6;
  let out='';
  await run(bin,['-hide_banner','-i',project.videoPath,'-map','0:a:0','-af','aresample=16000,asetnsamples=n=16000,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-','-f','null','-'],s=>{
    out=(out+s).slice(-6000000);
    if(dur>0){ const mm=String(s).match(/pts_time:([\d.]+)/g); if(mm&&mm.length){ const last=+mm[mm.length-1].split(':')[1]; job.percent=6+Math.min(16,Math.round(last/dur*16)); } }
  });
  const energy=[]; let curT=null;
  for(const line of out.split(/\r?\n/)){ const mt=line.match(/pts_time:([\d.]+)/); if(mt){curT=Number(mt[1]);continue;} const mr=line.match(/RMS_level=(-?[\d.]+|-?inf|nan)/i); if(mr&&curT!=null){ let db=Number(mr[1]); if(!Number.isFinite(db))db=-120; energy.push({t:curT,db}); curT=null; } }
  let emin=Infinity,emax=-Infinity; for(const e of energy){ if(e.db<emin)emin=e.db; if(e.db>emax)emax=e.db; } if(!Number.isFinite(emin)){emin=-60;emax=-20;} const span=(emax-emin)||1;
  // 2) bloques ~10s con texto + pico de energía
  job.message='Preparando la transcripción…'; job.percent=24;
  const build=(sec)=>{const o=[];let cur=null;for(const s of transcript){const t=Number(s.start);const tx=String(s.text||'').trim();if(!Number.isFinite(t)||!tx)continue;if(!cur||t-cur.t>=sec){cur={t,text:tx};o.push(cur);}else cur.text+=' '+tx;}return o;};
  let sec=10, chunks=build(sec); while(chunks.length>1800 && sec<3600){ sec=Math.ceil(sec*1.5)+3; chunks=build(sec); }
  if(chunks.length<2) throw Error('La transcripción es muy corta para Shorts.');
  for(const c of chunks){ let peak=emin; for(const e of energy){ if(e.t>=c.t&&e.t<c.t+sec&&e.db>peak)peak=e.db; } c.e10=Math.round((peak-emin)/span*10); }
  const fmt=s=>{const m=Math.floor(s/60),x=Math.round(s%60);return `${m}:${String(x).padStart(2,'0')}`;};
  const list=chunks.map(c=>`[${Math.round(c.t)}|${fmt(c.t)}|e${c.e10}] ${c.text.replace(/\s+/g,' ').slice(0,400)}`).join('\n');
  // 3) la nube elige los mejores SHORTS virales
  job.message='La nube está eligiendo los mejores momentos para Shorts…'; job.percent=30;
  const prompt=`DIRECTO de un streamer mexicano (bloques [SEGUNDOS|m:ss|eN] texto; eN alto = risas/gritos/reaccion):\n${list}\n\n=====\nTAREA: de los bloques de ARRIBA, elige los ${want} MEJORES momentos para SHORTS VIRALES (TikTok/Reels/YouTube Shorts). Cada Short:\n- dura de 30 a 60 segundos\n- es AUTO-CONTENIDO (se entiende solo, sin contexto previo)\n- tiene un GANCHO fuerte en los primeros 3 segundos (gracioso, polemico, sorprendente, tierno o con reaccion fuerte)\n- el "ini" cae donde EMPIEZA el momento (el setup), NO a media frase\nEvita relleno, saludos y logistica aburrida. Reparte los momentos a lo largo del directo.\nResponde SOLO este JSON, sin texto extra: {"shorts":[{"ini":<segundos del bloque>,"dur":<30-60>,"gancho":"<TITULO CORTO EN MAYUSCULAS, max 40 caracteres>","por":"<por que es viral, 1 frase>","score":<1-10>}]}`;
  const txt=await cloudPick(prompt, model, onProgress);
  let arr=[]; try{ const pj=JSON.parse(txt); arr=Array.isArray(pj)?pj:(pj.shorts||pj.momentos||[]); }catch{}
  if(!arr.length){ const m=txt.match(/\[[\s\S]*\]/); if(m){ try{ arr=JSON.parse(m[0]); }catch{} } }
  const words=tokenizeTranscript(transcript);
  const cands=[];
  for(const o of (Array.isArray(arr)?arr:[])){
    let ini=Math.max(0,Number(o.ini)); let d=Math.max(20,Math.min(75,Number(o.dur)||45));
    if(!Number.isFinite(ini)||ini>=dur-5) continue;
    // Ajuste de bordes a PAUSAS naturales (no cortar a media palabra)
    let start=words.length?nearestPause(words,ini,3):ini;
    let end=words.length?nearestPause(words,Math.min(dur,ini+d),3):Math.min(dur,ini+d);
    start=Math.max(0,start); end=Math.min(dur,end);
    if(end-start<15) end=Math.min(dur,start+Math.max(20,d));
    if(end-start>90) end=start+90;
    if(end-start<12) continue;
    const win=energy.filter(e=>e.t>=start&&e.t<end); const peak=win.length?Math.max(...win.map(e=>e.db)):emin;
    cands.push({ start:+start.toFixed(2), end:+end.toFixed(2), gancho:String(o.gancho||'').slice(0,40), por:String(o.por||'').slice(0,140), score:Math.max(1,Math.min(10,Number(o.score)||6)), energia:Math.round((peak-emin)/span*10) });
  }
  cands.sort((a,b)=> b.score-a.score || b.energia-a.energia);
  const picked=[];
  for(const c of cands){ if(picked.every(p=>c.start>=p.end-1||c.end<=p.start+1)) picked.push(c); }
  picked.sort((a,b)=>a.start-b.start);
  return picked;
}
async function proposeShorts(opts) {
  if (!project?.videoPath || !transcript.length) throw Error('Abre y transcribe un video primero.');
  if (job.status==='running') throw Error('Espera a que termine el proceso actual.');
  const engine=((opts&&opts.engine)||'local'); const useCloud=engine==='cloud'&&!!cloud.key;
  const cloudModel=(opts&&opts.model)||cloud.model||'claude-opus-5-5';
  if(engine==='cloud'&&!cloud.key) throw Error('Elegiste la nube pero falta la API key. Pégala en 🎬 Resumen del directo → Motor de IA.');
  const duration=await durationOf(project.videoPath);
  // conserva lo que el usuario ya ajustó (gancho/correcciones/encuadre) por id
  const hooksById=new Map(shorts.map(s=>[s.id,s.hook||'']));
  const correctionsById=new Map(shorts.map(s=>[s.id,s.captionCorrections||[]]));
  const settingsById=new Map(shorts.map(s=>[s.id,{framingMode:s.framingMode||'auto',cropCenter:s.cropCenter??.5,zoomEnabled:s.zoomEnabled!==false,captionStyle:s.captionStyle||'verde'}]));
  const tok=tokenizeTranscript(transcript);
  const mk=(c,i,method,reason)=>{ const id='s'+Math.round(c.start*10)+'_'+Math.round(c.end*10);
    const opening=tok.filter(x=>x.start>=c.start&&x.start<Math.min(c.end,c.start+10)).slice(0,20).map(x=>x.text.trim()).join(' ').replace(/\s+/g,' ').trim();
    const set=settingsById.get(id)||{};
    return { id, start:c.start, end:c.end, opening:opening||c.opening||'(momento)', score:c.score||0, editorialScore:c.editorialScore??(c.score?c.score*10:0), reason, method, gancho:c.gancho||'', por:c.por||'',
      hook:hooksById.get(id)||c.gancho||'', captionCorrections:correctionsById.get(id)||[],
      framingMode:set.framingMode||'auto', cropCenter:set.cropCenter??.5, zoomEnabled:set.zoomEnabled!==false, captionStyle:set.captionStyle||'verde', format:'vertical', rank:i+1 }; };
  if(useCloud){
    const modShort=cloudModel.replace('claude-','').replace(/-/g,' ');
    job={status:'running',message:`Analizando el directo con la nube (${modShort}) para Shorts…`,progress:'',percent:0,cancelRequested:false};
    (async()=>{
      try{
        const want=Math.max(5,Math.min(12,Math.round(duration/420)+5));
        const expect=Math.max(1200, want*120);
        const picked=await cloudShorts(cloudModel, want, (len)=>{ if(job.cancelRequested)return; job.percent=30+Math.min(58,Math.round(len/expect*58)); });
        if(!picked.length) throw Error('La nube no devolvió momentos válidos. Intenta de nuevo o usa el modo local.');
        job.percent=92;
        shorts=picked.map((c,i)=>mk({...c,editorialScore:Math.round((c.score||6)*10)}, i, 'nube '+modShort, c.por||'Elegido por la IA (nube)'));
        writeJson(files.shorts,shorts);
        job={status:'done',message:`${shorts.length} Shorts elegidos por la nube (${modShort}). Revisa y crea los que gusten.`,progress:'',percent:100};
      }catch(e){ job={status:job.cancelRequested?'cancelled':'error',message:e.message,progress:'',percent:0}; }
    })();
    return {started:true};
  }
  // ---- LOCAL (como antes: ritmo + gemma3) ----
  const candidates=suggestShorts(transcript,duration,16,{min:30,max:60});
  if (!candidates.length) throw Error('La transcripción no tiene suficientes momentos para Shorts.');
  job={status:'running',message:'Evaluando escenas con un modelo local…',progress:'',percent:0,cancelRequested:false};
  (async()=>{
    try {
      const model=process.env.EDITOR_IRL_MODEL||'gemma3:4b';
      const tags=await fetch('http://127.0.0.1:11434/api/tags',{signal:AbortSignal.timeout(3000)}).then(r=>r.json());
      if (!tags.models?.some(m=>m.name===model)) throw Error('Modelo local no disponible');
      const words=tok;
      const evaluated=[];
      for (let i=0;i<candidates.length;i++) {
        if(job.cancelRequested) throw Error('__CANCELLED__');
        const candidate=candidates[i];
        const excerpt=words.filter(w=>w.start>=candidate.start&&w.start<candidate.end).map(w=>w.text.trim()).join(' ');
        let criteria=null, gancho='';
        try { const r=await assessCandidate(model,excerpt); criteria=r.criteria; gancho=r.gancho; } catch(err) { /* una escena mala no tumba el lote */ }
        if (criteria) { const summary=summarizeAssessment(criteria); evaluated.push({...candidate,editorialScore:summary.score,reason:summary.reason,gancho,method:'modelo local'}); }
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
      shorts=picks.map((s,i)=>mk(s,i,s.method,s.reason));
      writeJson(files.shorts,shorts);
      job={status:'done',message:`${shorts.length} propuestas evaluadas con ${model}. Para mejores Shorts usa el motor de Nube (arriba).`,progress:'',percent:100};
    } catch(e) {
      if(job.cancelRequested){job={status:'cancelled',message:'Proceso cancelado por el usuario.',progress:'',percent:0};return;}
      shorts=candidates.slice(0,5).map((s,i)=>mk(s,i,'ritmo','por ritmo del audio'));
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
  const n=Math.max(20,Math.min(70,Math.round(dur/26))); // menos miniaturas = la línea de tiempo aparece más rápido
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
// Spawn liviano para tareas EN SEGUNDO PLANO (miniaturas): NO toca activeProc, así no interfiere
// con el Cancelar de un trabajo real ni lo bloquea. Puede correr a la par de transcribir/editar.
function runBG(exe,args){ return new Promise((resolve,reject)=>{ const c=spawn(exe,args,{windowsHide:true,cwd:ROOT}); let err=''; c.stderr.on('data',b=>{err=(err+b.toString()).slice(-800);}); c.on('error',reject); c.on('close',code=>code===0?resolve():reject(Error('bg '+code))); }); }
// Miniaturas de la línea de tiempo EN SEGUNDO PLANO: el video ya se puede usar mientras se generan
// (no hay segunda barra de carga). Se exponen por /api/job (stripBuilding) para que el frontend las muestre al terminar.
// (La onda de audio se quitó: el frontend nunca la dibujaba, solo gastaba tiempo de carga.)
let stripGen=0;
async function buildFilmstripBG(input){
  const myGen=++stripGen; // un BG nuevo (otro video / regenerar) invalida el anterior
  const bin=readiness().ffmpeg; if(!bin||!input) return;
  filmstrip={count:0,interval:0,wave:false,building:true};
  try{
    const dur=await durationOf(input).catch(()=>0);
    if(!dur||myGen!==stripGen||project?.videoPath!==input){ if(myGen===stripGen&&filmstrip) filmstrip={...filmstrip,building:false}; return; }
    const n=Math.max(20,Math.min(45,Math.round(dur/40)||20)); // menos miniaturas = aparecen más rápido
    const interval=dur/n;
    const stripDir=path.join(DATA,'strip');
    await fsp.rm(stripDir,{recursive:true,force:true}).catch(()=>{}); await fsp.mkdir(stripDir,{recursive:true});
    filmstrip={count:0,interval:+interval.toFixed(3),wave:false,building:true};
    for(let i=0;i<n;i++){
      if(myGen!==stripGen||project?.videoPath!==input) return; // abortado (otro video o regenerar)
      const t=((i+0.5)*interval).toFixed(2);
      await runBG(bin,['-y','-ss',String(t),'-i',input,'-frames:v','1','-vf','scale=160:-2','-q:v','6',path.join(stripDir,`t${String(i+1).padStart(4,'0')}.jpg`)]).catch(()=>{});
      if(myGen!==stripGen||project?.videoPath!==input) return;
      filmstrip={count:i+1,interval:+interval.toFixed(3),wave:false,building:true}; // progresivo: aparecen conforme se generan
    }
    filmstrip={count:n,interval:+interval.toFixed(3),wave:false,building:false};
  }catch{ if(myGen===stripGen&&filmstrip) filmstrip={...filmstrip,building:false}; }
}
// Deja el proyecto LISTO al abrirlo (como CapCut): la ÚNICA espera es la vista previa (solo si el formato no se ve
// en el navegador); las miniaturas van en segundo plano y no bloquean. El video queda usable lo antes posible.
function prepareProject(){
  const bin=readiness().ffmpeg;
  if(!bin||!project?.videoPath) return;
  const input=project.videoPath;
  const needPrev = needsPreview(input) && !(project.previewPath&&fs.existsSync(project.previewPath));
  if(!needPrev){ buildFilmstripBG(input); return; } // el video ya se ve → solo miniaturas en segundo plano
  if(job.status==='running') return;
  job={status:'running',message:'Preparando el video…',progress:'',percent:0,cancelRequested:false};
  (async()=>{
    try{
      await buildPreviewFile(bin);
      if(project?.videoPath!==input){ job={status:'done',message:'',percent:100}; return; }
      job={status:'done',message:'Video listo. ✅',progress:'',percent:100};
      buildFilmstripBG(input); // miniaturas en segundo plano (sin segunda barra)
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
      body:JSON.stringify({model:SCAN_MODEL,prompt:scanPrompt(),images:[b64],stream:false,options:{temperature:0,num_predict:120}})});
    if(!r.ok) throw Error('Ollama '+r.status);
    const j=await r.json(); const txt=String(j.response||'');
    const m=txt.match(/\{[\s\S]*\}/); if(!m) return {beso:false,desnudez:false,pelea:false,drogas:false,riesgo:'ninguno',nota:''};
    const o=JSON.parse(m[0]);
    return {beso:!!o.beso,desnudez:!!o.desnudez,pelea:!!o.pelea,drogas:!!o.drogas,riesgo:String(o.riesgo||'ninguno'),nota:String(o.nota||'').slice(0,80)};
  }catch(e){ return null; } // un frame que falla no tumba el escaneo
}
async function ollamaHasModel(prefix){ try{ const r=await fetch(OLLAMA+'/api/tags',{signal:AbortSignal.timeout(4000)}); if(!r.ok)return false; const j=await r.json(); return (j.models||[]).some(m=>String(m.name||'').startsWith(prefix)); }catch{return false;} }
// Etapa 1 RÁPIDA: moondream (modelo chico) dice si el frame es sospechoso (sí/no). Lo sospechoso lo confirma gemma3.
async function moondreamQuick(fp){
  let b64; try{ b64=await fsp.readFile(fp,{encoding:'base64'}); }catch{ return true; }
  try{
    const r=await fetch(OLLAMA+'/api/generate',{method:'POST',signal:AbortSignal.timeout(40000),headers:{'content-type':'application/json'},
      body:JSON.stringify({model:'moondream',prompt:'Does this image contain nudity, a sexual act, people kissing, a real physical fight with blows or blood, or visible drug use? Answer only YES or NO.',images:[b64],stream:false,options:{temperature:0,num_predict:8}})});
    if(!r.ok) return true; const j=await r.json(); return /\byes\b|\bs[ií]\b/i.test(String(j.response||''));
  }catch{ return true; } // ante la duda, que lo revise gemma3
}
const RISK_ORDER={ninguno:0,bajo:1,medio:2,alto:3};
// Visión en la NUBE (Claude Haiku) para el escáner sensible: varios fotogramas por llamada (barato) + prompt MUY estricto.
async function cloudClassifyBatch(files){
  const content=[];
  for(const fp of files){ let b64; try{ b64=await fsp.readFile(fp,{encoding:'base64'}); }catch{ continue; } content.push({type:'image',source:{type:'base64',media_type:'image/jpeg',data:b64}}); }
  if(!content.length) return [];
  content.push({type:'text',text:`Eres moderador de YouTube. Te doy ${content.length} fotogramas de un video EN ORDEN. Para CADA uno marca SOLO lo que YouTube penaliza de verdad y que sea CLARO Y EVIDENTE: un BESO en la boca evidente, DESNUDEZ (genitales, senos o nalgas al descubierto) o acto sexual, una PELEA REAL con golpes o sangre, o consumo visible de DROGAS.\nSE MUY ESTRICTO: abrazos, saludos, gente cerca o posando, baile, fiesta, una copa o cerveza social, ropa escotada o de fiesta = NO cuentan (todo false). Ante la MENOR duda, pon false.\nResponde SOLO un arreglo JSON, un objeto por fotograma EN EL MISMO ORDEN, sin texto extra: [{"beso":bool,"desnudez":bool,"pelea":bool,"drogas":bool,"riesgo":"ninguno|bajo|medio|alto"}]`});
  const r=await fetch('https://api.anthropic.com/v1/messages',{method:'POST',signal:AbortSignal.timeout(120000),
    headers:{'x-api-key':cloud.key,'anthropic-version':'2023-06-01','content-type':'application/json'},
    body:JSON.stringify({model:'claude-haiku-4-5',max_tokens:1500,messages:[{role:'user',content}]})});
  if(!r.ok){ let t=''; try{t=await r.text();}catch{} throw Error('La nube (visión) respondió '+r.status+(t?(': '+t.slice(0,160)):'')); }
  const j=await r.json(); let txt=''; for(const b of (j.content||[])){ if(b.type==='text') txt+=b.text; }
  let arr=[]; const m=txt.match(/\[[\s\S]*\]/); if(m){ try{ arr=JSON.parse(m[0]); }catch{} }
  return Array.isArray(arr)?arr:[];
}
function scanSensitive(opts){
  const bin=readiness().ffmpeg;
  if(!bin||!project?.videoPath) throw Error('Abre un video primero.');
  if(job.status==='running') throw Error('Espera a que termine el proceso actual.');
  const cats=(Array.isArray(opts.cats)&&opts.cats.length)?opts.cats.filter(c=>SCAN_CATS.includes(c)):SCAN_CATS.slice();
  const sens=['relajado','normal','estricto'].includes(opts.sensitivity)?opts.sensitivity:'normal';
  const minRisk=sens==='relajado'?3:sens==='estricto'?1:2; // umbral por sensibilidad
  const step=Math.max(2,Math.min(15,Number(opts.step)||4));
  const maxFrames=Math.max(10,Math.min(600,Number(opts.max)||250));
  const engine=(opts.engine==='cloud'&&cloud.key)?'cloud':'local';
  // SOLO escanea los pedazos conservados (los clips del editor), no el video completo → no malgasta dinero/tiempo en lo borrado.
  const segsIn=(Array.isArray(opts.segments)&&opts.segments.length)?opts.segments.map(s=>({start:Math.max(0,+s.start),end:+s.end})).filter(s=>Number.isFinite(s.start)&&Number.isFinite(s.end)&&s.end-s.start>0.3):null;
  job={status:'running',message:'Preparando análisis con IA…',progress:'',percent:0,cancelRequested:false};
  (async()=>{
    try{
      if(opts.engine==='cloud'&&!cloud.key) throw Error('Elegiste la nube pero falta la API key. Pégala en el motor de IA del resumen.');
      if(engine==='local'&&!(await ollamaHasVision())) throw Error('No encuentro gemma3 en Ollama. Abre Ollama y ten el modelo gemma3:4b instalado.');
      const dur=await durationOf(project.videoPath);
      const segs=segsIn?segsIn.map(s=>({start:s.start,end:Math.min(dur,s.end)})):[{start:1,end:dur-0.5}];
      const dir=path.join(DATA,'scan'); await fsp.rm(dir,{recursive:true,force:true}).catch(()=>{}); await fsp.mkdir(dir,{recursive:true});
      let times=[]; for(const sg of segs){ for(let t=sg.start+0.4;t<sg.end-0.2;t+=step) times.push(+t.toFixed(2)); }
      if(times.length>maxFrames){ const k=Math.ceil(times.length/maxFrames); times=times.filter((_,i)=>i%k===0); }
      const frames=[];
      for(let i=0;i<times.length;i++){
        if(job.cancelRequested) throw Error('Análisis cancelado.');
        const t=times[i], fp=path.join(dir,`f${i}.jpg`);
        await run(bin,['-y','-ss',String(t),'-i',project.videoPath,'-frames:v','1','-vf','scale=512:-2','-q:v','4',fp]).catch(()=>{});
        if(fs.existsSync(fp)) frames.push({t,i,fp});
        job.message=`Sacando fotogramas… (${i+1}/${times.length})`; job.percent=Math.round((i+1)/times.length*35);
      }
      const flagged=[];
      if(engine==='cloud'){
        // NUBE (Haiku): varios fotogramas por llamada, prompt estricto. Mucho más preciso (distingue abrazo vs beso).
        job.message='Revisando con la nube (Haiku)…';
        const BATCH=5;
        for(let n=0;n<frames.length;n+=BATCH){
          if(job.cancelRequested) throw Error('Análisis cancelado.');
          const batch=frames.slice(n,n+BATCH);
          let verdicts=[]; try{ verdicts=await cloudClassifyBatch(batch.map(f=>f.fp)); }catch(e){ if(n===0) throw e; }
          batch.forEach((f,bi)=>{ const r=verdicts[bi]; if(r){ const which=cats.filter(c=>r[c]); if(which.length){ flagged.push({t:f.t,i:f.i,cats:which,riesgo:r.riesgo||'medio',nota:''}); } } });
          job.message=`Revisando con la nube (Haiku)… (${Math.min(n+BATCH,frames.length)}/${frames.length})`; job.percent=35+Math.round(Math.min(n+BATCH,frames.length)/Math.max(1,frames.length)*63);
        }
      } else {
        // LOCAL: moondream (chico) filtra primero; solo lo sospechoso lo confirma gemma3.
        const fast = opts.mode==='rapido' && await ollamaHasModel('moondream');
        job.message = fast ? 'Filtrando rápido (moondream)…' : 'Revisando con IA (gemma3)…';
        for(let n=0;n<frames.length;n++){
          if(job.cancelRequested) throw Error('Análisis cancelado.');
          const f=frames[n];
          if(fast){ const sus=await moondreamQuick(f.fp); if(!sus){ job.message=`Filtrando rápido (moondream)… (${n+1}/${frames.length})`; job.percent=35+Math.round((n+1)/Math.max(1,frames.length)*63); continue; } }
          const r=await classifyFrame(f.fp);
          if(r){ const hit=cats.some(c=>r[c]) && (RISK_ORDER[r.riesgo]||0)>=minRisk; if(hit){ const which=cats.filter(c=>r[c]); flagged.push({t:f.t,i:f.i,cats:which,riesgo:r.riesgo,nota:r.nota}); } }
          job.message=fast?`Confirmando con gemma3… (${n+1}/${frames.length})`:`Revisando con IA… (${n+1}/${frames.length})`; job.percent=35+Math.round((n+1)/Math.max(1,frames.length)*63);
        }
      }
      // Agrupa fotogramas marcados cercanos en TRAMOS
      const ranges=[]; const gap=step*2.2;
      for(const fl of flagged){
        const last=ranges[ranges.length-1];
        if(last && fl.t-last.endRaw<=gap){ last.endRaw=fl.t; last.end=Math.min(dur,fl.t+step); last.hits++; if((RISK_ORDER[fl.riesgo]||0)>(RISK_ORDER[last.riesgo]||0)){last.riesgo=fl.riesgo;last.nota=fl.nota;last.thumb=fl.i;} for(const c of fl.cats) if(!last.cats.includes(c)) last.cats.push(c); }
        else ranges.push({start:Math.max(0,fl.t-1),end:Math.min(dur,fl.t+step),endRaw:fl.t,cats:[...fl.cats],riesgo:fl.riesgo,nota:fl.nota,thumb:fl.i,hits:1});
      }
      ranges.forEach(r=>{delete r.endRaw;r.start=+r.start.toFixed(2);r.end=+r.end.toFixed(2);});
      sensitiveScan={ranges,scannedAt:Date.now(),frames:frames.length,cats,sensitivity:sens,engine};
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
    if (req.method==='GET' && url.pathname==='/api/requirements') return respond(res,200,await requirementsReport());
    // Endpoint LIGERO: solo el progreso del trabajo (para poder sondear cada segundo sin mandar la transcripción enorme).
    if (req.method==='GET' && url.pathname==='/api/job') return respond(res,200,{job, bestofReady: bestofScan?bestofScan.scannedAt:0, version:APP_VERSION, stripBuilding: !!(filmstrip&&filmstrip.building), stripCount: filmstrip?filmstrip.count:0, stripInterval: filmstrip?filmstrip.interval||0:0});
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
    if (req.method==='POST' && url.pathname==='/api/silences') {
      const body=await jsonBody(req); detectSilences(body||{}); return respond(res,202,{started:true});
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
      buildFilmstripBG(project.videoPath); // segundo plano: no bloquea, aparecen conforme se generan
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
    if (req.method==='POST' && url.pathname==='/api/transcribe') { const body=await jsonBody(req).catch(()=>({})); await transcribe(body||{}); return respond(res,202,state()); }
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
    // NO se bloquea aunque haya un proceso corriendo (transcribir, etc.): solo escribe un JSON chico → puedes cortar MIENTRAS transcribe.
    if (req.method==='POST' && url.pathname==='/api/cuts/manual/set') {
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
    if (req.method==='POST' && url.pathname==='/api/shorts/suggest') { const body=await jsonBody(req).catch(()=>({})); return respond(res,202,await proposeShorts(body||{})); }
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
    if (req.method==='POST' && url.pathname==='/api/suggest-zooms') return respond(res,200,await suggestZooms());
    if (req.method==='POST' && url.pathname==='/api/topics') return respond(res,200,await detectTopics());
    if (req.method==='POST' && url.pathname==='/api/bestof/analyze') { const body=await jsonBody(req); detectBestMoments(body||{}); return respond(res,202,{started:true}); }
    if (req.method==='GET' && url.pathname==='/api/bestof') return respond(res,200,bestofScan||{candidates:[]});
    if (req.method==='POST' && url.pathname==='/api/bestof/config') { const b=await jsonBody(req)||{};
      if(typeof b.key==='string'&&b.key.trim()) cloud.key=b.key.trim();
      if(b.clearKey) cloud.key='';
      if(b.engine==='local'||b.engine==='cloud') cloud.engine=b.engine;
      if(typeof b.model==='string'&&/^claude-/.test(b.model)) cloud.model=b.model;
      writeJson(path.join(DATA,'cloud.json'),cloud);
      return respond(res,200,{ok:true,engine:cloud.engine,model:cloud.model,keySet:!!cloud.key}); }
    if (req.method==='POST' && url.pathname==='/api/export') { const body=await jsonBody(req); const enh=(body.enhance!=null&&typeof body.enhance==='object')?body.enhance:String(body.enhance||'std'); const result=await exportVideo(Array.isArray(body.selectedIds)?body.selectedIds:[],Array.isArray(body.selectedPauseIds)?body.selectedPauseIds:[],body.mode==='cut'?'cut':'mute',String(body.quality||'original'),enh,String(body.intro||'none'),String(body.outro||'none'),String(body.clipIn||'none'),String(body.clipOut||'none'),Number(body.clipDur)||0.8,Array.isArray(body.segments)?body.segments.slice(0,2000):null,!!body.smooth,!!body.censor,!!body.gpu); return respond(res,202,result); }
    if (req.method==='GET' && staticFiles[url.pathname]) { const p=path.join(ROOT,staticFiles[url.pathname]); const b=await fsp.readFile(p); res.writeHead(200,{'content-type':contentTypes[path.extname(p)],'content-length':b.length,'cache-control':'no-store'}); return res.end(b); }
    return error(res,'No encontrado.',404);
  } catch(e) { return error(res,e); }
});
server.listen(PORT,'127.0.0.1',()=>console.log(`Editor IRL: http://127.0.0.1:${PORT}`));
