import test from 'node:test';
import assert from 'node:assert/strict';
import {encrypt,decrypt,token,hash,mutationOrigin,input,sessionCookie,errorResponse} from '../src/security.mjs';
import {stamp} from '../src/core.mjs';
test('Luma encryption is randomized and bound to workspace and secret',async()=>{
  const secret=token(),a=await encrypt('synthetic-calendar-key',secret,'one'),b=await encrypt('synthetic-calendar-key',secret,'one');
  assert.notDeepEqual(a,b);assert.equal(await decrypt(a,secret,'one'),'synthetic-calendar-key');
  await assert.rejects(()=>decrypt(a,secret,'two'));await assert.rejects(()=>decrypt(a,token(),'one'));
  a.bytes[0]^=1;await assert.rejects(()=>decrypt(a,secret,'one'));assert.equal((await hash(secret)).length,64);
});
test('mutations reject absent, cross-site and mismatched origins',()=>{
  for(const headers of [{},{origin:'https://evil.test'},{origin:'https://crm.test','sec-fetch-site':'cross-site'}])assert.throws(()=>mutationOrigin(new Request('https://crm.test/api',{headers})));
  mutationOrigin(new Request('https://crm.test/api',{headers:{origin:'https://crm.test','sec-fetch-site':'same-origin'}}));
});
test('bounded JSON rejects unsupported bodies and hides arbitrary errors',async()=>{
  await assert.rejects(()=>input(new Request('https://crm.test',{method:'POST',body:'{}'})));
  await assert.rejects(()=>input(new Request('https://crm.test',{method:'POST',headers:{'content-type':'application/json'},body:'[]'})));
  await assert.rejects(()=>input(new Request('https://crm.test',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({large:'x'.repeat(33000)})})));
  const r=errorResponse(new Error('synthetic credential MUST NOT LEAK'));assert.equal(r.status,500);assert.equal(await r.text(),'{"error":"internal_error"}');
});
test('cookie uses a narrow workspace path and secure browser flags',()=>{
  const c=sessionCookie(token(),'one');for(const flag of ['Path=/api/w/one','Secure','HttpOnly','SameSite=Strict','Max-Age=43200'])assert.ok(c.includes(flag));
  assert.ok(sessionCookie('','one',true).includes('Max-Age=0'));
});
test('invalid calendar dates and offsetless timestamps cannot become check-in evidence',()=>{
  assert.throws(()=>stamp('2026-02-30T00:00:00Z'));assert.throws(()=>stamp('2026-10-21T01:00:00'));
  assert.equal(stamp('2026-10-21T01:00:00-07:00'),Date.parse('2026-10-21T08:00:00Z'));
});
