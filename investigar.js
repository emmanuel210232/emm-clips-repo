'use strict';
// ===== 🔍 INVESTIGAR COMPETENCIA (pestaña aparte) =====
// Usa $, api y notice de app.js. Todo el estado vive en el servidor (data/research.json).
let rsState = null, rsFormat = 'long', rsShowIgnored = false, rsPoll = null, rsNotesVal = '', rsModels = {};
const rsEsc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const rsNum = n => n == null ? '—' : n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + ' M' : n >= 1e3 ? (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + ' k' : String(Math.round(n));
const rsDur = s => s >= 3600 ? `${Math.floor(s / 3600)}:${String(Math.floor(s % 3600 / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
const rsHour = h => `${((h + 11) % 12) + 1} ${h < 12 ? 'a. m.' : 'p. m.'}`;
const rsPct = x => Math.round((x || 0) * 100) + '%';
const RS_DAYS = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];

async function rsLoad() { rsState = await (await fetch('/api/research')).json(); return rsState; }
async function openResearch() { try { await rsLoad(); rsRender(); rsWatch(); } catch (e) { notice(e.message, true); } }
function rsWatch() {
  if (rsPoll) return;
  rsPoll = setInterval(async () => {
    if (!document.body.classList.contains('research-mode')) return;
    const was = rsState?.job?.status;
    if (was !== 'running') return;
    try {
      await rsLoad();
      const j = rsState.job;
      if (j.status === 'running') { rsRenderJob(); return; }
      rsRender();
      if (j.status === 'done') notice('✅ ' + j.message); else if (j.status === 'error') notice(j.message, true);
    } catch {}
  }, 1000);
}
async function rsAction(url, body, okMsg) {
  try {
    rsState = await api(url, body || {});
    rsRender();
    if (okMsg) notice(okMsg);
  } catch (e) { notice(e.message, true); }
}
function rsCopy(text, btn) {
  const done = () => { if (btn) { const t = btn.textContent; btn.textContent = '✅ Copiado'; setTimeout(() => btn.textContent = t, 1400); } };
  (navigator.clipboard?.writeText(text) || Promise.reject()).then(done).catch(() => { const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); done(); } catch {} ta.remove(); });
}

function rsRenderJob() {
  const box = $('rsJob'); if (!box) return;
  const j = rsState.job;
  box.hidden = j.status !== 'running';
  if (j.status === 'running') { box.querySelector('.rsJobMsg').textContent = j.message || 'Trabajando…'; box.querySelector('.jobFill').style.width = (j.percent || 3) + '%'; }
  document.querySelectorAll('#rsRoot [data-busy]').forEach(b => b.disabled = j.status === 'running');
}

function rsRender() {
  const root = $('rsRoot'); if (!root || !rsState) return;
  const s = rsState, running = s.job.status === 'running';
  const tracked = s.channels.filter(c => c.status === 'track' || c.mine).length;
  root.innerHTML = `
  <div id="rsJob" class="jobBar rsJobBar" ${running ? '' : 'hidden'}><div class="jobBarHead"><span class="jobLabel rsJobMsg">${rsEsc(s.job.message)}</span></div><div class="jobTrack"><div class="jobFill" style="width:${s.job.percent || 3}%"></div></div></div>
  ${rsKeyCard(s)}
  ${s.keySet ? rsChannelsCard(s, tracked) : ''}
  ${s.analysis && s.analysis.totals.videos ? rsResultsCard(s.analysis) : ''}
  ${s.analysis && s.analysis.totals.videos ? rsInsightsCard(s) : ''}
  ${rsGenerateCard(s)}`;
  rsBind();
  rsRenderJob();
}

// ---------- 1. Conexión ----------
function rsKeyCard(s) {
  if (s.keySet) return `<div class="card rsCompact"><div class="row wrap" style="justify-content:space-between;gap:10px">
    <div class="row" style="gap:10px"><span class="number">1</span><b>Conexión con YouTube</b><span class="status">✅ Conectado</span></div>
    <div class="row wrap" style="gap:10px"><span class="muted">Cuota de hoy: <b>${s.quota.units.toLocaleString('es-MX')}</b> / 10,000 unidades</span><button class="secondary compact" id="rsKeyChange" type="button">Cambiar llave</button></div></div>
    <div id="rsKeyEdit" hidden style="margin-top:12px">${rsKeyForm()}</div></div>`;
  return `<div class="card"><div class="cardhead"><div><span class="number">1</span><h2>Conexión con YouTube</h2></div><span class="status">Sin conectar</span></div>
    <p class="hint">Para leer los datos públicos de los canales necesitas una <b>API key gratis de YouTube</b> (una sola vez, ~5 min). Da para revisar decenas de canales al día sin costo.</p>
    <ol class="rsSteps">
      <li>Entra a <a href="https://console.cloud.google.com/projectcreate" target="_blank" rel="noopener">Google Cloud → Nuevo proyecto</a>, ponle “Emm Clips” y créalo.</li>
      <li>Abre <a href="https://console.cloud.google.com/apis/library/youtube.googleapis.com" target="_blank" rel="noopener">YouTube Data API v3</a> (con ese proyecto seleccionado) y dale <b>Habilitar</b>.</li>
      <li>Ve a <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noopener">Credenciales</a> → <b>Crear credenciales → Clave de API</b>.</li>
      <li>Recomendado: en la clave, “Restringir clave” → solo <b>YouTube Data API v3</b>.</li>
      <li>Copia la clave y pégala aquí abajo.</li>
    </ol>
    ${rsKeyForm()}</div>`;
}
function rsKeyForm() {
  return `<div class="row wrap" style="gap:8px"><input id="rsKey" type="password" placeholder="Pega tu API key de YouTube (AIza…)" autocomplete="off" style="flex:1;min-width:240px">
    <button id="rsKeySave" class="primary" type="button">Guardar y probar</button></div>
    <p class="muted" style="margin:8px 0 0">Se guarda SOLO en tu PC (data/youtube.json). No entra al instalador ni se sube a ningún lado.</p>`;
}

// ---------- 2. Canales ----------
function rsChannelsCard(s, tracked) {
  const list = s.channels.filter(c => rsShowIgnored || c.status !== 'ignore');
  const ignored = s.channels.filter(c => c.status === 'ignore').length;
  const pending = s.channels.filter(c => c.status === 'pending' && !c.mine).length;
  const rows = list.map(c => {
    const st = c.mine ? 'mine' : c.status;
    return `<div class="rsCh ${st}">
      ${c.thumb ? `<img class="rsAvatar" src="${rsEsc(c.thumb)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : '<span class="rsAvatar"></span>'}
      <div class="rsChMain">
        <div class="rsChTitle"><a href="https://www.youtube.com/channel/${rsEsc(c.id)}" target="_blank" rel="noopener">${rsEsc(c.title)}</a>${c.mine ? ' <span class="rsTag mine">⭐ Mi canal</span>' : ''}${st === 'pending' ? ' <span class="rsTag warn">¿Es de Shifu?</span>' : ''}</div>
        <div class="muted">${c.subs == null ? 'subs ocultos' : rsNum(c.subs) + ' subs'} · ${rsNum(c.videoCount)} videos${c.hits ? ` · salió ${c.hits}× en la búsqueda` : ''}${c.analyzed ? ` · ${c.analyzed} analizados` : ''}${c.analyzed && c.shifuShare != null && !c.dedicated ? ' · canal general (solo videos de Shifu)' : ''}</div>
        ${st === 'pending' && c.samples?.length ? `<div class="muted rsSamples">Ej.: ${c.samples.map(t => '“' + rsEsc(t) + '”').join(' · ')}</div>` : ''}
      </div>
      <div class="rsChActs">
        <button type="button" class="tl-btn ${c.status === 'track' && !c.mine ? 'active' : ''}" data-ch="${rsEsc(c.id)}" data-st="track">Seguir</button>
        <button type="button" class="tl-btn ${c.status === 'ignore' ? 'active' : ''}" data-ch="${rsEsc(c.id)}" data-st="ignore">Ignorar</button>
        <button type="button" class="tl-btn ${c.mine ? 'active' : ''}" data-ch="${rsEsc(c.id)}" data-mine="${c.mine ? '0' : '1'}" title="Marcar como mi canal (se compara aparte)">⭐</button>
      </div></div>`;
  }).join('');
  const when = s.refreshedAt ? new Date(s.refreshedAt).toLocaleString('es-MX', { dateStyle: 'medium', timeStyle: 'short' }) : 'nunca';
  return `<div class="card"><div class="cardhead"><div><span class="number">2</span><h2>Canales</h2></div><span class="status">${tracked} en seguimiento</span></div>
    <div class="row wrap" style="gap:8px">
      <button id="rsDiscover" class="primary" type="button" data-busy>🔎 Buscar canales de Shifu</button>
      <span class="muted">Busca “Adriano Zendejas”, “Maestro Shifu”, “Shifu Kick”… (usa ~500 de las 10,000 unidades del día)</span>
    </div>
    <div class="row wrap" style="gap:8px;margin-top:10px">
      <input id="rsAddInput" type="text" placeholder="Agregar canal: link del canal o @usuario" style="flex:1;min-width:220px">
      <button id="rsAdd" class="secondary" type="button">➕ Agregar</button>
      <button id="rsAddMine" class="secondary" type="button" title="Tu canal se compara aparte, no se mezcla con la competencia">⭐ Es mi canal</button>
    </div>
    ${pending ? `<p class="hint" style="margin:12px 0 0">Hay <b>${pending}</b> canal(es) por revisar (“¿Es de Shifu?”): dales <b>Seguir</b> si resuben a Shifu o <b>Ignorar</b> si no.</p>` : ''}
    <div class="rsChList">${rows || '<p class="muted" style="padding:14px">Aún no hay canales. Dale a “Buscar canales de Shifu” o agrega uno.</p>'}</div>
    ${ignored ? `<button type="button" class="linkBtn" id="rsToggleIgnored">${rsShowIgnored ? 'Ocultar' : 'Mostrar'} ${ignored} ignorado(s)</button>` : ''}
    <div class="row wrap rsRefreshRow">
      <button id="rsRefresh" class="primary big" type="button" data-busy ${tracked ? '' : 'disabled'}>🔄 Actualizar datos de ${tracked} canal(es)</button>
      <label class="muted">Videos por canal <select id="rsMax"><option value="150">últimos 150</option><option value="300">últimos 300</option><option value="500">últimos 500</option></select></label>
      <span class="muted">Última actualización: ${when}. Actualiza cada semana para ver qué sigue creciendo.</span>
    </div></div>`;
}

// ---------- 3. Resultados ----------
function rsResultsCard(a) {
  const f = a[rsFormat];
  const other = rsFormat === 'long' ? 'short' : 'long';
  const tabs = `<div class="rsTabs"><button type="button" class="tl-btn ${rsFormat === 'long' ? 'active' : ''}" data-fmt="long">🎬 Videos largos (${a.long.count})</button><button type="button" class="tl-btn ${rsFormat === 'short' ? 'active' : ''}" data-fmt="short">📱 Shorts (${a.short.count})</button></div>`;
  if (!f.count) return `<div class="card"><div class="cardhead"><div><span class="number">3</span><h2>Lo que pegó</h2></div></div>${tabs}<p class="muted">No hay ${rsFormat === 'long' ? 'videos largos' : 'Shorts'} suficientes en los canales que sigues.${a[other].count ? ' Revisa la otra pestaña.' : ''}</p></div>`;
  const bw = f.time.bestWindows[0];
  const kpis = `<div class="rsKpis">
    <div><b>${f.count}</b><span>videos analizados</span></div>
    <div><b>${rsNum(f.medianViews)}</b><span>vistas (mediana)</span></div>
    <div><b>${bw ? rsHour(bw.from) + '–' + rsHour(bw.to) : '—'}</b><span>mejor ventana (CDMX)</span></div>
    ${f.mineCount ? `<div><b>${rsNum(f.mineMedianViews)}</b><span>tu mediana (${f.mineCount} videos)</span></div>` : ''}
  </div>`;
  const vcard = v => `<a class="rsVid" href="https://www.youtube.com/watch?v=${rsEsc(v.id)}" target="_blank" rel="noopener" title="${rsEsc(v.title)}">
    <div class="rsThumb"><img src="${rsEsc(v.thumbSmall || v.thumb)}" alt="" loading="lazy" referrerpolicy="no-referrer"><span class="rsScore ${v.score >= 3 ? 'hot' : ''}">×${v.score}</span><span class="rsDurB">${rsDur(v.duration)}</span></div>
    <div class="rsVidT">${rsEsc(v.title)}</div>
    <div class="muted">${rsEsc(v.channelTitle)}</div>
    <div class="muted">${rsNum(v.views)} vistas · ${rsNum(v.vpd)}/día · ${v.day} ${rsHour(v.hour)}${v.sampleSmall ? ' · <span title="Ese canal tiene pocos videos de este formato: su ×score es menos confiable">⚠️</span>' : ''}</div></a>`;
  // Mapa de calor: el color = score mediano (qué tan bien les fue), el número = cuántos videos se subieron ahí.
  const grid = f.time.grid;
  const hm = `<div class="rsHeat"><div></div>${Array.from({ length: 24 }, (_, h) => `<div class="rsHh">${h % 3 === 0 ? h : ''}</div>`).join('')}
    ${grid.map((row, d) => `<div class="rsHd">${RS_DAYS[d]}</div>${row.map((c, h) => `<div class="rsHc" style="--a:${c.n ? Math.min(1, 0.15 + c.score / 3) : 0}" title="${RS_DAYS[d]} ${rsHour(h)}: ${c.n} video(s), score mediano ×${c.score}">${c.n || ''}</div>`).join('')}`).join('')}</div>`;
  const byDay = f.time.byDay.map(d => `<div class="rsBar"><span>${d.day}</span><div><i style="width:${Math.min(100, d.score / Math.max(...f.time.byDay.map(x => x.score), 1) * 100)}%"></i></div><b>×${d.score}</b><small>${d.n}</small></div>`).join('');
  const t = f.titles;
  const row = (label, k, fmt = x => x) => `<tr><td>${label}</td><td><b>${fmt(t.top[k])}</b></td><td>${fmt(t.rest[k])}</td>${t.mine ? `<td>${fmt(t.mine[k])}</td>` : ''}</tr>`;
  const titleTable = `<table class="rsTable"><thead><tr><th></th><th>Los que pegan (top 25 %)</th><th>El resto</th>${t.mine ? '<th>Los tuyos</th>' : ''}</tr></thead><tbody>
    ${row('Largo (caracteres)', 'length')}${row('Palabras en MAYÚSCULAS', 'capsWords')}${row('% de letras en mayúscula', 'capsRatio', rsPct)}${row('Emojis', 'emojis')}
    ${row('Con números', 'hasNumber', rsPct)}${row('Mencionan dinero ($, mil…)', 'hasMoney', rsPct)}${row('Con ¿pregunta?', 'hasQuestion', rsPct)}${row('Con ¡exclamación!', 'hasExclaim', rsPct)}
    ${row('Con separador ( | • – )', 'hasSeparator', rsPct)}${row('Dicen “Shifu/Zendejas”', 'mentionsShifu', rsPct)}${row('Hashtags', 'hashtags')}</tbody></table>`;
  const words = f.words.length ? f.words.map(w => `<span class="rsChip" title="En ${w.top} de los que pegan vs ${w.rest} del resto">${rsEsc(w.word)} <b>×${w.lift}</b></span>`).join('') : '<span class="muted">Aún no hay suficientes videos para ver palabras con patrón.</span>';
  const tags = f.hashtags.length ? f.hashtags.map(h => `<span class="rsChip" title="${h.uses} usos, ${h.inTop} en los que pegan">${rsEsc(h.tag)} <b>${h.inTop}/${h.uses}</b></span>`).join('') : '<span class="muted">Casi nadie usa hashtags en este formato.</span>';
  const durs = f.durations.map(d => `<div class="rsBar"><span>${d.bucket}</span><div><i style="width:${Math.min(100, d.score / Math.max(...f.durations.map(x => x.score), 1) * 100)}%"></i></div><b>×${d.score}</b><small>${d.n}</small></div>`).join('');
  return `<div class="card"><div class="cardhead"><div><span class="number">3</span><h2>Lo que pegó</h2></div><span class="status">${a.channels.length} canales</span></div>
    ${tabs}${kpis}
    <p class="hint"><b>×score</b> = cuántas veces más vistas que lo normal de <i>su propio canal</i>. ×5 = le fue 5 veces mejor que de costumbre: eso es lo que hay que estudiar.</p>
    <div class="rsVids">${f.outliers.slice(0, 24).map(vcard).join('')}</div>
    <details class="rsMore"><summary>Ver los que PEOR les fue (para comparar)</summary><div class="rsVids" style="margin-top:12px">${f.flops.map(vcard).join('')}</div></details>

    <h3 class="rsH3">🕒 ¿A qué hora suben y cuándo pega más? <small>(hora CDMX)</small></h3>
    <p class="hint">Número = videos subidos en esa hora. Más verde = les fue mejor (score mediano).</p>
    ${hm}
    <div class="rsTwo">
      <div><h4>Mejores ventanas de 3 h</h4>${f.time.bestWindows.length ? f.time.bestWindows.map(w => `<div class="rsLine">🟢 <b>${rsHour(w.from)} – ${rsHour(w.to)}</b> · ×${w.score} <span class="muted">(${w.n} videos)</span></div>`).join('') : '<span class="muted">Faltan datos.</span>'}
        ${f.mineTime.length ? `<h4 style="margin-top:12px">Tus horas de subida</h4>${f.mineTime.map(h => `<span class="rsChip">${rsHour(h.hour)} <b>${h.n}</b></span>`).join('')}` : ''}</div>
      <div><h4>Por día</h4>${byDay}</div>
    </div>

    <h3 class="rsH3">✍️ Títulos</h3>
    ${titleTable}
    <h4 style="margin-top:14px">Palabras que más aparecen en los que pegan</h4><div class="rsChips">${words}</div>

    <div class="rsTwo" style="margin-top:16px">
      <div><h3 class="rsH3" style="margin-top:0">#️⃣ Hashtags</h3><p class="hint" style="margin-bottom:8px">en los que pegan / usos totales</p><div class="rsChips">${tags}</div></div>
      <div><h3 class="rsH3" style="margin-top:0">⏱️ Duración</h3>${durs}</div>
    </div></div>`;
}

// ---------- 4. Fórmula IA ----------
const RS_MODELS = `<option value="claude-opus-5-5">Opus 5.5 (mejor calidad)</option><option value="claude-sonnet-5-5">Sonnet 5.5 (buen valor)</option><option value="claude-haiku-4-5">Haiku (más barato)</option>`;
function rsList(arr) { return Array.isArray(arr) && arr.length ? `<ul class="rsUl">${arr.map(x => `<li>${rsEsc(x)}</li>`).join('')}</ul>` : '<p class="muted">—</p>'; }
function rsInsightsCard(s) {
  const i = s.insights;
  const head = `<div class="card"><div class="cardhead"><div><span class="number">4</span><h2>🧠 Fórmula del nicho (IA)</h2></div>${i ? `<span class="status">${new Date(i.createdAt).toLocaleDateString('es-MX')} · ${i.basedOn} videos</span>` : ''}</div>
    <p class="hint">La IA de la nube revisa los números de arriba y <b>VE las miniaturas</b> que más pegaron (y las que no) para sacar la fórmula: títulos, miniaturas, horarios, descripción, hashtags y cómo diferenciarte para la monetización.</p>
    <div class="row wrap" style="gap:8px"><label class="muted">Motor <select id="rsInsModel">${RS_MODELS}</select></label><button id="rsInsights" class="primary" type="button" data-busy ${s.cloud.keySet ? '' : 'disabled'}>${i ? '🔁 Volver a analizar' : '🧠 Sacar la fórmula'}</button>
    ${s.cloud.keySet ? '' : '<span class="muted">⚠️ Falta la API key de Claude: pégala en 🎬 Resumen del directo → Motor de IA.</span>'}</div>`;
  if (!i) return head + '</div>';
  const sec = (t, body) => `<div class="rsIns"><h4>${t}</h4>${body}</div>`;
  return head + `<div class="rsInsResumen">${rsEsc(i.resumen)}</div>
    <div class="rsInsGrid">
      ${sec('✍️ Títulos que pegan', rsList(i.titulos?.patrones) + (i.titulos?.plantillas?.length ? '<b class="rsSub">Plantillas</b>' + rsList(i.titulos.plantillas) : '') + (i.titulos?.evitar?.length ? '<b class="rsSub">Evitar</b>' + rsList(i.titulos.evitar) : ''))}
      ${sec('🖼️ Miniaturas', rsList(i.miniaturas?.patrones) + (i.miniaturas?.evitar?.length ? '<b class="rsSub">Evitar</b>' + rsList(i.miniaturas.evitar) : '') + (i.miniaturas?.promptBase ? `<b class="rsSub">Prompt base para ChatGPT</b><pre class="rsPre">${rsEsc(i.miniaturas.promptBase)}</pre><button type="button" class="secondary compact" data-copy="${rsEsc(i.miniaturas.promptBase)}">📋 Copiar prompt</button>` : ''))}
      ${sec('🕒 Horarios', rsList(i.horarios?.mejores) + (i.horarios?.explicacion ? `<p class="muted">${rsEsc(i.horarios.explicacion)}</p>` : ''))}
      ${sec('📝 Descripción', rsList(i.descripcion?.estructura) + (i.descripcion?.ejemplo ? `<pre class="rsPre">${rsEsc(i.descripcion.ejemplo)}</pre>` : ''))}
      ${sec('#️⃣ Hashtags', `<div class="rsChips">${(i.hashtags || []).map(h => `<span class="rsChip">${rsEsc(h)}</span>`).join('')}</div>`)}
      ${sec('⏱️ Duración', `<p><b>Largos:</b> ${rsEsc(i.duracion?.largos || '—')}</p><p><b>Shorts:</b> ${rsEsc(i.duracion?.shorts || '—')}</p>`)}
      ${sec('🔥 Temas que pegan', rsList(i.temas))}
      ${sec('💰 Para la monetización (valor original)', rsList(i.monetizacion))}
      ${i.comparacionMiCanal?.length ? sec('⭐ Tú vs lo que pega', rsList(i.comparacionMiCanal)) : ''}
      ${sec('🚀 Oportunidades', rsList(i.oportunidades))}
    </div></div>`;
}

// ---------- 5. Generar para mi video ----------
function rsGenerateCard(s) {
  const g = s.generated;
  const head = `<div class="card"><div class="cardhead"><div><span class="number">${s.analysis ? 5 : '★'}</span><h2>✍️ Títulos, descripción y miniatura para MI video</h2></div><span class="status">${s.video ? '🎞️ ' + rsEsc(s.video.length > 40 ? s.video.slice(0, 38) + '…' : s.video) : 'Sin video abierto'}</span></div>
    <p class="hint">Lee la transcripción del video que tienes abierto${s.insights ? ' y sigue la <b>fórmula del nicho</b>' : s.analysis ? ' y los títulos que más pegaron de la competencia' : ''}. ${s.insights ? '' : '<b>Tip:</b> saca primero la fórmula (paso 4) para que salga mejor.'}</p>
    <div class="row wrap" style="gap:12px;margin-bottom:10px">
      <label class="inlineCheck"><input type="checkbox" id="rsUseT" ${s.hasTranscript ? 'checked' : 'disabled'}> Usar la transcripción del video abierto ${s.hasTranscript ? '' : '<span class="muted">(no hay)</span>'}</label>
      <label class="muted">Para <select id="rsGenFmt"><option value="long">Video largo</option><option value="short">Short</option></select></label>
      <label class="muted">Motor <select id="rsGenModel">${RS_MODELS}</select></label>
    </div>
    <textarea id="rsNotes" class="rsNotes" rows="3" placeholder="Opcional: lo que la transcripción no dice. Ej.: “van en jet privado a Miami a ver a Jay Wheeler; primer stream en el aire”, invitados, lugar…">${rsEsc(rsNotesVal)}</textarea>
    <div class="row" style="margin-top:10px"><button id="rsGenerate" class="primary big" type="button" data-busy ${s.cloud.keySet ? '' : 'disabled'}>✨ Generar</button>${s.cloud.keySet ? '' : '<span class="muted">⚠️ Falta la API key de Claude (🎬 Resumen del directo → Motor de IA).</span>'}</div>`;
  if (!g) return head + '</div>';
  const rec = Number.isInteger(g.recomendado) ? g.recomendado : 0;
  const titles = (g.titulos || []).map((t, i) => `<div class="rsTitle ${i === rec ? 'rec' : ''}"><div><b>${i === rec ? '⭐ ' : ''}${rsEsc(t.titulo)}</b><div class="muted">${rsEsc(t.porque || '')} · ${String(t.titulo || '').length} caracteres</div></div><button type="button" class="secondary compact" data-copy="${rsEsc(t.titulo)}">📋</button></div>`).join('');
  const hashtags = (g.hashtags || []).join(' ');
  const tags = (g.tags || []).join(', ');
  return head + `<div class="rsGen">
    <div class="rsGenMeta muted">${g.format === 'short' ? '📱 Short' : '🎬 Video largo'}${g.video ? ' · ' + rsEsc(g.video) : ''} · ${new Date(g.createdAt).toLocaleString('es-MX', { dateStyle: 'short', timeStyle: 'short' })}${g.usedInsights ? ' · usó la fórmula del nicho' : ''}</div>
    ${g.resumen ? `<p>${rsEsc(g.resumen)}</p>` : ''}
    <h4>🎬 Títulos</h4>${titles}
    <h4>📝 Descripción <button type="button" class="secondary compact" data-copy="${rsEsc(g.descripcion || '')}">📋 Copiar</button></h4><pre class="rsPre">${rsEsc(g.descripcion || '')}</pre>
    <div class="rsTwo">
      <div><h4>#️⃣ Hashtags <button type="button" class="secondary compact" data-copy="${rsEsc(hashtags)}">📋</button></h4><div class="rsChips">${(g.hashtags || []).map(h => `<span class="rsChip">${rsEsc(h)}</span>`).join('')}</div></div>
      <div><h4>🏷️ Tags (YouTube Studio) <button type="button" class="secondary compact" data-copy="${rsEsc(tags)}">📋</button></h4><p class="muted">${rsEsc(tags)}</p></div>
    </div>
    <h4>🖼️ Prompt de miniatura para ChatGPT <button type="button" class="secondary compact" data-copy="${rsEsc(g.miniaturaPrompt || '')}">📋 Copiar</button></h4><pre class="rsPre">${rsEsc(g.miniaturaPrompt || '')}</pre>
    ${g.textoMiniatura?.length ? `<p><b>Texto para la mini:</b> ${g.textoMiniatura.map(t => `<span class="rsChip">${rsEsc(t)}</span>`).join('')}</p>` : ''}
    ${g.miniaturaAlternativa ? `<p><b>Alternativa:</b> ${rsEsc(g.miniaturaAlternativa)}</p>` : ''}
    ${g.horaSugerida ? `<p>🕒 <b>Cuándo subirlo:</b> ${rsEsc(g.horaSugerida)}</p>` : ''}
    ${g.shorts?.length ? `<h4>📱 Ideas de Shorts de este video</h4>${rsList(g.shorts)}` : ''}
  </div></div>`;
}

function rsBind() {
  const on = (id, fn) => { const el = $(id); if (el) el.onclick = fn; };
  on('rsKeyChange', () => { const e = $('rsKeyEdit'); if (e) e.hidden = !e.hidden; });
  on('rsKeySave', async () => { const k = $('rsKey').value.trim(); if (!k) return notice('Pega la API key primero.', true); const b = $('rsKeySave'); b.disabled = true; b.textContent = 'Probando…'; await rsAction('/api/research/key', { key: k }, '✅ API key de YouTube guardada y funcionando.'); });
  on('rsDiscover', () => rsAction('/api/research/discover', {}).then(rsWatch));
  const add = mine => { const v = $('rsAddInput').value.trim(); if (!v) return notice('Pega el link del canal o su @usuario.', true); rsAction('/api/research/channel', { input: v, mine }, mine ? '⭐ Tu canal quedó marcado: se compara aparte.' : '✅ Canal agregado. Dale a “Actualizar datos”.'); };
  on('rsAdd', () => add(false)); on('rsAddMine', () => add(true));
  on('rsToggleIgnored', () => { rsShowIgnored = !rsShowIgnored; rsRender(); });
  on('rsRefresh', () => rsAction('/api/research/refresh', { max: Number($('rsMax').value) || 150 }).then(rsWatch));
  on('rsInsights', () => rsAction('/api/research/insights', { model: $('rsInsModel').value }).then(rsWatch));
  on('rsGenerate', () => rsAction('/api/research/generate', { model: $('rsGenModel').value, format: $('rsGenFmt').value, notes: $('rsNotes').value, useTranscript: !!$('rsUseT')?.checked }).then(rsWatch));
  document.querySelectorAll('#rsRoot [data-ch]').forEach(b => b.onclick = () => rsAction('/api/research/channel/status', b.dataset.mine != null ? { id: b.dataset.ch, mine: b.dataset.mine === '1' } : { id: b.dataset.ch, status: b.dataset.st }));
  document.querySelectorAll('#rsRoot [data-fmt]').forEach(b => b.onclick = () => { rsFormat = b.dataset.fmt; rsRender(); });
  document.querySelectorAll('#rsRoot [data-copy]').forEach(b => b.onclick = () => rsCopy(b.dataset.copy, b));
  // Conserva lo que el usuario eligió/escribió aunque la pantalla se redibuje.
  const cm = rsState?.cloud?.model;
  ['rsInsModel', 'rsGenModel'].forEach(id => { const el = $(id); if (!el) return; const want = rsModels[id] || cm; if (want && [...el.options].some(o => o.value === want)) el.value = want; el.onchange = () => { rsModels[id] = el.value; }; });
  const n = $('rsNotes'); if (n) n.oninput = () => { rsNotesVal = n.value; };
  const gf = $('rsGenFmt'); if (gf) { gf.value = rsModels.fmt || 'long'; gf.onchange = () => { rsModels.fmt = gf.value; }; }
}
if (document.body.classList.contains('research-mode')) openResearch();
