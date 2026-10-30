'use strict';
// ===== DIRECTOR DE CÁMARA (estilo Opus) =====
// Recibe lo que MediaPipe vio en cada cuadro del Short (personas por su pose + caras con qué tan abierta está la boca)
// y la energía de la voz, y decide QUIÉN HABLA y cómo encuadrar el 9:16:
//  - Sigue a cada persona entre cuadros (aunque se voltee: la pose ubica la cabeza de perfil o lejos).
//  - "Habla" = su boca se MUEVE mientras hay voz. Sin cara visible, se queda con quien ya estaba.
//  - Encuadre por TOMAS: se queda quieto en quien habla y CORTA (no se desliza) cuando habla otro,
//    con histéresis para no brincar por un "ajá". Si dos caben juntos en el cuadro, toma a los dos.
//  - Dentro de una toma solo se mueve si la cabeza se sale de la zona central (como un camarógrafo).
// Coordenadas de entrada normalizadas 0..1 respecto al cuadro original.

const MATCH_DIST = 0.13;   // distancia máx. (normalizada) para decir "es la misma persona" entre cuadros
const LOST_AFTER = 1.2;    // s sin verla → la pista muere
const MIN_SHOT = 1.6;      // s mínimos de una toma antes de poder cortar
const SWITCH_HOLD = 0.6;   // s que otro debe "ganar" seguido para cortar a él
const DEAD_ZONE = 0.14;    // fracción del ancho del recorte que la cabeza puede moverse sin mover la cámara

function median(a) { const s = a.filter(Number.isFinite).sort((x, y) => x - y); return s.length ? s[s.length >> 1] : NaN; }

// Sujetos del cuadro. Las CARAS mandan (posición precisa + boca). La POSE solo agrega personas sin cara visible
// (de perfil, de espaldas, lejos); en video real la pose a veces "inventa" una persona extra con un brazo o
// duplica a alguien → se descarta toda pose cerca de una cara o de otra pose ya aceptada.
function subjectsOf(frame) {
  const subs = [];
  for (const f of frame.faces || []) {
    if (subs.some(s => Math.abs(s.x - f.cx) < 0.05 && Math.abs(s.y - f.cy) < 0.08)) continue; // cara duplicada
    const near = (frame.people || []).find(p => Math.abs(p.hx - f.cx) < 0.12);
    subs.push({ x: f.cx, y: f.cy, size: Math.max(0.02, f.w * 1.6, near?.sw || 0), mouth: f.mouth, face: true });
  }
  for (const p of (frame.people || []).slice().sort((a, b) => (b.sw || 0) - (a.sw || 0))) {
    if (subs.some(s => Math.abs(s.x - p.hx) < (s.face ? 0.15 : 0.1))) continue;
    if ((p.sw || 0) < 0.04) continue; // demasiado chica/dudosa para encuadrarla
    subs.push({ x: p.hx, y: p.hy, size: Math.max(0.02, p.sw), mouth: null, face: false });
  }
  return subs;
}

// Pistas: misma persona a lo largo del tiempo (emparejamiento voraz por cercanía).
function buildTracks(frames) {
  const tracks = []; let nextId = 1;
  for (const fr of frames) {
    const subs = subjectsOf(fr);
    const alive = tracks.filter(t => fr.t - t.lastT <= LOST_AFTER);
    const pairs = [];
    for (let i = 0; i < subs.length; i++) for (const t of alive) {
      const d = Math.hypot(subs[i].x - t.x, (subs[i].y - t.y) * 0.5);
      if (d < MATCH_DIST + 0.05 * Math.min(1, (fr.t - t.lastT) / LOST_AFTER)) pairs.push({ i, t, d });
    }
    pairs.sort((a, b) => a.d - b.d);
    const usedS = new Set(), usedT = new Set();
    for (const p of pairs) {
      if (usedS.has(p.i) || usedT.has(p.t)) continue;
      usedS.add(p.i); usedT.add(p.t);
      const s = subs[p.i];
      Object.assign(p.t, { x: s.x, y: s.y, lastT: fr.t });
      p.t.obs.push({ t: fr.t, x: s.x, y: s.y, size: s.size, mouth: s.mouth });
    }
    subs.forEach((s, i) => {
      if (usedS.has(i)) return;
      const ob = { t: fr.t, x: s.x, y: s.y, size: s.size, mouth: s.mouth };
      // ¿Reaparece alguien que se había perdido (agachó la cabeza, se volteó) en el mismo lugar? → es la misma persona.
      const back = tracks.filter(t => !usedT.has(t) && fr.t - t.lastT > LOST_AFTER && fr.t - t.lastT < 15 && Math.abs(t.x - s.x) < MATCH_DIST * 1.2)
        .sort((a, b) => Math.abs(a.x - s.x) - Math.abs(b.x - s.x))[0];
      if (back) { Object.assign(back, { x: s.x, y: s.y, lastT: fr.t }); back.obs.push(ob); usedT.add(back); return; }
      tracks.push({ id: nextId++, x: s.x, y: s.y, lastT: fr.t, obs: [ob] });
    });
  }
  // Pistas fantasma (1-2 detecciones sueltas) no cuentan.
  return tracks.filter(t => t.obs.length >= 3);
}

// Voz activa por instante (a partir de la energía del audio cada 0.1 s).
function voiceFn(energy) {
  if (!Array.isArray(energy) || !energy.length) return () => 1;
  const speech = energy.map(e => e.db).filter(d => d > -50);
  const base = median(speech); const thr = Number.isFinite(base) ? base - 7 : -45;
  const step = energy.length > 1 ? energy[1].t - energy[0].t : 0.1;
  return t => { const i = Math.max(0, Math.min(energy.length - 1, Math.round((t - energy[0].t) / step))); let m = -90; for (let k = i - 2; k <= i + 2; k++) if (energy[k]) m = Math.max(m, energy[k].db); return m >= thr ? 1 : 0; };
}

function at(track, t) { // observación de la pista en el instante t (o null)
  let best = null, bd = 0.15;
  for (const o of track.obs) { const d = Math.abs(o.t - t); if (d < bd) { bd = d; best = o; } }
  return best;
}

// Puntaje "está hablando": movimiento de la boca (cambio entre cuadros + apertura) × voz, suavizado ~0.8 s.
function speakingScores(tracks, times, voice) {
  const alpha = 0.35; const out = new Map();
  for (const tr of tracks) {
    let ema = 0, prevMouth = null; const arr = [];
    for (const t of times) {
      const o = at(tr, t); let ev = 0;
      if (o && o.mouth != null) { const motion = prevMouth == null ? 0 : Math.abs(o.mouth - prevMouth); ev = (motion * 4 + Math.max(0, o.mouth - 0.015)) * voice(t); prevMouth = o.mouth; }
      else if (!o) prevMouth = null;
      ema = ema * (1 - alpha) + ev * alpha; arr.push(ema);
    }
    out.set(tr.id, arr);
  }
  return out;
}

function direct({ frames, energy, dur, srcW, srcH }) {
  frames = (frames || []).filter(f => Number.isFinite(f.t)).sort((a, b) => a.t - b.t);
  if (frames.length < 5 || !(srcW > 0) || !(srcH > 0)) return null;
  const cropW = Math.floor(Math.min(srcW, srcH * 9 / 16) / 2) * 2;
  const maxLeft = Math.max(0, srcW - cropW);
  const cropFrac = cropW / srcW;
  const tracks = buildTracks(frames);
  const seenFrames = frames.filter(f => (f.people || []).length || (f.faces || []).length).length;
  if (!tracks.length || seenFrames / frames.length < 0.35) return { fallback: true, reason: 'casi no se ven personas', tracks: 0 };
  const times = frames.map(f => f.t);
  const voice = voiceFn(energy);
  const scores = speakingScores(tracks, times, voice);
  const byId = new Map(tracks.map(t => [t.id, t]));
  const sizeOf = (tr, t) => { const o = at(tr, t); return o ? o.size : 0; };
  // Preferencia base cuando nadie "habla" visiblemente: el más grande (más cerca de cámara) y presente.
  const prior = (tr, t) => { const o = at(tr, t); return o ? 0.002 + o.size * 0.01 - Math.abs(o.x - 0.5) * 0.002 : -1; };

  // --- Elegir a quién seguir en cada instante (con histéresis) ---
  let cur = null, shotStart = 0, challenger = null, challengeSince = 0;
  const who = [];
  times.forEach((t, k) => {
    const present = tracks.filter(tr => at(tr, t));
    const val = tr => (scores.get(tr.id)[k] || 0) + prior(tr, t);
    const curTr = cur ? byId.get(cur) : null;
    const curHere = curTr && at(curTr, t);
    if (!curTr || (!curHere && !present.length)) {
      if (present.length) { cur = present.sort((a, b) => val(b) - val(a))[0].id; shotStart = t; }
    } else if (!curHere) {
      // Se perdió: si ya lleva >0.6 s sin verse, cortar al mejor presente.
      const lastObs = curTr.obs.filter(o => o.t <= t).at(-1);
      if (!lastObs || t - lastObs.t > 0.6) { if (present.length) { cur = present.sort((a, b) => val(b) - val(a))[0].id; shotStart = t; } }
    } else if (present.length > 1) {
      const best = present.filter(p => p.id !== cur).sort((a, b) => val(b) - val(a))[0];
      const wins = best && val(best) > val(curTr) * 1.5 + 0.004 && (scores.get(best.id)[k] || 0) > 0.006;
      if (wins) { if (challenger !== best.id) { challenger = best.id; challengeSince = t; } }
      else challenger = null;
      if (challenger && t - challengeSince >= SWITCH_HOLD && t - shotStart >= MIN_SHOT) {
        // Analizamos el clip completo (no en vivo) → el corte se ADELANTA a cuando el otro empezó a ganar,
        // menos el retraso del suavizado: corta casi justo cuando empieza a hablar, como un editor.
        const cutT = Math.max(shotStart + MIN_SHOT * 0.75, challengeSince - 0.5);
        for (let j = who.length - 1; j >= 0 && times[j] >= cutT; j--) who[j] = challenger;
        cur = challenger; shotStart = cutT; challenger = null;
      }
    }
    who.push(cur);
  });

  // --- Tomas: tramos con la misma persona ---
  const shots = [];
  times.forEach((t, k) => { const id = who[k]; if (!shots.length || shots.at(-1).id !== id) shots.push({ id, start: k === 0 ? 0 : t, k0: k, k1: k }); else shots.at(-1).k1 = k; });
  shots.forEach((s, i) => { s.end = i < shots.length - 1 ? shots[i + 1].start : dur; });

  // --- Encuadre de cada toma ---
  const track = []; const heads = [];
  for (const s of shots) {
    const tr = s.id ? byId.get(s.id) : null;
    // ¿Toma de dos? Otra persona presente casi toda la toma cuyas cabezas caben juntas en el recorte.
    let partner = null;
    if (tr) for (const other of tracks) {
      if (other.id === tr.id) continue;
      let both = 0, fit = 0;
      for (let k = s.k0; k <= s.k1; k++) { const a = at(tr, times[k]), b = at(other, times[k]); if (a && b) { both++; if (Math.abs(a.x - b.x) < cropFrac * 0.62) fit++; } }
      const n = s.k1 - s.k0 + 1;
      if (both >= n * 0.6 && fit >= both * 0.85) { partner = other; break; }
    }
    let cam = null;
    for (let k = s.k0; k <= s.k1; k++) {
      const t = times[k];
      const a = tr && at(tr, t), b = partner && at(partner, t);
      let target = a ? (b ? (a.x + b.x) / 2 : a.x) : (cam ?? 0.5);
      if (a) heads.push(a.y);
      if (cam == null) cam = target;
      else if (Math.abs(target - cam) > DEAD_ZONE * cropFrac) cam += (target - cam) * 0.35; // re-encuadre suave, solo si se sale
      const left = Math.max(0, Math.min(maxLeft, cam * srcW - cropW / 2));
      track.push({ t: +(k === s.k0 ? s.start : t).toFixed(3), x: +left.toFixed(1), cut: k === s.k0 && s !== shots[0] });
    }
  }
  // Corte seco entre tomas: un punto justo antes del corte con la posición vieja.
  const pts = [];
  for (const p of track) { if (p.cut && pts.length) pts.push({ t: +(p.t - 0.001).toFixed(3), x: pts.at(-1).x }); pts.push({ t: p.t, x: p.x }); }
  const fy = Math.max(0.22, Math.min(0.55, median(heads) || 0.38));
  return { track: simplify(pts), cropWidth: cropW, fy: +fy.toFixed(2), shots: shots.map(s => ({ start: +s.start.toFixed(2), end: +s.end.toFixed(2), id: s.id })), tracks: tracks.length, confidence: +(seenFrames / frames.length).toFixed(2) };
}

// Quita puntos redundantes (tramos quietos o rectos) para que la expresión de ffmpeg sea corta.
function simplify(pts) {
  if (pts.length <= 2) return pts;
  const out = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const a = out.at(-1), b = pts[i], c = pts[i + 1];
    const span = c.t - a.t; const lin = span > 0 ? a.x + (c.x - a.x) * (b.t - a.t) / span : b.x;
    if (Math.abs(b.x - lin) > 2 || c.t - b.t < 0.01 || b.t - a.t < 0.01) out.push(b);
  }
  out.push(pts.at(-1));
  return out;
}

module.exports = { direct, buildTracks, subjectsOf, simplify };
