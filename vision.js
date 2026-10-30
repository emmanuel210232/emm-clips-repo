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
    bmp.close && bmp.close();
    frames.push({ t: +((i - 1) / info.fps).toFixed(2), people: p.landmarks.map(personOf), faces: f.faceLandmarks.map(faceOf) });
    if (i % 10 === 0 || i === info.count) onProgress(`Viendo quién habla en el Short ${clip.rank}… ${Math.round(i / info.count * 100)}%`);
  }
  return api('/api/shorts/vision', { id: clip.id, frames });
}
// Si el Short usa encuadre Auto vertical, lo analiza antes de renderizar. Nunca bloquea el render: si falla, avisa.
async function visionBeforeRender(clip) {
  if ((clip.framingMode || 'auto') !== 'auto' || (clip.format && clip.format !== 'vertical')) return;
  try {
    const r = await analyzeShortVision(clip, msg => notice('🎥 ' + msg));
    if (r.fallback) notice(`🎥 Short ${clip.rank}: casi no se ven personas; se usará el encuadre de respaldo.`);
    else notice(`🎥 Short ${clip.rank}: ${r.people} persona(s), ${r.shots} toma(s). Creando el video…`);
  } catch (e) {
    notice(`🎥 No se pudo usar el detector de personas (${e.message}). El Short se crea con el encuadre de respaldo.`, true);
  }
}
