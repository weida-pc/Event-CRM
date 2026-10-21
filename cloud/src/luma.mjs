import { Fault, requireThat, eventUrl, eventDetail } from './core.mjs';

export async function boundedBody(response, max = 2_000_000) {
  const reader = response.body?.getReader();
  requireThat(reader, 'empty_response', 502);
  let size = 0; const chunks = [];
  try {
    for (;;) {
      const {done,value} = await reader.read(); if (done) break;
      size += value.length; requireThat(size <= max, 'response_too_large', 502); chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}
export function lumaClient(key, fetcher = fetch) {
  requireThat(typeof key === 'string' && key.length >= 16 && key.length <= 500 && !/[\s\r\n]/.test(key), 'invalid_luma_key');
  return async function get(path, params = {}) {
    requireThat(['/v1/calendars/get', '/v1/calendars/events/list', '/v1/events/get', '/v1/events/guests/list'].includes(path), 'forbidden_provider_request');
    const url = new URL(path, 'https://public-api.luma.com');
    for (const [k,v] of Object.entries(params)) if (v != null) url.searchParams.set(k, String(v));
    let response;
    try { response = await fetcher(url.href, {method:'GET', headers:{'x-luma-api-key':key, Accept:'application/json'},
      redirect:'manual', signal:AbortSignal.timeout(12000)}); } catch { throw new Fault('provider_unavailable', 502); }
    if ([401,403].includes(response.status)) throw new Fault('luma_reconnect_required', 403);
    if (response.status === 429) throw new Fault('luma_rate_limited', 429,
      Math.min(3600, Math.max(60, Number(response.headers.get('retry-after')) || 60)));
    requireThat(response.ok, 'provider_unavailable', 502);
    try { return JSON.parse(new TextDecoder().decode(await boundedBody(response))); }
    catch (e) { if (e instanceof Fault) throw e; throw new Fault('invalid_provider_response', 502); }
  };
}
export async function resolveEvent(get, link) {
  const expected = eventUrl(link), calendar = await get('/v1/calendars/get');
  requireThat(/^cal-[\w-]+$/.test(calendar.id), 'invalid_calendar', 502);
  const seen = new Set(); let cursor;
  for (let page = 0; page < 20; page++) {
    const result = await get('/v1/calendars/events/list', {pagination_limit:100, pagination_cursor:cursor, access:'manage', platforms:'luma'});
    requireThat(Array.isArray(result.entries) && result.entries.length <= 100, 'invalid_event_page', 502);
    const matches = result.entries.filter(e => { try { return eventUrl(e.url) === expected; } catch { return false; } });
    requireThat(matches.length <= 1, 'ambiguous_event', 502);
    if (matches.length) return eventDetail(await get('/v1/events/get', {event_id:matches[0].id}), calendar.id, expected);
    if (result.has_more === false) throw new Fault('event_not_in_calendar', 404);
    requireThat(result.has_more === true && typeof result.next_cursor === 'string' && result.next_cursor
      && !seen.has(result.next_cursor), 'invalid_pagination', 502);
    cursor = result.next_cursor; seen.add(cursor);
  }
  throw new Fault('calendar_page_limit', 422);
}
