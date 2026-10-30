'use strict';
// Cliente mínimo de la YouTube Data API v3 (solo lectura de datos PÚBLICOS con una API key).
// Cuota gratis: 10,000 unidades/día. search = 100 u; channels/playlistItems/videos = 1 u por llamada (hasta 50 ids).
const { normalizeVideo } = require('./research');

const BASE = 'https://www.googleapis.com/youtube/v3/';
const COST = { search: 100, channels: 1, playlistItems: 1, videos: 1 };

function friendlyError(status, body) {
  const reason = body?.error?.errors?.[0]?.reason || body?.error?.status || '';
  const msg = body?.error?.message || '';
  if (reason === 'quotaExceeded') return 'Se acabó la cuota gratis de YouTube por hoy (10,000 unidades). Se reinicia a la medianoche hora del Pacífico (~1-2 a. m. en CDMX).';
  if (/API_KEY_INVALID|keyInvalid|API key not valid/i.test(reason + ' ' + msg)) return 'La API key de YouTube no es válida. Revisa que la copiaste completa.';
  if (/accessNotConfigured|SERVICE_DISABLED|has not been used/i.test(reason + msg)) return 'Falta activar "YouTube Data API v3" en tu proyecto de Google Cloud (APIs y servicios → Biblioteca).';
  if (status === 403) return 'YouTube rechazó la petición (403): ' + (msg || reason);
  return 'YouTube respondió ' + status + (msg ? ': ' + msg.slice(0, 200) : '');
}

function createClient(key, onUnits = () => {}) {
  if (!key) throw Error('Falta la API key de YouTube. Pégala en "Conexión con YouTube".');
  async function get(endpoint, params) {
    const qs = new URLSearchParams({ ...params, key });
    const r = await fetch(BASE + endpoint + '?' + qs, { signal: AbortSignal.timeout(30000) });
    let body = null; try { body = await r.json(); } catch {}
    onUnits(r.ok ? (COST[endpoint] || 1) : 1); // las peticiones rechazadas (llave mala, etc.) cuestan como mucho 1
    if (!r.ok) throw Error(friendlyError(r.status, body));
    return body;
  }
  // Busca videos y devuelve los canales que los suben (con cuántos resultados aportó cada uno).
  async function searchChannels(query, order = 'relevance') {
    const j = await get('search', { part: 'snippet', q: query, type: 'video', maxResults: '50', order, regionCode: 'MX', relevanceLanguage: 'es' });
    return (j.items || []).map(it => ({ channelId: it.snippet?.channelId, channelTitle: it.snippet?.channelTitle, title: it.snippet?.title })).filter(x => x.channelId);
  }
  async function channelsByIds(ids) {
    const out = [];
    for (let i = 0; i < ids.length; i += 50) {
      const j = await get('channels', { part: 'snippet,statistics,contentDetails', id: ids.slice(i, i + 50).join(','), maxResults: '50' });
      out.push(...(j.items || []).map(normalizeChannel));
    }
    return out;
  }
  async function resolveChannel(ref) {
    const params = { part: 'snippet,statistics,contentDetails' };
    if (ref.id) params.id = ref.id; else if (ref.handle) params.forHandle = ref.handle; else if (ref.username) params.forUsername = ref.username; else return null;
    const j = await get('channels', params);
    return j.items?.[0] ? normalizeChannel(j.items[0]) : null;
  }
  // IDs de los últimos `max` videos del canal (la playlist de "uploads" incluye Shorts y directos).
  async function uploadIds(uploadsId, max = 150) {
    const ids = []; let pageToken = '';
    while (ids.length < max) {
      const j = await get('playlistItems', { part: 'contentDetails', playlistId: uploadsId, maxResults: '50', ...(pageToken ? { pageToken } : {}) });
      ids.push(...(j.items || []).map(it => it.contentDetails?.videoId).filter(Boolean));
      pageToken = j.nextPageToken; if (!pageToken) break;
    }
    return ids.slice(0, max);
  }
  async function videosByIds(ids) {
    const out = [];
    for (let i = 0; i < ids.length; i += 50) {
      const j = await get('videos', { part: 'snippet,statistics,contentDetails', id: ids.slice(i, i + 50).join(','), maxResults: '50' });
      out.push(...(j.items || []).map(normalizeVideo));
    }
    return out;
  }
  return { get, searchChannels, channelsByIds, resolveChannel, uploadIds, videosByIds };
}

function normalizeChannel(item) {
  const sn = item.snippet || {}, st = item.statistics || {};
  return {
    id: item.id,
    title: sn.title || '',
    handle: sn.customUrl || '',
    description: String(sn.description || '').slice(0, 600),
    thumb: sn.thumbnails?.default?.url || sn.thumbnails?.medium?.url || '',
    subs: st.hiddenSubscriberCount ? null : Number(st.subscriberCount) || 0,
    totalViews: Number(st.viewCount) || 0,
    videoCount: Number(st.videoCount) || 0,
    uploads: item.contentDetails?.relatedPlaylists?.uploads || '',
    createdAt: sn.publishedAt || '',
  };
}

module.exports = { createClient, COST };
