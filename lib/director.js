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
const DEAD_ZONE = 0.14;
const MAX_ZOOM = 1.8;     // acercamiento máximo por toma (más se vería borroso en videos de 720p)    // fracción del ancho del recorte que la cabeza puede moverse sin mover la cámara

function median(a) { const s = a.filter(Number.isFinite).sort((x, y) => x - y); return s.length ? s[s.length >> 1] : NaN; }

// Sujetos del cuadro. Las CARAS mandan (posición precisa + boca). La POSE solo agrega personas sin cara visible
// (de perfil, de espaldas, lejos); en video real la pose a veces "inventa" una persona extra con un brazo o
// duplica a alguien → se descarta toda pose cerca de una cara o de otra pose ya aceptada.
function subjectsOf(frame) {
  const subs = [];
  for (const f of frame.faces || []) {
    if (subs.some(s => Math.abs(s.x - f.cx) < 0.05 && Math.abs(s.y - f.cy) < 0.08)) continue; // cara duplicada
    const near = (frame.people || []).find(p => Math.abs(p.hx - f.cx) < 0.12);
    subs.push({ x: f.cx, y: f.cy, size: Math.max(0.02, f.w * 1.6, near?.sw || 0), mouth: f.mouth, face: true, fw: f.w, sw: near?.sw || null });
  }
  for (const p of (frame.people || []).slice().sort((a, b) => (b.sw || 0) - (a.sw || 0))) {
    if (subs.some(s => Math.abs(s.x - p.hx) < (s.face ? 0.15 : 0.1))) continue;
    if ((p.sw || 0) < 0.04) continue; // demasiado chica/dudosa para encuadrarla
    subs.push({ x: p.hx, y: p.hy, size: Math.max(0.02, p.sw), mouth: null, face: false, fw: null, sw: p.sw });
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
      p.t.obs.push({ t: fr.t, x: s.x, y: s.y, size: s.size, mouth: s.mouth, fw: s.fw, sw: s.sw });
    }
    subs.forEach((s, i) => {
      if (usedS.has(i)) return;
      const ob = { t: fr.t, x: s.x, y: s.y, size: s.size, mouth: s.mouth, fw: s.fw, sw: s.sw };
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
// "Está hablando" por instante: cuánto se MUEVE su boca en una ventana CENTRADA de ±0.6 s (analizamos el clip
// completo, así que se puede ver antes y después → no llega tarde) + qué tan abierta está, y solo si hay voz.
// Devuelve también `silent`: su cara se ve y la boca está QUIETA → esa persona NO es la que habla.
const SPEAK = 0.026;  // actividad mínima para decir "habla" (video real: hablando ≈0.04-0.05; sonriendo ≈0.017)
// Lo que distingue HABLAR de sonreír/reírse callado no es qué tan abierta está la boca, sino qué tan rápido
// se abre y cierra (cada sílaba). Medido en video real a 5 cuadros/s: hablando ≈0.09 de apertura por segundo,
// sonriendo ≈0.03 aunque tenga la boca abierta. Se usa la velocidad (por segundo, así sirve con cualquier fps).
function mouthActivity(tr, t) {
  const os = tr.obs.filter(o => o.mouth != null && Math.abs(o.t - t) <= 0.6);
  if (os.length < 3) return null; // no se le ve la boca lo suficiente
  let moved = 0, span = 0;
  for (let i = 1; i < os.length; i++) { const dt = os[i].t - os[i - 1].t; if (dt > 0 && dt <= 0.3) { moved += Math.abs(os[i].mouth - os[i - 1].mouth); span += dt; } }
  if (span < 0.3) return null;
  const ms = os.map(o => o.mouth), mean = ms.reduce((a, b) => a + b, 0) / ms.length;
  const sd = Math.sqrt(ms.reduce((a, b) => a + (b - mean) ** 2, 0) / ms.length);
  return (moved / span) * 0.4 + sd * 0.5;
}
function speakingScores(tracks, times, voice) {
  const out = new Map(), silent = new Map();
  for (const tr of tracks) {
    const arr = [], sil = [];
    for (const t of times) {
      const v = voice(t), a = mouthActivity(tr, t);
      arr.push(a == null ? 0 : a * v);
      sil.push(a != null && v > 0 && a < SPEAK * 0.6);
    }
    out.set(tr.id, arr); silent.set(tr.id, sil);
  }
  return { scores: out, silent };
}

function direct({ frames, energy, dur, srcW, srcH, overrides = [], autoSplit = true }) {
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
  const { scores, silent } = speakingScores(tracks, times, voice);
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
      // Se perdió (agachó la cabeza, se volteó, salió un momento). Como camarógrafo: la toma SE QUEDA donde estaba,
      // salvo que otra persona visible esté hablando de verdad, o que ya lleve >6 s sin aparecer.
      const lastObs = curTr.obs.filter(o => o.t <= t).at(-1);
      const talker = present.filter(p => (scores.get(p.id)[k] || 0) > SPEAK).sort((a, b) => val(b) - val(a))[0];
      if (talker && t - shotStart >= MIN_SHOT * 0.5) { if (challenger !== talker.id) { challenger = talker.id; challengeSince = t; } }
      else if (!talker) challenger = null;
      const cutToTalker = challenger && t - challengeSince >= SWITCH_HOLD * 0.5;
      // Esperarlo solo tiene sentido si los que se ven están CALLADOS (habla él, tapado). Si no, a los 1.2 s se corta a quien sí está.
      const othersSilent = present.length && present.every(p => silent.get(p.id)[k]);
      const tooLong = !lastObs || t - lastObs.t > (othersSilent ? 6 : 1.2);
      if ((cutToTalker || tooLong) && present.length) {
        const next = cutToTalker ? challenger : present.sort((a, b) => val(b) - val(a))[0].id;
        const cutT = cutToTalker ? Math.max(shotStart + MIN_SHOT * 0.5, challengeSince - 0.2) : t;
        for (let j = who.length - 1; j >= 0 && times[j] >= cutT; j--) who[j] = next;
        cur = next; shotStart = cutT; challenger = null;
      }
    } else if (present.length > 1) {
      const best = present.filter(p => p.id !== cur).sort((a, b) => val(b) - val(a))[0];
      const wins = best && val(best) > val(curTr) * 1.5 + 0.004 && (scores.get(best.id)[k] || 0) > SPEAK;
      if (wins) { if (challenger !== best.id) { challenger = best.id; challengeSince = t; } }
      else challenger = null;
      if (challenger && t - challengeSince >= SWITCH_HOLD && t - shotStart >= MIN_SHOT) {
        // Analizamos el clip completo (no en vivo) → el corte se ADELANTA a cuando el otro empezó a ganar,
        // menos el retraso del suavizado: corta casi justo cuando empieza a hablar, como un editor.
        const cutT = Math.max(shotStart + MIN_SHOT * 0.75, challengeSince - 0.2);
        for (let j = who.length - 1; j >= 0 && times[j] >= cutT; j--) who[j] = challenger;
        cur = challenger; shotStart = cutT; challenger = null;
      }
    }
    who.push(cur);
  });

  // --- Tomas: tramos con la misma persona ---
  const segmentize = () => {
    const out = [];
    times.forEach((t, k) => { const id = who[k]; if (!out.length || out.at(-1).id !== id) out.push({ id, start: k === 0 ? 0 : t, k0: k, k1: k }); else out.at(-1).k1 = k; });
    out.forEach((s, i) => { s.end = i < out.length - 1 ? out[i + 1].start : dur; });
    return out;
  };
  const medX = (tr, k0, k1) => median(times.slice(k0, k1 + 1).map(t => at(tr, t)?.x));
  const presence = (tr, k0, k1) => { let n = 0; for (let k = k0; k <= k1; k++) if (at(tr, times[k])) n++; return n / (k1 - k0 + 1); };
  const fitTogether = (a, b, k0, k1) => Math.abs(medX(a, k0, k1) - medX(b, k0, k1)) < cropFrac * 0.62;
  const splitKey = (a, b) => { const [l, r] = [a, b].sort((x, y) => x.x - y.x); return `split:${l.id},${r.id}`; }; // izquierda arriba
  // PANTALLA DIVIDIDA automática: dos personas que NO caben juntas se responden rápido (≥3 tomas seguidas <3.5 s
  // alternando entre las dos) → en vez de cortar a cada rato, una arriba y otra abajo.
  if (autoSplit) {
    const base = segmentize();
    for (let i = 0; i < base.length; i++) {
      if (base[i].id == null) continue;
      let j = i; const pair = new Set([base[i].id]);
      while (j + 1 < base.length) {
        const nxt = base[j + 1];
        if (base[j].end - base[j].start >= 3.5 || nxt.end - nxt.start >= 3.5 || nxt.id == null) break;
        if (!pair.has(nxt.id) && pair.size >= 2) break; // entra una tercera persona
        pair.add(nxt.id); j++;
      }
      if (j - i + 1 >= 3 && pair.size === 2) {
        const [a, b] = [...pair].map(id => byId.get(id));
        const k0 = base[i].k0, k1 = base[j].k1;
        if (a && b && !fitTogether(a, b, k0, k1) && presence(a, k0, k1) > 0.6 && presence(b, k0, k1) > 0.6) {
          const key = splitKey({ id: a.id, x: medX(a, k0, k1) }, { id: b.id, x: medX(b, k0, k1) });
          for (let k = k0; k <= k1; k++) who[k] = key;
          i = j;
        }
      }
    }
  }
  // CAMBIOS MANUALES del usuario (vista previa de tomas): persona fija, dividida o automático en un tramo.
  for (const o of overrides || []) {
    const ks = times.map((t, k) => k).filter(k => times[k] >= o.start - 0.001 && times[k] < o.end - 0.001);
    if (!ks.length || o.mode === 'auto') continue;
    if (o.mode === 'person' && byId.has(o.id)) ks.forEach(k => { who[k] = o.id; });
    if (o.mode === 'wide') ks.forEach(k => { who[k] = 'wide'; });
    if (o.mode === 'split') {
      const two = tracks.map(tr => ({ tr, p: presence(tr, ks[0], ks.at(-1)) })).sort((x, y) => y.p - x.p).slice(0, 2);
      if (two.length === 2 && two[1].p > 0.3) { const key = splitKey({ id: two[0].tr.id, x: medX(two[0].tr, ks[0], ks.at(-1)) }, { id: two[1].tr.id, x: medX(two[1].tr, ks[0], ks.at(-1)) }); ks.forEach(k => { who[k] = key; }); }
    }
  }
  for (let k = 0; k < who.length; k++) if (who[k] == null) who[k] = 'wide'; // nadie a quién encuadrar → toma abierta
  // Si por ≥1 s NO hay nadie en cuadro (salió todo mundo, la cámara apunta al piso), ese tramo también va abierto.
  for (let k = 0; k < who.length;) {
    const empty = j => typeof who[j] === 'number' && !tracks.some(tr => at(tr, times[j]));
    if (!empty(k)) { k++; continue; }
    let j = k; while (j + 1 < who.length && empty(j + 1)) j++;
    if (times[j] - times[k] >= 1) for (let q = k; q <= j; q++) who[q] = 'wide';
    k = j + 1;
  }
  const shots = segmentize();

  // --- Encuadre de cada toma ---
  const track = []; const heads = []; const splits = []; const framing = []; const wides = [];
  for (const s of shots) {
    if (typeof s.id === 'string' && s.id.startsWith('split:')) {
      const [ta, tb] = s.id.slice(6).split(',').map(Number).map(id => byId.get(id));
      const panel = tr => { const ys = times.slice(s.k0, s.k1 + 1).map(t => at(tr, t)).filter(Boolean); return { x: +median(ys.map(o => o.x)).toFixed(4), y: +median(ys.map(o => o.y)).toFixed(4), size: +median(ys.map(o => o.size)).toFixed(4) }; };
      splits.push({ start: +s.start.toFixed(2), end: +s.end.toFixed(2), top: panel(ta), bottom: panel(tb), ids: [ta.id, tb.id] });
      const keep = track.length ? track.at(-1).x : Math.max(0, Math.min(maxLeft, srcW / 2 - cropW / 2));
      track.push({ t: +s.start.toFixed(3), x: keep, cut: false }); // la toma normal queda tapada por la dividida
      continue;
    }
    // TOMA ABIERTA (como Opus): no hay a quién encuadrar, o la persona elegida casi no aparece en la toma
    // → imagen completa con fondo borroso, en vez de un recorte vacío o de un brazo.
    const lonely = typeof s.id === 'number' && s.end - s.start >= 1 && presence(byId.get(s.id), s.k0, s.k1) < 0.4 && !(overrides || []).some(o => o.mode === 'person' && o.id === s.id && o.start <= s.start + 0.05 && o.end >= s.end - 0.05);
    if (s.id === 'wide' || lonely) {
      if (wides.length && Math.abs(wides.at(-1).end - s.start) < 0.01) wides.at(-1).end = +s.end.toFixed(2); else wides.push({ start: +s.start.toFixed(2), end: +s.end.toFixed(2) });
      s.layout = 'wide';
      const keep = track.length ? track.at(-1).x : Math.max(0, Math.min(maxLeft, srcW / 2 - cropW / 2));
      track.push({ t: +s.start.toFixed(3), x: keep, cut: false });
      continue;
    }
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
    // Cámara como la de Opus: FIJA dentro de la toma. El objetivo es la mediana de la posición en ±0.4 s
    // (el temblor del detector no mueve nada) y solo se reacomoda si la persona lleva ≥0.5 s fuera de la
    // zona central; entonces se mueve de un jalón corto (0.25 s) y vuelve a quedarse quieta.
    const targetAt = k => {
      const xs = [];
      for (let j = k; j >= s.k0 && times[k] - times[j] <= 0.4; j--) { const a = tr && at(tr, times[j]), b = partner && at(partner, times[j]); if (a) xs.push(b ? (a.x + b.x) / 2 : a.x); }
      for (let j = k + 1; j <= s.k1 && times[j] - times[k] <= 0.4; j++) { const a = tr && at(tr, times[j]), b = partner && at(partner, times[j]); if (a) xs.push(b ? (a.x + b.x) / 2 : a.x); }
      return xs.length ? median(xs) : null;
    };
    let cam = null, outSince = null; const relX = [], relY = [], fws = [], sws = [], gaps = [];
    for (let k = s.k0; k <= s.k1; k++) {
      const t = times[k];
      const a = tr && at(tr, t);
      if (a) heads.push(a.y);
      const target = targetAt(k);
      let moved = false;
      if (cam == null) cam = target ?? 0.5;
      else if (target != null && Math.abs(target - cam) > DEAD_ZONE * cropFrac) {
        if (outSince == null) outSince = t;
        if (t - outSince >= 0.5) { // se reacomoda de un jalón: punto con la posición vieja + punto 0.25 s después con la nueva
          const oldLeft = Math.max(0, Math.min(maxLeft, cam * srcW - cropW / 2));
          track.push({ t: +t.toFixed(3), x: +oldLeft.toFixed(1), cut: false });
          cam = target; outSince = null; moved = true;
        }
      } else outSince = null;
      const left = Math.max(0, Math.min(maxLeft, cam * srcW - cropW / 2));
      const pt = { t: +(moved ? t + 0.25 : (k === s.k0 ? s.start : t)).toFixed(3), x: +left.toFixed(1), cut: k === s.k0 && s !== shots[0] };
      if (pt.cut || k === s.k0) while (track.length && track.at(-1).t >= pt.t - 0.002) track.pop(); // un reacomodo no puede pasarse del corte
      if (!track.length || pt.t > track.at(-1).t) track.push(pt); // los tiempos siempre en orden
      if (a) {
        const b = partner && at(partner, t);
        relX.push(((b ? (a.x + b.x) / 2 : a.x) * srcW - left) / cropW); relY.push(b ? Math.min(a.y, b.y) : a.y);
        if (a.fw) fws.push(a.fw); else if (a.sw) sws.push(a.sw);
        if (b) gaps.push(Math.abs(a.x - b.x));
      }
    }
    // ACERCAMIENTO por toma (como Opus): que la cara ocupe ~26 % de la altura del Short. Cara chica (lejos) → zoom.
    // Tope 1.8× para no ver borroso; con dos personas, el zoom deja que quepan las dos.
    let z = 1;
    if (fws.length >= 2) z = srcH * 0.26 / (median(fws) * srcW * 1.3);
    else if (sws.length >= 2) z = (cropW * 0.5) / (median(sws) * srcW);
    if (gaps.length) z = Math.min(z, cropW * 0.75 / (median(gaps) * srcW));
    z = Math.max(1, Math.min(MAX_ZOOM, z));
    framing.push({ start: +s.start.toFixed(2), end: +s.end.toFixed(2), z: +z.toFixed(3), hx: +(median(relX) || 0.5).toFixed(3), hy: +(median(relY) || 0.35).toFixed(3) });
  }
  // Corte seco entre tomas: un punto justo antes del corte con la posición vieja.
  const pts = [];
  for (const p of track) { if (p.cut && pts.length) pts.push({ t: +(p.t - 0.001).toFixed(3), x: pts.at(-1).x }); pts.push({ t: p.t, x: p.x }); }
  const fy = Math.max(0.22, Math.min(0.55, median(heads) || 0.38));
  // Personas para la vista previa (las más presentes), con el instante donde mejor se le ve la cara.
  const people = tracks.slice().sort((a, b) => b.obs.length - a.obs.length).filter(tr => tr.obs.length / frames.length >= 0.08 || shots.some(s => s.id === tr.id)).slice(0, 6).map(tr => {
    const best = tr.obs.slice().sort((a, b) => ((b.mouth != null) - (a.mouth != null)) || b.size - a.size)[0];
    return { id: tr.id, seen: +(tr.obs.length / frames.length).toFixed(2), t: best.t, x: +best.x.toFixed(4), y: +best.y.toFixed(4), size: +best.size.toFixed(4) };
  });
  return {
    track: simplifyCapped(pts), cropWidth: cropW, fy: +fy.toFixed(2), splits, people, framing,
    wides,
    shots: shots.map(s => s.layout === 'wide' ? { start: +s.start.toFixed(2), end: +s.end.toFixed(2), layout: 'wide' } : typeof s.id === 'string' ? { start: +s.start.toFixed(2), end: +s.end.toFixed(2), layout: 'split', ids: s.id.slice(6).split(',').map(Number) } : { start: +s.start.toFixed(2), end: +s.end.toFixed(2), layout: 'single', id: s.id }),
    tracks: tracks.length, confidence: +(seenFrames / frames.length).toFixed(2),
  };
}

// Quita puntos redundantes (tramos quietos o rectos) para que la expresión de ffmpeg sea corta.
// ffmpeg rechaza expresiones demasiado anidadas: si quedan muchos puntos, se simplifica con más tolerancia.
function simplifyCapped(pts) { let tol = 2, out = simplify(pts, tol); while (out.length > 60 && tol < 200) { tol *= 2; out = simplify(pts, tol); } return out; }
function simplify(pts, tol = 2) {
  if (pts.length <= 2) return pts;
  const out = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const a = out.at(-1), b = pts[i], c = pts[i + 1];
    const span = c.t - a.t; const lin = span > 0 ? a.x + (c.x - a.x) * (b.t - a.t) / span : b.x;
    if (Math.abs(b.x - lin) > tol || c.t - b.t < 0.01 || b.t - a.t < 0.01) out.push(b);
  }
  out.push(pts.at(-1));
  return out;
}

module.exports = { direct, buildTracks, subjectsOf, simplify, simplifyCapped };
