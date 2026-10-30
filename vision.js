'use strict';
// ===== VISIÓN PARA SHORTS (MediaPipe de Google, corre en el navegador con la GPU) =====
// Antes de renderizar un Short en modo Auto: el servidor saca 5 cuadros por segundo del ORIGINAL, aquí se detectan
// PERSONAS (pose: ubica la cabeza aunque esté de perfil o lejos) y CARAS (qué tan abierta está la boca) y se manda
// al servidor; ahí lib/director.js decide quién habla y arma las tomas. Si algo falla (p. ej. sin internet la
// primera vez), el Short se crea igual con el encuadre de respaldo.
const MP_VER = '0.10.14';
const MP_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VER}`;
const MP_MODELS = {
  pose: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task',
  face: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
};
let _vision = null;
function loadVision() {
  if (_vision) return _vision;
  _vision = (async () => {
    const V = await import(`${MP_BASE}/vision_bundle.mjs`);
    const files = await V.FilesetResolver.forVisionTasks(`${MP_BASE}/wasm`);
    const make = async delegate => ({
      pose: await V.PoseLandmarker.createFromOptions(files, { baseOptions: { modelAssetPath: MP_MODELS.pose, delegate }, runningMode: 'IMAGE', numPoses: 4, minPoseDetectionConfidence: 0.4, minPosePresenceConfidence: 0.4 }),
      face: await V.FaceLandmarker.createFromOptions(files, { baseOptions: { modelAssetPath: MP_MODELS.face, delegate }, runningMode: 'IMAGE', numFaces: 4, minFaceDetectionConfidence: 0.3, minFacePresenceConfidence: 0.3 }),
    });
    try { return await make('GPU'); } catch { return await make('CPU'); } // sin GPU disponible: más lento pero funciona
  })();
  _vision.catch(() => { _vision = null; }); // si falló (sin internet), se reintenta la próxima vez
  return _vision;
}
const HEAD = [0, 2, 5, 7, 8]; // nariz, ojos, orejas
function personOf(lm) {
  const vis = HEAD.map(i => lm[i]).filter(p => (p.visibility ?? 1) > 0.3);
  const src = vis.length ? vis : HEAD.map(i => lm[i]);
  const hx = src.reduce((a, p) => a + p.x, 0) / src.length, hy = src.reduce((a, p) => a + p.y, 0) / src.length;
  const sw = Math.abs(lm[11].x - lm[12].x); // ancho de hombros ≈ qué tan cerca está de la cámara
  return { hx: +hx.toFixed(4), hy: +hy.toFixed(4), sw: +sw.toFixed(4) };
}
function faceOf(lm) {
  let x0 = 1, x1 = 0, y0 = 1, y1 = 0;
  for (const p of lm) { if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x; if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y; }
  const h = Math.max(1e-3, y1 - y0);
  return { cx: +((x0 + x1) / 2).toFixed(4), cy: +((y0 + y1) / 2).toFixed(4), w: +(x1 - x0).toFixed(4), mouth: +(Math.abs(lm[13].y - lm[14].y) / h).toFixed(4) };
}
async function frameBitmap(id, i) {
  const r = await fetch(`/api/shorts/vision/frame?id=${encodeURIComponent(id)}&i=${i}`);
  if (!r.ok) throw Error('No pude leer un cuadro del clip.');
  return createImageBitmap(await r.blob());
}
// Analiza un Short completo. onProgress(texto). Devuelve el resumen del servidor ({people, shots, fallback}).
async function analyzeShortVision(clip, onProgress = () => {}) {
  onProgress('Sacando cuadros del clip…');
  const info = await api('/api/shorts/vision/frames', { id: clip.id });
  onProgress('Cargando el detector de personas (la primera vez tarda un poco)…');
  const { pose, face } = await loadVision();
  const frames = [];
  let next = frameBitmap(clip.id, 1);
  for (let i = 1; i <= info.count; i++) {
    const bmp = await next;
    if (i < info.count) next = frameBitmap(clip.id, i + 1); // el siguiente se descarga mientras se analiza este
    const p = pose.detect(bmp), f = face.detect(bmp);
    const people = p.landmarks.map(personOf), faces = f.faceLandmarks.map(faceOf);
    // SEGUNDO VISTAZO: caras chicas (lejos, de noche) no salen en la imagen completa. Para cada persona sin cara,
    // se recorta y agranda la zona de su cabeza y se busca ahí (la cara llena el detector).
    for (const per of people) {
      if (faces.some(fc => Math.abs(fc.cx - per.hx) < 0.08 && Math.abs(fc.cy - per.hy) < 0.15)) continue;
      const W = bmp.width, H = bmp.height;
      const side = Math.round(Math.min(H, Math.max(per.sw * 2.4 * W, 0.16 * H)));
      const sx = Math.round(Math.max(0, Math.min(W - side, per.hx * W - side / 2))), sy = Math.round(Math.max(0, Math.min(H - side, per.hy * H - side * 0.45)));
      try {
        const crop = await createImageBitmap(bmp, sx, sy, side, side, { resizeWidth: 320, resizeHeight: 320, resizeQuality: 'high' });
        const fr = face.detect(crop); crop.close && crop.close();
        for (const lm of fr.faceLandmarks) {
          const mapped = lm.map(q => ({ x: (sx + q.x * side) / W, y: (sy + q.y * side) / H }));
          const fc = faceOf(mapped);
          if (!faces.some(o => Math.abs(o.cx - fc.cx) < 0.04 && Math.abs(o.cy - fc.cy) < 0.06)) faces.push(fc);
        }
      } catch {}
    }
    bmp.close && bmp.close();
    frames.push({ t: +((i - 1) / info.fps).toFixed(2), people, faces });
    if (i % 10 === 0 || i === info.count) onProgress(`Viendo quién habla en el Short ${clip.rank}… ${Math.round(i / info.count * 100)}%`);
  }
  return api('/api/shorts/vision', { id: clip.id, frames });
}
// ===== VISTA PREVIA DE TOMAS (editar a quién se ve en cada tramo antes de renderizar) =====
const shotEditorsOpen = new Set();
const shotPlans = new Map();
const PERSON_COLORS = ['#3aa85a', '#3b82f6', '#e0a020', '#d9468a', '#8b5cf6', '#14b8a6'];
const fmtS = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
function usesAutoFraming(clip) { return (clip.framingMode || 'auto') === 'auto' && (!clip.format || clip.format === 'vertical'); }
function attachShotEditor(clip, row, buttons) {
  if (!usesAutoFraming(clip)) return;
  const btn = document.createElement('button');
  btn.type = 'button'; btn.className = 'secondary compact'; btn.textContent = shotEditorsOpen.has(clip.id) ? '🎥 Ocultar tomas' : '🎥 Tomas';
  btn.title = 'Ver y cambiar a quién se ve en cada parte del Short (antes de crearlo)';
  const panel = document.createElement('div'); panel.className = 'shotEditor'; panel.hidden = !shotEditorsOpen.has(clip.id);
  btn.onclick = async () => {
    if (shotEditorsOpen.has(clip.id)) { shotEditorsOpen.delete(clip.id); panel.hidden = true; btn.textContent = '🎥 Tomas'; return; }
    shotEditorsOpen.add(clip.id); panel.hidden = false; btn.textContent = '🎥 Ocultar tomas';
    await loadShotPlan(clip, panel);
  };
  buttons.prepend(btn); row.append(panel);
  if (shotEditorsOpen.has(clip.id)) { if (shotPlans.has(clip.id)) drawShotEditor(clip, panel, shotPlans.get(clip.id)); else loadShotPlan(clip, panel); }
}
async function loadShotPlan(clip, panel) {
  panel.innerHTML = '<p class="muted">Cargando tomas…</p>';
  try {
    let plan = await (await fetch('/api/shorts/shots?id=' + encodeURIComponent(clip.id))).json();
    if (plan.error) throw Error(plan.error);
    if (!plan.hasVision) {
      panel.innerHTML = '';
      const go = document.createElement('button'); go.type = 'button'; go.className = 'primary compact'; go.textContent = '🎥 Analizar quién sale y quién habla';
      const p = document.createElement('p'); p.className = 'muted'; p.textContent = 'La IA revisa el clip (unos segundos) y te muestra las tomas para que las ajustes antes de crear el Short.';
      go.onclick = async () => { go.disabled = true; try { await analyzeShortVision(clip, m => { go.textContent = '🎥 ' + m; }); await loadShotPlan(clip, panel); } catch (e) { notice('No se pudo analizar: ' + e.message, true); go.disabled = false; go.textContent = '🎥 Reintentar'; } };
      panel.append(p, go); return;
    }
    shotPlans.set(clip.id, plan); drawShotEditor(clip, panel, plan);
  } catch (e) { panel.innerHTML = ''; const p = document.createElement('p'); p.className = 'muted'; p.textContent = 'No se pudieron cargar las tomas: ' + e.message; panel.append(p); }
}
function drawShotEditor(clip, panel, plan) {
  panel.innerHTML = '';
  if (plan.fallback || !plan.shots.length) { const p = document.createElement('p'); p.className = 'muted'; p.textContent = 'Casi no se ven personas en este clip: se usará el encuadre de respaldo.'; panel.append(p); return; }
  const num = new Map(plan.people.map(p => [p.id, p.n]));
  const color = id => PERSON_COLORS[((num.get(id) || 1) - 1) % PERSON_COLORS.length];
  // Personas
  const ppl = document.createElement('div'); ppl.className = 'shotPeople';
  for (const p of plan.people) {
    const chip = document.createElement('span'); chip.className = 'shotPerson'; chip.style.setProperty('--c', color(p.id));
    const img = document.createElement('img'); img.alt = ''; img.src = `/api/shorts/person-thumb?id=${encodeURIComponent(clip.id)}&p=${p.id}`;
    const lbl = document.createElement('b'); lbl.textContent = 'Persona ' + p.n;
    const sm = document.createElement('small'); sm.textContent = Math.round(p.seen * 100) + '% del clip';
    chip.append(img, lbl, sm); ppl.append(chip);
  }
  // Barra de tomas (ancho proporcional a la duración)
  const bar = document.createElement('div'); bar.className = 'shotBar';
  const menu = document.createElement('div'); menu.className = 'shotMenu'; menu.hidden = true;
  for (const s of plan.shots) {
    const seg = document.createElement('button'); seg.type = 'button'; seg.className = 'shotSeg' + (s.layout === 'split' ? ' split' : '');
    seg.style.flexGrow = Math.max(0.2, s.end - s.start);
    if (s.layout === 'split') { seg.style.setProperty('--c', color(s.ids[0])); seg.style.setProperty('--c2', color(s.ids[1])); seg.textContent = '◫'; }
    else if (s.layout === 'wide') { seg.style.setProperty('--c', '#6b7280'); seg.textContent = '▭'; }
    else { seg.style.setProperty('--c', color(s.id)); seg.textContent = 'P' + (num.get(s.id) || '?'); }
    const manual = (plan.overrides || []).some(o => o.start <= s.start + 0.05 && o.end >= s.end - 0.05);
    if (manual) seg.classList.add('manual');
    seg.title = `${fmtS(s.start)}–${fmtS(s.end)} · ${s.layout === 'split' ? 'Pantalla dividida (P' + s.ids.map(i => num.get(i)).join(' arriba, P') + ' abajo)' : s.layout === 'wide' ? 'Toma abierta (imagen completa)' : 'Persona ' + (num.get(s.id) || '?')}${manual ? ' · cambiado por ti' : ''}. Clic para cambiar.`;
    seg.onclick = () => openShotMenu(clip, panel, plan, s, seg, menu);
    bar.append(seg);
  }
  const ticks = document.createElement('div'); ticks.className = 'shotTicks';
  ticks.innerHTML = `<span>0:00</span><span>${fmtS(plan.dur / 2)}</span><span>${fmtS(plan.dur)}</span>`;
  const foot = document.createElement('div'); foot.className = 'shotFoot';
  const splits = plan.shots.filter(s => s.layout === 'split').length;
  const info = document.createElement('span'); info.className = 'muted';
  const wides = plan.shots.filter(s => s.layout === 'wide').length;
  info.textContent = `${plan.shots.length} toma(s)${splits ? ` · ${splits} con pantalla dividida` : ''}${wides ? ` · ${wides} abierta(s)` : ''}. Clic en una toma para cambiar a quién se ve.`;
  foot.append(info);
  if ((plan.overrides || []).length) {
    const reset = document.createElement('button'); reset.type = 'button'; reset.className = 'secondary compact'; reset.textContent = '↺ Volver a lo automático';
    reset.onclick = () => saveOverrides(clip, panel, []);
    foot.append(reset);
  }
  panel.append(ppl, bar, ticks, menu, foot);
}
function openShotMenu(clip, panel, plan, shot, seg, menu) {
  menu.innerHTML = '';
  const title = document.createElement('div'); title.className = 'shotMenuTitle'; title.textContent = `Toma ${fmtS(shot.start)}–${fmtS(shot.end)}: ¿qué se ve?`;
  menu.append(title);
  const opt = (label, ov) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'secondary compact'; b.textContent = label; b.onclick = () => { menu.hidden = true; const rest = (plan.overrides || []).filter(o => o.end <= shot.start + 0.05 || o.start >= shot.end - 0.05); saveOverrides(clip, panel, ov ? [...rest, { start: shot.start, end: shot.end, ...ov }] : rest); }; menu.append(b); };
  for (const p of plan.people) opt('Persona ' + p.n, { mode: 'person', id: p.id });
  if (plan.people.length >= 2) opt('◫ Pantalla dividida', { mode: 'split' });
  opt('▭ Toma abierta', { mode: 'wide' });
  opt('Automático', null);
  menu.hidden = false;
  menu.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}
async function saveOverrides(clip, panel, overrides) {
  try { const plan = await api('/api/shorts/shots', { id: clip.id, overrides }); shotPlans.set(clip.id, plan); drawShotEditor(clip, panel, plan); notice('🎥 Tomas actualizadas. Se aplican al crear el Short.'); }
  catch (e) { notice(e.message, true); }
}
// Si el Short usa encuadre Auto vertical, lo analiza antes de renderizar. Nunca bloquea el render: si falla, avisa.
async function visionBeforeRender(clip) {
  if (!usesAutoFraming(clip)) return;
  try {
    // Si ya se analizó (p. ej. desde la vista previa de tomas), no se repite: se respetan tus cambios.
    const plan = await (await fetch('/api/shorts/shots?id=' + encodeURIComponent(clip.id))).json();
    if (plan.hasVision) return;
  } catch {}
  try {
    const r = await analyzeShortVision(clip, msg => notice('🎥 ' + msg));
    if (r.fallback) notice(`🎥 Short ${clip.rank}: casi no se ven personas; se usará el encuadre de respaldo.`);
    else notice(`🎥 Short ${clip.rank}: ${r.people} persona(s), ${r.shots} toma(s). Creando el video…`);
  } catch (e) {
    notice(`🎥 No se pudo usar el detector de personas (${e.message}). El Short se crea con el encuadre de respaldo.`, true);
  }
}
