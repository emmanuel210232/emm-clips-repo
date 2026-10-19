'use strict';

const CRITERIA=['hook','story','payoff','reaction','clarity','logistics'];

function parseAssessment(response) {
  const value=JSON.parse(response||'{}');
  const assessment={};
  for(const key of CRITERIA) {
    const score=Number(value[key]);
    if(!Number.isInteger(score)||score<0||score>3) throw Error(`Evaluación inválida: ${key}`);
    assessment[key]=score;
  }
  return assessment;
}

function coerceAssessment(value) {
  const a={};
  for(const key of CRITERIA){ let n=Math.round(Number(value&&value[key])); if(!Number.isFinite(n)) n=1; a[key]=Math.max(0,Math.min(3,n)); }
  return a;
}

function summarizeAssessment(a) {
  const points=2*(a.hook+a.story+a.payoff+a.reaction)+a.clarity-2*a.logistics;
  const score=Math.max(0,Math.min(100,Math.round(points/27*100)));
  const notes=[];
  if(a.reaction>=2) notes.push('reacción marcada');
  if(a.story>=2) notes.push('historia con desarrollo');
  if(a.payoff>=2) notes.push('remate claro');
  if(a.hook>=2) notes.push('inicio atractivo');
  if(a.logistics>=2) notes.push('mucha logística');
  if(a.clarity<=1) notes.push('requiere contexto');
  if(a.payoff===0) notes.push('sin remate claro');
  return {score,reason:notes.slice(0,4).join(' · ')||'escena para revisar'};
}

function cleanHook(s) {
  return String(s||'').replace(/[{}\\"\n\r]/g,' ').replace(/\s+/g,' ').trim().toUpperCase().slice(0,40);
}

async function assessCandidate(model, transcript) {
  const prompt=`Eres editor de Shorts virales IRL para público mexicano (estilo del streamer "Maestro Shifu"). Lee la transcripción de un posible clip de 30-60 segundos. Evalúa SOLO lo que demuestra el texto, sin suponer imágenes ni inventar sucesos. Cada factor 0, 1, 2 o 3: hook (los primeros segundos enganchan), story (situación que evoluciona), payoff (remate o resolución al final), reaction (humor/sorpresa/drama/pleito), clarity (se entiende por sí solo), logistics (conversación rutinaria aburrida: mapas, precios, reservas, fallas técnicas). Además escribe "gancho": un título muy corto de 3 a 6 palabras EN MAYÚSCULAS, llamativo para la miniatura, basado SOLO en lo que ocurre en el texto (nada inventado). Devuelve SOLO JSON: {"hook":0,"story":0,"payoff":0,"reaction":0,"clarity":0,"logistics":0,"gancho":"..."}. Texto: ${transcript.slice(0,2000)}`;
  const response=await fetch('http://127.0.0.1:11434/api/generate',{
    method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({model,prompt,stream:false,format:'json',options:{temperature:0.2,num_ctx:4096,num_predict:400}}),
    signal:AbortSignal.timeout(45000)
  });
  if(!response.ok) throw Error(`Ollama respondió ${response.status}`);
  const result=await response.json();
  let value={};
  try{ value=JSON.parse(result.response||'{}'); }catch{}
  let criteria;
  try{ criteria=parseAssessment(result.response); }catch{ criteria=coerceAssessment(value); }
  return {criteria, gancho:cleanHook(value.gancho)};
}

async function writePackage(model, transcript) {
  const prompt=`Eres community manager de un canal de YouTube que resube clips del streamer mexicano "Maestro Shifu" (Adriano Zendejas). Con esta transcripción de un clip corto, escribe metadatos para YouTube en español de México, llamativos pero SIN inventar hechos que no estén en el texto. Devuelve SOLO JSON: {"titulo":"...","descripcion":"...","hashtags":["...","..."]}. Reglas: "titulo" máximo 70 caracteres, con gancho al inicio y 1 emoji; "descripcion" 2 o 3 líneas cortas; "hashtags" de 5 a 8, en minúsculas sin el símbolo #, relevantes a lo que pasa. Texto: ${transcript.slice(0,2000)}`;
  const response=await fetch('http://127.0.0.1:11434/api/generate',{
    method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({model,prompt,stream:false,format:'json',options:{temperature:0.4,num_ctx:4096,num_predict:400}}),
    signal:AbortSignal.timeout(45000)
  });
  if(!response.ok) throw Error(`Ollama respondió ${response.status}`);
  const result=await response.json();
  let v={};
  try{ v=JSON.parse(result.response||'{}'); }catch{}
  const clean=s=>String(s||'').replace(/[{}"\\]/g,'').replace(/\s+/g,' ').trim();
  const titulo=clean(v.titulo).slice(0,90);
  const descripcion=String(v.descripcion||'').replace(/[{}"\\]/g,'').replace(/\n{3,}/g,'\n\n').trim().slice(0,600);
  const base=['maestroshifu','adrianozendejas','shifu','shorts','kick','viral'];
  const ai=Array.isArray(v.hashtags)?v.hashtags.map(h=>String(h).replace(/[^a-záéíóúñ0-9]/gi,'').toLowerCase()).filter(Boolean):[];
  const hashtags=[...new Set([...ai,...base])].filter(Boolean).slice(0,12);
  if(!titulo&&!descripcion) throw Error('La IA no devolvió metadatos válidos.');
  return {titulo:titulo||'MAESTRO SHIFU 😱', descripcion:descripcion||'Lo mejor del directo del Maestro Shifu.', hashtags};
}

module.exports={parseAssessment,coerceAssessment,summarizeAssessment,assessCandidate,cleanHook,writePackage};
