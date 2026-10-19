'use strict';

function normalize(value) {
  return String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('es-MX').replace(/[^a-z0-9ñ]+/g, ' ').trim();
}

function tokenizeTranscript(segments) {
  const words = [];
  for (const segment of segments) {
    const start = Number(segment.start);
    const end = Number(segment.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    const raw = String(segment.text ?? '').trim().split(/\s+/).filter(Boolean);
    if (!raw.length) continue;
    raw.forEach((text, index) => {
      const a = start + (end - start) * index / raw.length;
      const b = start + (end - start) * (index + 1) / raw.length;
      const wordDuration=b-a;
      words.push({ text, norm: normalize(text), start: a, end: b, approximate: raw.length > 1 || Boolean(segment.approximate) || wordDuration > .9 || wordDuration < .04 });
    });
  }
  return words.filter(w => w.norm);
}

function findMatches(segments, dictionary) {
  const words = tokenizeTranscript(segments);
  const entries = dictionary.filter(e => e.enabled && normalize(e.term)).map(e => ({ ...e, parts: normalize(e.term).split(' ') }));
  const matches = [];
  for (let i = 0; i < words.length; i++) {
    for (const entry of entries) {
      const slice = words.slice(i, i + entry.parts.length);
      if (slice.length !== entry.parts.length || !slice.every((word, j) => word.norm === entry.parts[j])) continue;
      matches.push({
        id: `${i}:${normalize(entry.term)}`,
        term: entry.term,
        note: entry.note || '',
        start: slice[0].start,
        end: slice.at(-1).end,
        approximate: slice.some(w => w.approximate),
        context: words.slice(Math.max(0, i - 6), Math.min(words.length, i + entry.parts.length + 7)).map(w => w.text).join(' ')
      });
    }
  }
  return matches.sort((a,b) => a.start - b.start || b.end - a.end);
}

function buildCuts(matches, selectedIds, duration, padding = 0.08) {
  const chosen = matches.filter(m => selectedIds.includes(m.id)).map(m => ({ start: Math.max(0, m.start - padding), end: Math.min(duration, m.end + padding) })).filter(c => c.end > c.start).sort((a,b) => a.start - b.start);
  const cuts = [];
  for (const cut of chosen) {
    if (cuts.length && cut.start <= cuts.at(-1).end + 0.04) cuts.at(-1).end = Math.max(cuts.at(-1).end, cut.end);
    else cuts.push({ ...cut });
  }
  return cuts;
}

function keptIntervals(cuts, duration) {
  const keep = [];
  let cursor = 0;
  for (const cut of cuts) {
    if (cut.start > cursor + 0.015) keep.push({ start: cursor, end: cut.start });
    cursor = Math.max(cursor, cut.end);
  }
  if (duration > cursor + 0.015) keep.push({ start: cursor, end: duration });
  return keep;
}

function adjustedCuts(matches, selectedIds, duration, words, adjustments={}, extraCuts=[]) {
  const ids=new Set(selectedIds);
  const chosen=matches.filter(m=>ids.has(m.id)).map(m=>{
    const override=adjustments[m.id];
    if(override && Number.isFinite(override.start) && Number.isFinite(override.end)) return {id:m.id,start:override.start,end:override.end};
    const previous=words.filter(w=>w.end<=m.start+.001).at(-1);
    const next=words.find(w=>w.start>=m.end-.001);
    const before=previous?Math.max(0,m.start-previous.end):.12;
    const after=next?Math.max(0,next.start-m.end):.12;
    return {id:m.id,start:m.start-Math.min(.06,before/2),end:m.end+Math.min(.06,after/2)};
  });
  for(const cut of extraCuts) chosen.push({id:cut.id,start:cut.start,end:cut.end});
  const valid=chosen.filter(c=>Number.isFinite(c.start)&&Number.isFinite(c.end)).map(c=>({start:+Math.max(0,c.start).toFixed(3),end:+Math.min(duration,c.end).toFixed(3)})).filter(c=>c.end>c.start).sort((a,b)=>a.start-b.start);
  const merged=[];
  for(const cut of valid) {
    if(merged.length&&cut.start<=merged.at(-1).end+.03) merged.at(-1).end=Math.max(merged.at(-1).end,cut.end);
    else merged.push({...cut});
  }
  return merged;
}

function parseSrt(input) {
  return String(input).replace(/\r/g, '').split(/\n\s*\n/).map(block => {
    const lines = block.split('\n').filter(Boolean);
    const idx = lines.findIndex(l => /-->/.test(l));
    if (idx < 0) return null;
    const [a,b] = lines[idx].split(/\s*-->\s*/);
    const time = s => { const m = s.match(/(\d+):(\d+):(\d+)[,.](\d+)/); return m ? +m[1]*3600 + +m[2]*60 + +m[3] + +m[4]/1000 : NaN; };
    return { start: time(a), end: time(b), text: lines.slice(idx+1).join(' ').replace(/<[^>]*>/g, '') , approximate: true };
  }).filter(Boolean);
}

function parseWhisperJson(obj) {
  const list = Array.isArray(obj.transcription) ? obj.transcription : Array.isArray(obj.segments) ? obj.segments : [];
  return list.map(item => {
    if (item.offsets) return { start: Number(item.offsets.from) / 1000, end: Number(item.offsets.to) / 1000, text: item.text, approximate: false };
    return { start: Number(item.start), end: Number(item.end), text: item.text, approximate: Boolean(item.approximate) };
  }).filter(s => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start);
}

module.exports = { normalize, tokenizeTranscript, findMatches, buildCuts, keptIntervals, adjustedCuts, parseSrt, parseWhisperJson };
