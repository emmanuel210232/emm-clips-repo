'use strict';
// Prueba de punta a punta del AVANCE ("PRÓXIMAMENTE...") con ffmpeg real. NO la usa la app.
// - Copia la app a una carpeta temporal (su propio data/ y exports/: nunca toca el proyecto del usuario).
// - Crea un video sintético tipo Kick (MPEG-TS 1080p60 H.264 + AAC) con un destello blanco y un bip en cada segundo.
// - Arranca el servidor en otro puerto (EDITOR_IRL_PORT) y exporta con avance en 3 casos:
//     A) Cortar con clips editados (1 sola pasada) + avance desde el Resumen del directo (bestof.json)
//     B) Silenciar (calidad "lite" para que sea rápido) + avance por energía del audio (sin bestof)
//     C) Cortar con >120 clips (export por tandas) + avance como "parte 0" unida sin reencodear
// - Mide: duración esperada, sincronía A/V (±1 cuadro) en el avance y en el video, y que la grosería quede callada.
// Uso:  node tools-dev/teaser_e2e.js [segundos=240] [casos=ABC]
// Variables: FFMPEG_BIN / FFPROBE_BIN (si no, los de tools/ o del PATH); E2E_DIR (carpeta de trabajo).
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const AV = require('./avsync');

const SECONDS = Number(process.argv[2]) || 240;
const CASES = String(process.argv[3] || 'ABC').toUpperCase();
const PORT = 4188;
const ROOT = path.join(__dirname, '..');
const WORK = process.env.E2E_DIR || path.join(os.tmpdir(), 'emm_teaser_e2e');
const FFMPEG = process.env.FFMPEG_BIN || AV.FFMPEG, FFPROBE = process.env.FFPROBE_BIN || AV.FFPROBE;
const SWEAR = { start: 60.9, end: 61.1 }; // tapa el bip de t=61 (con el margen de 0.15 s)

function copyApp(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
  for (const f of ['server.js', 'channel_style.json', 'package.json', 'index.html', 'app.js', 'style.css', 'vision.js', 'investigar.js']) if (fs.existsSync(path.join(ROOT, f))) fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
  for (const f of fs.readdirSync(path.join(ROOT, 'lib'))) fs.copyFileSync(path.join(ROOT, 'lib', f), path.join(dir, 'lib', f));
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
}
const wj = (dir, name, v) => fs.writeFileSync(path.join(dir, 'data', name), JSON.stringify(v, null, 2));

function transcript(seconds) {
  const out = [];
  for (let t = 0; t < seconds - 5; t += 5) out.push({ start: t + 0.2, end: t + 4.6, text: 'pues aquí andamos con el chat' });
  out.push({ start: SWEAR.start, end: SWEAR.end, text: 'chingada' });
  return out.sort((a, b) => a.start - b.start);
}

async function api(url, body) {
  const r = await fetch(`http://127.0.0.1:${PORT}${url}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json(); if (!r.ok) throw Error(j.error || r.status); return j;
}
async function waitJob() {
  let last = '';
  for (;;) {
    await new Promise(r => setTimeout(r, 1500));
    const { job } = await api('/api/job');
    const msg = `${job.message} ${job.percent || 0}%`; if (msg !== last) { last = msg; process.stdout.write(`   · ${msg.slice(0, 110)}\n`); }
    if (job.status === 'done') return job;
    if (job.status === 'error' || job.status === 'cancelled') throw Error(job.message);
  }
}
async function withServer(dir, fn) {
  const child = spawn(process.execPath, [path.join(dir, 'server.js')], { cwd: dir, env: { ...process.env, EDITOR_IRL_PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; child.stdout.on('data', b => { log += b; }); child.stderr.on('data', b => { log += b; });
  try {
    for (let i = 0; i < 40; i++) { try { await api('/api/job'); break; } catch { await new Promise(r => setTimeout(r, 250)); } }
    return await fn();
  } catch (e) { e.message += '\n--- servidor ---\n' + log.slice(-3000); throw e; } finally { child.kill(); }
}

// SINCRONÍA: la fuente pone el destello y el bip en el MISMO instante, así que la sincronía real es 0 ms. Medida sobre la
// fuente MPEG-TS sale ~21 ms porque su video empieza 21 ms después que su audio (start_time distinto por stream) y la
// medición toma cada stream desde su propio inicio: es un artefacto de la medición, no un desfase. Por eso el criterio
// es |bip − destello| ≤ 1 cuadro CONTRA 0 (no contra los 21 ms de la fuente); SRC_MS solo se imprime como referencia.
let SRC_MS = 0;
// CUADRO EXACTO: cada destello de la salida debe caer donde lo predicen los tiempos pedidos (cada segundo entero del
// original que entra en un pedazo). Con el método viejo (-ss + trim relativo) caían ~1.4 s (≈85 cuadros) corridos.
const FRAME_TOL_MS = 30; // < 2 cuadros a 60 fps (redondeo de cuadro + 21 ms de inicio del video en la fuente)
function expectedFlashes(pieces) { // pieces: [{out, start, end}] en segundos
  const out = [];
  for (const p of pieces) for (let sec = Math.ceil(p.start - 1e-6); sec < p.end - 1e-6; sec++) out.push(p.out + (sec - p.start));
  return out;
}
function frameCheck(flashTimes, expected, from = 0, to = Infinity) {
  const fl = flashTimes.filter(t => t >= from && t < to);
  const errs = fl.map(t => expected.reduce((m, e) => Math.min(m, Math.abs(e - t)), Infinity) * 1000);
  return { destellos: fl.length, maxErrorMs: errs.length ? +Math.max(...errs).toFixed(1) : null };
}
function teaserPieces(frags) {
  const d = frags.length > 1 ? Math.min(0.5, Math.min(...frags.map(f => f.end - f.start)) / 3) : 0; let t = 0;
  return frags.map(f => { const p = { out: t, start: f.start, end: f.end }; t += (f.end - f.start) - d; return p; });
}
function mainPieces(segs, offset) { let t = offset; return segs.map(s => { const p = { out: t, start: s.start, end: s.end }; t += s.end - s.start; return p; }); }
async function check(name, job, expected, { muteMain = true } = {}) {
  const pr = await AV.probe(job.output);
  const sync = await AV.measureSync(job.output);
  const tDur = expected.teaser;
  const inT = sync.pairs.filter(p => p.t < tDur - 0.5), inM = sync.pairs.filter(p => p.t > tDur + 0.5);
  const maxAbs = l => l.length ? Math.max(...l.map(p => Math.abs(p.ms))) : null;
  const maxDev = l => l.length ? +Math.max(...l.map(p => Math.abs(p.ms - SRC_MS))).toFixed(1) : null; // solo referencia
  const errs = await AV.decodeErrors(job.output);
  const res = {
    caso: name, duracion: +pr.duration.toFixed(3), esperada: +(expected.teaser + expected.main).toFixed(3),
    fuenteMs: SRC_MS,
    avance: { fragmentos: (job.teaser || []).length, duracion: tDur, pares: inT.length, maxMs: maxAbs(inT), maxDesvioMs: maxDev(inT) },
    video: { pares: inM.length, maxMs: maxAbs(inM), maxDesvioMs: maxDev(inM) }, erroresDecodificacion: errs,
  };
  const frame = 1000 / 60 + 0.5;
  // Cuadro exacto en el avance y en el video principal.
  const tP = teaserPieces(job.teaser || []);
  res.avance.cuadro = frameCheck(sync.flashTimes, expectedFlashes(tP), 0, tDur - 0.05);
  if (expected.mainPieces) res.video.cuadro = frameCheck(sync.flashTimes, expectedFlashes(expected.mainPieces), tDur + 0.05);
  const frameOk = c => !c || (c.destellos >= 3 && c.maxErrorMs <= FRAME_TOL_MS);
  res.ok = Math.abs(res.duracion - res.esperada) < 0.12 && inT.length >= 3 && inM.length >= 10 && maxAbs(inT) <= frame && maxAbs(inM) <= frame && errs === 0
    && frameOk(res.avance.cuadro) && frameOk(res.video.cuadro);
  // La grosería: en el video, el destello que cae en la grosería NO debe tener bip (silenciado, sin bip encima).
  if (muteMain && expected.swearAt != null) {
    const near = sync.beepTimes.filter(b => Math.abs(b - expected.swearAt) < 0.1);
    res.groseriaCallada = near.length === 0; res.ok = res.ok && res.groseriaCallada;
  }
  // En el avance: si un fragmento contiene la grosería, ahí tampoco debe haber bip.
  const tf = (job.teaser || []); let tt = 0; const d = tf.length > 1 ? Math.min(0.5, Math.min(...tf.map(f => f.end - f.start)) / 3) : 0;
  for (const f of tf) { if (SWEAR.start >= f.start && SWEAR.end <= f.end) { const at = tt + (61 - f.start); res.avance.groseriaCallada = !sync.beepTimes.some(b => Math.abs(b - at) < 0.1); res.ok = res.ok && res.avance.groseriaCallada; } tt += (f.end - f.start) - d; }
  console.log(JSON.stringify(res));
  return res;
}

(async () => {
  fs.mkdirSync(WORK, { recursive: true });
  const src = path.join(WORK, `fuente_${SECONDS}s.ts`);
  if (!fs.existsSync(src)) { console.log(`Creando fuente sintética de ${SECONDS} s (MPEG-TS 1080p60)…`); await AV.makeSyncSource(src, { seconds: SECONDS }); }
  const T = require('../lib/teaser');
  { const s = await AV.measureSync(src); SRC_MS = s.meanMs; console.log(`Sincronía de la fuente: ${s.meanMs} ms (máx ${s.maxAbsMs})`); }
  const results = [];
  const base = (dir, { bestof }) => {
    copyApp(dir);
    wj(dir, 'config.json', { ffmpeg: FFMPEG, ffprobe: FFPROBE });
    wj(dir, 'project.json', { videoPath: src, openedAt: new Date().toISOString() });
    wj(dir, 'transcript.json', transcript(SECONDS));
    fs.writeFileSync(path.join(dir, 'dictionary.json'), JSON.stringify([{ term: 'chingada', enabled: true }])); // va en la raíz de la app
    if (bestof) wj(dir, 'bestof.json', { videoPath: src, scannedAt: Date.now(), candidates: [
      { start: 10, end: 45, score: 9, gancho: 'uno' }, { start: 55, end: 90, score: 8, gancho: 'grosería' },
      { start: 125, end: 160, score: 7, gancho: 'tres' }, { start: 190, end: 230, score: 6, gancho: 'cuatro' }] });
  };
  if (CASES.includes('A')) {
    const dir = path.join(WORK, 'appA'); base(dir, { bestof: true });
    const segs = [{ start: 0, end: 40 }, { start: 50, end: 100 }, { start: 110, end: SECONDS }];
    console.log('A) Cortar con clips editados + avance desde el Resumen del directo');
    const job = await withServer(dir, async () => { await api('/api/export', { mode: 'cut', segments: segs, selectedIds: [], censor: true, gpu: true, quality: 'original', enhance: { normalize: true }, teaser: { on: true } }); return waitJob(); });
    const main = segs.reduce((a, s) => a + s.end - s.start, 0);
    // la grosería (61) cae en el 2º clip: en la salida está en 40 + (61-50) = 51 s después del avance
    const tdA = T.teaserDuration(job.teaser);
    results.push(await check('A', job, { teaser: tdA, main, swearAt: tdA + 51, mainPieces: mainPieces(segs, tdA) }));
  }
  if (CASES.includes('B')) {
    const dir = path.join(WORK, 'appB'); base(dir, { bestof: false });
    console.log('B) Silenciar + avance por energía del audio');
    const job = await withServer(dir, async () => {
      const m = await api('/api/state'); const ids = (m.matches || []).map(x => x.id);
      await api('/api/export', { mode: 'mute', selectedIds: ids, gpu: true, quality: 'lite', enhance: 'none', teaser: { on: true } }); return waitJob(); });
    const td = T.teaserDuration(job.teaser);
    const srcDur = (await AV.probe(src)).duration;
    results.push(await check('B', job, { teaser: td, main: srcDur, swearAt: td + 61, mainPieces: [{ out: td, start: 0, end: srcDur }] }));
  }
  if (CASES.includes('C')) {
    const dir = path.join(WORK, 'appC'); base(dir, { bestof: true });
    const segs = []; for (let t = 0.5; t + 1.5 <= SECONDS; t += 1.8) segs.push({ start: +t.toFixed(3), end: +(t + 1.5).toFixed(3) });
    console.log(`C) Cortar con ${segs.length} clips (por tandas) + avance como parte 0`);
    const job = await withServer(dir, async () => { await api('/api/export', { mode: 'cut', segments: segs, selectedIds: [], censor: true, gpu: true, quality: 'original', enhance: 'none', teaser: { on: true } }); return waitJob(); });
    const tdC = T.teaserDuration(job.teaser);
    results.push(await check('C', job, { teaser: tdC, main: segs.reduce((a, s) => a + s.end - s.start, 0), mainPieces: mainPieces(segs, tdC) }, { muteMain: false }));
  }
  const ok = results.every(r => r.ok);
  console.log(ok ? '✅ Todo bien' : '❌ Hay fallas'); process.exit(ok ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
