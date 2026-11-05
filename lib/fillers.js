'use strict';
// MULETILLAS en español de México ("eh", "em", "mmm", "este…", "o sea", "bueno", "pues", "¿no?").
// Lógica PURA (sirve en Node y en el navegador como window.EmmFillers): detecta candidatas en la transcripción, decide
// si es "segura" (se marca sola) o "revisar" (el usuario decide) y calcula el tramo a quitar sin dejar un hueco raro.
// Criterio CONSERVADOR: mejor no marcar que cortar de más. "este video", "está bueno", "pues sí", "o sea que…"
// NO se marcan.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EmmFillers = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const PAD = 0.03;        // margen alrededor de la palabra
  const KEEP = 0.08;       // lo que se deja de silencio junto a la palabra vecina (para que no suene "pegado")
  const PAUSE = 0.25;      // hueco que cuenta como pausa después/antes de la palabra
  const MIN_WORD = 0.06;   // palabras más cortas = tiempo poco confiable

  function normalize(value) {
    return String(value == null ? '' : value).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9ñ]+/g, ' ').trim();
  }

  // Igual que tokenizeTranscript de lib/core.js, pero conservando el texto crudo (comas, "…", "?").
  function tokenize(segments) {
    const words = [];
    for (const segment of segments || []) {
      const start = Number(segment.start), end = Number(segment.end);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
      const raw = String(segment.text == null ? '' : segment.text).trim().split(/\s+/).filter(Boolean);
      raw.forEach((text, index) => {
        const a = start + (end - start) * index / raw.length, b = start + (end - start) * (index + 1) / raw.length;
        const norm = normalize(text);
        if (!norm) return;
        words.push({ text, norm, start: a, end: b, approximate: raw.length > 1 || !!segment.approximate || b - a > 0.9 || b - a < 0.04, segEnd: index === raw.length - 1 });
      });
    }
    return words;
  }

  // Lista editable por defecto. level: 'siempre' = se marca sola; 'revisar' = se lista sin marcar.
  // kind: cómo se decide si es muletilla (ver isFiller).
  const DEFAULT_FILLERS = [
    { term: 'eh / ehh / eeeh', kind: 'eh', level: 'siempre', enabled: true },
    { term: 'em / emm / mmm / hmm', kind: 'mm', level: 'siempre', enabled: true },
    { term: 'este…', kind: 'este', level: 'revisar', enabled: true },
    { term: 'o sea', kind: 'osea', level: 'revisar', enabled: true },
    { term: 'bueno', kind: 'bueno', level: 'revisar', enabled: true },
    { term: 'pues', kind: 'pues', level: 'revisar', enabled: true },
    { term: '¿no?', kind: 'no', level: 'revisar', enabled: true },
    { term: 'ah / aah', kind: 'ah', level: 'revisar', enabled: true },
  ];

  const punctAfter = w => /[,;:]$|\.\.\.$|…$/.test(w.text);   // "este," "pues…"
  const endsSentence = w => /[.!?¿¡]$/.test(w.text) && !/\.\.\.$/.test(w.text);
  const gapAfter = (words, i) => (i + 1 < words.length ? words[i + 1].start - words[i].end : Infinity);
  const gapBefore = (words, i) => (i > 0 ? words[i].start - words[i - 1].end : Infinity);
  const pausedAfter = (words, i) => punctAfter(words[i]) || gapAfter(words, i) >= PAUSE || (words[i].segEnd && gapAfter(words, i) >= 0.15);
  const startsUtterance = (words, i) => i === 0 || gapBefore(words, i) >= 0.4 || endsSentence(words[i - 1]) || punctAfter(words[i - 1]);
  const SURE_EH = /^e+h+$|^e{2,}$/;           // eh, ehh, eeeh, eee (no "e" sola: conjunción "e iba")
  const SURE_MM = /^e*m{1,}$|^h+m+$|^m{2,}$/;  // em, emm, mmm, hmm (no "m" sola)
  const SURE_AH = /^a+h+$|^a{2,}h*$/;          // ah, aah, aaa

  // ¿La palabra i (y la siguiente, para "o sea") es muletilla? Regresa {len, reason} o null.
  function isFiller(words, i, kind) {
    const w = words[i], n = w.norm, next = words[i + 1], prev = words[i - 1];
    switch (kind) {
      case 'eh': return SURE_EH.test(n) ? { len: 1, reason: 'sonido de duda' } : null;
      case 'mm': return SURE_MM.test(n) && n !== 'm' ? { len: 1, reason: 'sonido de duda' } : null;
      case 'ah': return SURE_AH.test(n) && pausedAfter(words, i) ? { len: 1, reason: '"ah" suelto' } : null;
      case 'este':
        // "este" + pausa/coma/"…", o "este este", o "este" antes de otra muletilla. "este video" NO.
        if (n !== 'este') return null;
        if (pausedAfter(words, i)) return { len: 1, reason: '"este" con pausa' };
        if (next && (next.norm === 'este' || SURE_EH.test(next.norm) || SURE_MM.test(next.norm))) return { len: 1, reason: '"este" repetido' };
        return null;
      case 'osea': {
        // "o sea," / "o sea…" / "o sea o sea". "o sea que…" o "o sea, que" con sentido completo: se deja para revisar solo con pausa.
        let len = 0;
        if (n === 'osea') len = 1; else if (n === 'o' && next && next.norm === 'sea') len = 2;
        if (!len) return null;
        const last = i + len - 1, after = words[last + 1];
        if (after && after.norm === 'que' && !pausedAfter(words, last)) return null;
        if (pausedAfter(words, last) || (after && (after.norm === 'o' || after.norm === 'osea'))) return { len, reason: '"o sea" de relleno' };
        return null;
      }
      case 'bueno': {
        // Solo "Bueno," al empezar a hablar. "está bueno", "muy bueno", "bueno es…" NO.
        if (n !== 'bueno') return null;
        if (prev && /^(muy|esta|estuvo|estaba|es|tan|que|bien|lo|el|un|una|se|ve|sale|nada|algo|mas|super)$/.test(prev.norm) && !startsUtterance(words, i)) return null;
        if (startsUtterance(words, i) && pausedAfter(words, i) && !(next && /^(es|esta|estuvo|era|fue)$/.test(next.norm) && !punctAfter(w))) return { len: 1, reason: '"bueno" para arrancar' };
        return null;
      }
      case 'pues': {
        // "pues…" / "pues, este…" con pausa. "pues sí", "pues no", "pues claro", "pues ya" son respuestas: NO.
        if (n !== 'pues' && n !== 'pos') return null;
        if (next && /^(si|no|claro|ya|obvio|nada|bueno|asi|nomas|si si)$/.test(next.norm)) return null;
        if (pausedAfter(words, i) && (startsUtterance(words, i) || punctAfter(w) || gapAfter(words, i) >= 0.4)) return { len: 1, reason: '"pues" con pausa' };
        return null;
      }
      case 'no':
        // Coletilla "…¿no?" al final de una frase (no un "no" de respuesta al inicio).
        if (n !== 'no' || !/\?$/.test(w.text) || startsUtterance(words, i)) return null;
        return { len: 1, reason: 'coletilla "¿no?"' };
      default: return null;
    }
  }

  // Muletillas propias del usuario: frase exacta que se marca solo si viene seguida de pausa/coma (conservador).
  function customMatch(words, i, parts) {
    for (let j = 0; j < parts.length; j++) if (!words[i + j] || words[i + j].norm !== parts[j]) return null;
    return pausedAfter(words, i + parts.length - 1) ? { len: parts.length, reason: 'de tu lista' } : null;
  }

  // Tramo a quitar: la palabra con un margen chico; si hay silencio junto, se lo come también (dejando KEEP junto a la
  // palabra vecina) para que no quede un hueco que se note.
  function cutRange(words, i, len, duration) {
    const first = words[i], last = words[i + len - 1];
    const prev = words[i - 1], next = words[i + len];
    let start = first.start - PAD, end = last.end + PAD;
    if (prev) start = Math.max(start, prev.end + Math.min(KEEP, Math.max(0, first.start - prev.end) / 2));
    if (next) end = Math.min(end, next.start - Math.min(KEEP, Math.max(0, next.start - last.end) / 2));
    if (prev && first.start - prev.end >= 0.15) start = Math.min(start, prev.end + KEEP);
    if (next && next.start - last.end >= 0.15) end = Math.max(end, next.start - KEEP);
    start = Math.max(0, start); if (Number.isFinite(duration) && duration > 0) end = Math.min(duration, end);
    return { start: +start.toFixed(3), end: +end.toFixed(3) };
  }

  // Busca muletillas. list = lista editable (DEFAULT_FILLERS + propias {term, level, enabled}).
  function findFillers(segments, list = DEFAULT_FILLERS, { duration = Infinity } = {}) {
    const words = tokenize(segments);
    const entries = (list || []).filter(e => e && e.enabled !== false);
    const out = [];
    for (let i = 0; i < words.length; i++) {
      for (const e of entries) {
        const hit = e.kind ? isFiller(words, i, e.kind) : customMatch(words, i, normalize(e.term).split(' ').filter(Boolean));
        if (!hit) continue;
        const slice = words.slice(i, i + hit.len);
        const approximate = slice.some(w => w.approximate || w.end - w.start < MIN_WORD);
        const r = cutRange(words, i, hit.len, duration);
        if (!(r.end > r.start)) continue;
        out.push({
          id: `f${i}:${e.kind || normalize(e.term)}`,
          term: slice.map(w => w.text).join(' '),
          kind: e.kind || 'propia',
          level: e.level === 'siempre' ? 'siempre' : 'revisar',
          reason: hit.reason,
          start: +slice[0].start.toFixed(3), end: +slice[slice.length - 1].end.toFixed(3),
          cutStart: r.start, cutEnd: r.end,
          approximate,
          // Se marca sola solo si es "segura" y el tiempo es confiable.
          suggested: e.level === 'siempre' && !approximate,
          context: words.slice(Math.max(0, i - 5), Math.min(words.length, i + hit.len + 6)).map(w => w.text).join(' '),
        });
        i += hit.len - 1;
        break;
      }
    }
    return out;
  }

  // Une los tramos marcados (si se tocan o casi) → lista de cortes ordenada.
  function fillerCuts(items, selectedIds) {
    const ids = new Set(selectedIds || []);
    const chosen = (items || []).filter(f => ids.has(f.id)).map(f => ({ start: f.cutStart, end: f.cutEnd })).sort((a, b) => a.start - b.start);
    const cuts = [];
    for (const c of chosen) {
      if (cuts.length && c.start <= cuts[cuts.length - 1].end + 0.04) cuts[cuts.length - 1].end = Math.max(cuts[cuts.length - 1].end, c.end);
      else cuts.push({ ...c });
    }
    return cuts;
  }

  // Quita los tramos de una lista de clips (ripple, igual que cutRange de app.js). Clips < 0.1 s se descartan.
  function removeFromClips(clips, cuts) {
    let out = (clips || []).map(c => ({ ...c }));
    for (const { start: a, end: b } of cuts || []) {
      const next = [];
      for (const c of out) {
        if (c.end <= a + 0.02 || c.start >= b - 0.02) { next.push(c); continue; }
        if (c.start < a - 0.02) next.push({ ...c, end: a });
        if (c.end > b + 0.02) next.push({ ...c, start: b });
      }
      out = next.filter(c => c.end - c.start > 0.1);
    }
    return out;
  }

  // ¿Ya está quitada? (su tramo no cae dentro de ningún clip conservado)
  function isRemoved(item, clips) {
    const mid = (item.start + item.end) / 2;
    return !(clips || []).some(c => mid >= c.start && mid <= c.end);
  }

  return { DEFAULT_FILLERS, normalize, tokenize, isFiller, findFillers, fillerCuts, removeFromClips, isRemoved, cutRange };
});
