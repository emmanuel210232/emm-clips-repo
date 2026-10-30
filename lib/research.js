'use strict';
// ===== INVESTIGAR COMPETENCIA =====
// Análisis PURO (sin red) de los videos de canales que resuben a Shifu: qué pegó por encima de lo normal
// de su propio canal, a qué hora/día se subió, y qué tienen en común sus títulos, hashtags y duración.

const TZ = 'America/Mexico_City';
const DAYS = ['Dom','Lun','Mar','Mié','Jue','Vie','Sáb'];
const SHIFU_RE = /shifu|zendejas|adriano\s*z/i;
const SHORT_MAX = 180; // YouTube Shorts duran hasta 3 min
const FRESH_DAYS = 2;  // videos más nuevos aún no "asientan" sus vistas → no cuentan para patrones

function parseDuration(iso) {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(String(iso || ''));
  if (!m) return 0;
  return (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0);
}
function median(arr) {
  const a = arr.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return 0;
  const h = a.length >> 1;
  return a.length % 2 ? a[h] : (a[h - 1] + a[h]) / 2;
}
const _fmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', hourCycle: 'h23', weekday: 'short' });
const _wd = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
// Hora y día de la semana en hora de CDMX (la audiencia de Shifu es mexicana).
function mxSlot(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return { hour: 0, dow: 0 };
  const parts = Object.fromEntries(_fmt.formatToParts(d).map(p => [p.type, p.value]));
  return { hour: Number(parts.hour) % 24, dow: _wd[parts.weekday] ?? 0 };
}
function extractHashtags(text) {
  const out = new Set();
  for (const m of String(text || '').matchAll(/#([\p{L}\p{N}_]{2,40})/gu)) out.add('#' + m[1].toLowerCase());
  return [...out];
}
const EMOJI_RE = /\p{Extended_Pictographic}/gu;
function titleFeatures(title) {
  const t = String(title || '');
  const letters = t.replace(/[^\p{L}]/gu, '');
  const upper = letters.replace(/[^\p{Lu}]/gu, '');
  const words = t.split(/\s+/).filter(Boolean);
  return {
    length: t.length,
    words: words.length,
    capsRatio: letters.length ? upper.length / letters.length : 0,
    capsWords: words.filter(w => w.replace(/[^\p{L}]/gu, '').length >= 3 && w === w.toUpperCase() && /\p{L}/u.test(w)).length,
    emojis: (t.match(EMOJI_RE) || []).length,
    hasNumber: /\d/.test(t),
    hasMoney: /\$|d[oó]lares|pesos|millones|\bmil\b|\bk\b/i.test(t),
    hasQuestion: /[¿?]/.test(t),
    hasExclaim: /[¡!]/.test(t),
    hasSeparator: /[|•–—]/.test(t),
    mentionsShifu: SHIFU_RE.test(t),
  };
}
const STOP = new Set('el la los las un una unos unas de del al a y o en con por para que se su sus lo le les mi me te tu es fue son ya no si sí más mas muy como pero porque cuando donde este esta esto ese esa eso ser hay the and of to in vs | - — – x'.split(' '));
function titleWords(title) {
  const words = String(title || '').toLowerCase()
    .replace(EMOJI_RE, ' ')
    .replace(/[^\p{L}\p{N}$#\s]/gu, ' ')
    .split(/\s+/).filter(w => w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w));
  return [...new Set(words)];
}
function durationBucket(sec, format) {
  if (format === 'short') return sec <= 30 ? '≤30 s' : sec <= 60 ? '31–60 s' : '1–3 min';
  const m = sec / 60;
  return m < 8 ? '<8 min' : m < 15 ? '8–15 min' : m < 25 ? '15–25 min' : m < 40 ? '25–40 min' : '40+ min';
}
const BUCKET_ORDER = ['≤30 s', '31–60 s', '1–3 min', '<8 min', '8–15 min', '15–25 min', '25–40 min', '40+ min'];

// Convierte un item de videos.list de la API de YouTube a nuestro formato compacto.
function normalizeVideo(item) {
  const sn = item.snippet || {}, st = item.statistics || {}, cd = item.contentDetails || {};
  const th = sn.thumbnails || {};
  const thumb = (th.maxres || th.standard || th.high || th.medium || th.default || {}).url || '';
  const thumbSmall = (th.medium || th.high || th.default || {}).url || thumb;
  return {
    id: item.id,
    channelId: sn.channelId || '',
    title: sn.title || '',
    description: String(sn.description || '').slice(0, 1500),
    tags: Array.isArray(sn.tags) ? sn.tags.slice(0, 40) : [],
    publishedAt: sn.publishedAt || '',
    duration: parseDuration(cd.duration),
    views: Number(st.viewCount) || 0,
    likes: Number(st.likeCount) || 0,
    comments: Number(st.commentCount) || 0,
    thumb, thumbSmall,
    live: sn.liveBroadcastContent && sn.liveBroadcastContent !== 'none',
  };
}

// Decide qué videos de cada canal cuentan: si el canal es "dedicado" a Shifu (≥50 % de sus videos lo mencionan)
// cuentan todos (muchos resubidores titulan sin poner "Shifu"); si es un canal general, solo los que lo mencionan.
function relevantVideos(channel, videos) {
  const vs = videos.filter(v => !v.live && v.duration > 0);
  if (!vs.length) return { videos: [], share: 0, dedicated: false };
  const isShifu = v => SHIFU_RE.test(v.title) || SHIFU_RE.test(v.description) || v.tags.some(t => SHIFU_RE.test(t));
  const share = vs.filter(isShifu).length / vs.length;
  const dedicated = share >= 0.5 || SHIFU_RE.test(channel.title || '') || SHIFU_RE.test(channel.description || '');
  return { videos: dedicated ? vs : vs.filter(isShifu), share, dedicated };
}

// Enriquece cada video: formato, edad, vistas/día y SCORE = vistas ÷ mediana de su propio canal (mismo formato).
// Así un canal chico con un video de 8× cuenta igual que uno grande: lo que importa es lo que PEGÓ más de lo normal.
function enrich(channels, videosByChannel, now = Date.now()) {
  const out = [];
  for (const ch of channels) {
    const { videos, share, dedicated } = relevantVideos(ch, videosByChannel[ch.id] || []);
    ch.shifuShare = share; ch.dedicated = dedicated; ch.analyzed = videos.length;
    for (const format of ['long', 'short']) {
      const vs = videos.filter(v => (v.duration <= SHORT_MAX ? 'short' : 'long') === format);
      const settled = vs.filter(v => (now - Date.parse(v.publishedAt)) / 864e5 >= FRESH_DAYS);
      const med = median((settled.length >= 3 ? settled : vs).map(v => v.views)) || 1;
      ch[format === 'long' ? 'medianLong' : 'medianShort'] = vs.length ? Math.round(med) : 0;
      for (const v of vs) {
        const ageDays = Math.max(0.25, (now - Date.parse(v.publishedAt)) / 864e5);
        const slot = mxSlot(v.publishedAt);
        out.push({
          ...v, format, ageDays: +ageDays.toFixed(1),
          vpd: Math.round(v.views / ageDays),
          score: +(v.views / med).toFixed(2),
          hour: slot.hour, dow: slot.dow,
          fresh: ageDays < FRESH_DAYS,
          channelTitle: ch.title, mine: !!ch.mine,
          hashtags: extractHashtags(v.title + ' ' + v.description),
          bucket: durationBucket(v.duration, format),
          sampleSmall: vs.length < 5, // canal con pocos videos de este formato → su score es menos confiable
        });
      }
    }
  }
  return out;
}

function featureAverages(vs) {
  const n = vs.length || 1;
  const f = vs.map(v => titleFeatures(v.title));
  const avg = k => f.reduce((s, x) => s + (typeof x[k] === 'boolean' ? (x[k] ? 1 : 0) : x[k]), 0) / n;
  return {
    n: vs.length,
    length: +avg('length').toFixed(1), words: +avg('words').toFixed(1),
    capsRatio: +avg('capsRatio').toFixed(2), capsWords: +avg('capsWords').toFixed(1),
    emojis: +avg('emojis').toFixed(2),
    hasNumber: +avg('hasNumber').toFixed(2), hasMoney: +avg('hasMoney').toFixed(2),
    hasQuestion: +avg('hasQuestion').toFixed(2), hasExclaim: +avg('hasExclaim').toFixed(2),
    hasSeparator: +avg('hasSeparator').toFixed(2), mentionsShifu: +avg('mentionsShifu').toFixed(2),
    hashtags: +(vs.reduce((s, v) => s + v.hashtags.length, 0) / n).toFixed(1),
  };
}

// Palabras con más "lift": aparecen mucho más en los títulos que pegaron (top 25 %) que en el resto.
function wordLift(top, rest, minTop = 3) {
  const count = vs => { const m = new Map(); for (const v of vs) for (const w of titleWords(v.title)) m.set(w, (m.get(w) || 0) + 1); return m; };
  const ct = count(top), cr = count(rest);
  const out = [];
  for (const [w, n] of ct) {
    if (n < minTop) continue;
    const pt = n / top.length, pr = ((cr.get(w) || 0) + 0.5) / (rest.length + 1);
    out.push({ word: w, top: n, rest: cr.get(w) || 0, lift: +(pt / pr).toFixed(2) });
  }
  return out.filter(x => x.lift >= 1.3).sort((a, b) => b.lift - a.lift || b.top - a.top).slice(0, 25);
}

function hashtagStats(top, all) {
  const m = new Map();
  for (const v of all) for (const h of v.hashtags) { const e = m.get(h) || { tag: h, uses: 0, inTop: 0 }; e.uses++; m.set(h, e); }
  for (const v of top) for (const h of v.hashtags) m.get(h).inTop++;
  return [...m.values()].filter(e => e.uses >= 2).sort((a, b) => b.inTop - a.inTop || b.uses - a.uses).slice(0, 25);
}

// Mapa día×hora (CDMX): cuántos videos se subieron y su score mediano.
function heatmap(vs) {
  const cells = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => []));
  for (const v of vs) cells[v.dow][v.hour].push(v.score);
  const grid = cells.map(row => row.map(s => ({ n: s.length, score: s.length ? +median(s).toFixed(2) : 0 })));
  const byHour = Array.from({ length: 24 }, (_, h) => { const s = vs.filter(v => v.hour === h).map(v => v.score); return { hour: h, n: s.length, score: s.length ? +median(s).toFixed(2) : 0 }; });
  const byDay = Array.from({ length: 7 }, (_, d) => { const s = vs.filter(v => v.dow === d).map(v => v.score); return { dow: d, day: DAYS[d], n: s.length, score: s.length ? +median(s).toFixed(2) : 0 }; });
  // Ventanas de 3 h (más estables que horas sueltas con pocos datos).
  const windows = [];
  for (let h = 0; h < 24; h++) {
    const s = vs.filter(v => [h, (h + 1) % 24, (h + 2) % 24].includes(v.hour)).map(v => v.score);
    if (s.length >= 3) windows.push({ from: h, to: (h + 3) % 24, n: s.length, score: +median(s).toFixed(2) });
  }
  windows.sort((a, b) => b.score - a.score || b.n - a.n);
  const bestWindows = [];
  for (const w of windows) { if (bestWindows.every(b => Math.min(Math.abs(b.from - w.from), 24 - Math.abs(b.from - w.from)) >= 3)) bestWindows.push(w); if (bestWindows.length >= 3) break; }
  return { grid, byHour, byDay, bestWindows };
}

function durationStats(vs) {
  const m = new Map();
  for (const v of vs) { const e = m.get(v.bucket) || []; e.push(v.score); m.set(v.bucket, e); }
  return BUCKET_ORDER.filter(b => m.has(b)).map(b => ({ bucket: b, n: m.get(b).length, score: +median(m.get(b)).toFixed(2) }));
}

function analyzeFormat(all, format) {
  const vs = all.filter(v => v.format === format && !v.mine && !v.fresh);
  const sorted = [...vs].sort((a, b) => b.score - a.score);
  const q = Math.max(1, Math.round(sorted.length / 4));
  const top = sorted.slice(0, q), rest = sorted.slice(q);
  const mine = all.filter(v => v.format === format && v.mine);
  return {
    format, count: vs.length,
    medianViews: Math.round(median(vs.map(v => v.views))),
    medianVpd: Math.round(median(vs.map(v => v.vpd))),
    outliers: sorted.slice(0, 40).map(slim),
    flops: sorted.slice(-12).reverse().map(slim),
    titles: { top: featureAverages(top), rest: featureAverages(rest), mine: mine.length ? featureAverages(mine) : null },
    words: wordLift(top, rest, sorted.length >= 40 ? 3 : 2),
    hashtags: hashtagStats(top, vs),
    time: heatmap(vs),
    mineTime: mine.length ? heatmap(mine).byHour.filter(h => h.n) : [],
    durations: durationStats(vs),
    mineCount: mine.length,
    mineMedianViews: Math.round(median(mine.map(v => v.views))),
  };
}
function slim(v) {
  return { id: v.id, title: v.title, channelTitle: v.channelTitle, channelId: v.channelId, views: v.views, vpd: v.vpd, score: v.score, likes: v.likes, comments: v.comments, duration: v.duration, hour: v.hour, dow: v.dow, day: DAYS[v.dow], publishedAt: v.publishedAt, thumb: v.thumb, thumbSmall: v.thumbSmall, hashtags: v.hashtags.slice(0, 12), tags: v.tags.slice(0, 15), description: v.description.slice(0, 400), sampleSmall: v.sampleSmall };
}

function analyze(channels, videosByChannel, now = Date.now()) {
  const tracked = channels.filter(c => c.status === 'track' || c.mine);
  const all = enrich(tracked, videosByChannel, now);
  return {
    analyzedAt: now,
    channels: tracked.map(c => ({ id: c.id, title: c.title, mine: !!c.mine, analyzed: c.analyzed, shifuShare: +(c.shifuShare || 0).toFixed(2), dedicated: !!c.dedicated, medianLong: c.medianLong, medianShort: c.medianShort })),
    totals: { videos: all.length, long: all.filter(v => v.format === 'long').length, short: all.filter(v => v.format === 'short').length },
    long: analyzeFormat(all, 'long'),
    short: analyzeFormat(all, 'short'),
    mineVideos: all.filter(v => v.mine).sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt)).slice(0, 30).map(slim),
  };
}

// Acepta @handle, URL de canal (/@x, /channel/UC…, /c/x, /user/x) o un ID UC… y dice cómo resolverlo.
function parseChannelInput(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  let m = /(UC[\w-]{22})/.exec(s); if (m) return { id: m[1] };
  m = /youtube\.com\/@([\w.\-]+)/i.exec(s) || /^@([\w.\-]+)$/.exec(s); if (m) return { handle: '@' + m[1] };
  m = /youtube\.com\/(?:c|user)\/([\w.\-]+)/i.exec(s); if (m) return { username: m[1] };
  if (/^[\w.\-]{3,}$/.test(s)) return { handle: '@' + s };
  return null;
}

// Transcripción compacta para la IA: agrupa por minuto y quita los bucles que Whisper inventa en silencios
// (la misma frase repetida decenas de veces). Si es muy larga, toma muestras parejas de todo el video.
function compactTranscript(segments, maxChars = 60000) {
  const byMin = new Map();
  let last = '', rep = 0;
  for (const s of segments || []) {
    const t = String(s.text || '').trim(); if (!t) continue;
    const norm = t.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, '');
    if (norm && norm === last) { if (++rep >= 2) continue; } else { last = norm; rep = 0; }
    const k = Math.floor((s.start || 0) / 60);
    byMin.set(k, (byMin.get(k) || '') + ' ' + t);
  }
  let lines = [...byMin.entries()].sort((a, b) => a[0] - b[0]).map(([k, t]) => `[${k}m] ${t.replace(/\s+/g, ' ').trim()}`);
  // Segundo filtro: frases cortas repetidas dentro del mismo minuto ("¿Qué? ¿Qué? ¿Qué?").
  lines = lines.map(l => l.replace(/((?:[^.?!]{1,60}[.?!])\s*)\1{2,}/gu, '$1'));
  let text = lines.join('\n');
  if (text.length <= maxChars) return text;
  const keep = []; let budget = maxChars; const step = text.length / maxChars;
  for (let i = 0; i < lines.length && budget > 0; i += Math.max(1, Math.round(step))) { keep.push(lines[i]); budget -= lines[i].length; }
  return keep.join('\n');
}

module.exports = { parseDuration, median, mxSlot, extractHashtags, titleFeatures, titleWords, normalizeVideo, relevantVideos, enrich, analyze, parseChannelInput, compactTranscript, DAYS, SHIFU_RE };
