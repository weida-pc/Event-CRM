import {Fault, requireThat} from './core.mjs';
import {boundedBody} from './luma.mjs';

const encoder = new TextEncoder();
export function token() {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    .replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
}
export async function hash(value) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(value))))
    .map(b=>b.toString(16).padStart(2,'0')).join('');
}
async function encryptionKey(secret) {
  requireThat(typeof secret === 'string' && secret.length >= 43,'server_not_configured',503);
  return crypto.subtle.importKey('raw',await crypto.subtle.digest('SHA-256',encoder.encode(secret)), 'AES-GCM',false,['encrypt','decrypt']);
}
export async function encrypt(value, secret, workspace) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const bytes = await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:encoder.encode(workspace)},await encryptionKey(secret),encoder.encode(value));
  return {v:1, iv:Array.from(iv), bytes:Array.from(new Uint8Array(bytes))};
}
export async function decrypt(value, secret, workspace) {
  try {
    requireThat(value?.v === 1,'credential_unavailable',503);
    return new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:new Uint8Array(value.iv),additionalData:encoder.encode(workspace)},
      await encryptionKey(secret),new Uint8Array(value.bytes)));
  } catch { throw new Fault('credential_unavailable',503); }
}
export const securityHeaders = {
  'Cache-Control':'no-store, private', 'X-Content-Type-Options':'nosniff', 'Referrer-Policy':'no-referrer',
  'X-Frame-Options':'DENY', 'Cross-Origin-Resource-Policy':'same-origin',
  'Permissions-Policy':'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'"
};
export function json(body, status=200, extra={}) { return Response.json(body,{status,headers:{...securityHeaders,...extra}}); }
export function errorResponse(error) {
  const safe=error instanceof Fault;
  return json({error:safe?error.code:'internal_error'},safe?error.status:500,
    error.retryAfter?{'Retry-After':String(error.retryAfter)}:{});
}
export async function input(request, max=32_000) {
  requireThat(request.headers.get('content-type')?.split(';')[0].trim() === 'application/json','json_required',415);
  if (request.headers.get('content-length')) requireThat(Number(request.headers.get('content-length'))<=max,'request_too_large',413);
  try { const body=JSON.parse(new TextDecoder().decode(await boundedBody(request,max)));
    requireThat(body && typeof body==='object' && !Array.isArray(body),'invalid_input'); return body;
  } catch(e) { if(e instanceof Fault) throw e; throw new Fault('invalid_json'); }
}
export function mutationOrigin(request) {
  requireThat(request.headers.get('origin') === new URL(request.url).origin,'origin_required',403);
  const site=request.headers.get('sec-fetch-site');
  requireThat(!site || site==='same-origin' || site==='none','cross_site_request',403);
}
export function cookie(request) {
  const value=request.headers.get('cookie')?.split(';').map(s=>s.trim()).find(s=>s.startsWith('crm_session='))?.slice(12);
  return /^[A-Za-z0-9_-]{43}$/.test(value||'')?value:null;
}
export function sessionCookie(value,id,clear=false) {
  return `crm_session=${value}; Path=/api/w/${id}; HttpOnly; Secure; SameSite=Strict; Max-Age=${clear?0:43200}`;
}
