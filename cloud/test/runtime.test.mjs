import test from 'node:test';
import assert from 'node:assert/strict';
import {Miniflare,convertV4MiniflareOptions,Response} from 'miniflare';
test('Workers provider fetch contract',{timeout:10000},async()=>{
  const m=new Miniflare(convertV4MiniflareOptions({modules:true,cf:false,compatibilityDate:'2026-10-20',
    script:`export default {async fetch(){try {const f=fetch;const r=await f('https://example.org/',{redirect:'manual',signal:AbortSignal.timeout(1000)});return new Response(String(r.status));}catch(e){return new Response(e.name+':'+e.message)}}}`,
    outboundService:async()=>new Response('okay')}));
  try{assert.equal(await(await m.dispatchFetch('http://localhost')).text(),'200');}finally{await m.dispose();}
});
