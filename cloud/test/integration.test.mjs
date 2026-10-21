import test from 'node:test';
import assert from 'node:assert/strict';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {fixture,setup} from './fixture.mjs';

test('isolated Worker lifecycle: authorization, import, scopes, concurrency, durable snapshots and deletion',{timeout:90000},async()=>{
  const provider=fixture();
  const options=convertV4MiniflareOptions({modules:true,scriptPath:'.wrangler/build/worker.js',compatibilityDate:'2026-10-20',cf:false,
    durableObjects:{WORKSPACES:{className:'Workspace',useSQLite:true},CONTROL:{className:'Control',useSQLite:true}},
    bindings:{KEY_ENCRYPTION_SECRET:'synthetic-encryption-secret-43-characters-long',LIVE_ADMISSION:'open',SERPER_API_KEY:'synthetic',GEMINI_API_KEY:'synthetic'},
    outboundService:provider.fetch});
  const mf=new Miniflare(options);let id,ownerCookie;
  const request=async(path,body,cookie=ownerCookie,origin='https://crm.test')=>{
    const r=await mf.dispatchFetch('https://crm.test'+path,{method:body===undefined?'GET':'POST',headers:{...(body===undefined?{}:{Origin:origin,'Content-Type':'application/json'}),...(cookie?{Cookie:cookie}:{})},body:body===undefined?undefined:JSON.stringify(body)});
    const result=await r.json();return {status:r.status,body:result,cookie:r.headers.get('set-cookie')?.split(';')[0]};
  };
  const api=(action,body,cookie=ownerCookie)=>request(`/api/w/${id}/${action}`,body,cookie);
  const waitFor=async predicate=>{for(let i=0;i<120;i++){const r=await api('dashboard');if(predicate(r.body))return r.body;await new Promise(r=>setTimeout(r,250));}assert.fail('Background condition did not complete');};
  try{
    assert.equal((await request('/api/workspaces',{agree:true},null,'https://evil.test')).status,403);
    const created=await request('/api/workspaces',{agree:true},null);assert.equal(created.status,201);id=created.body.id;
    assert.equal(created.body.ownerKey.length,43);assert.notEqual(created.body.ownerKey,created.body.backupKey);
    assert.equal((await api('dashboard')).status,401);
    const logged=await api('login',{key:created.body.ownerKey});assert.equal(logged.status,200);ownerCookie=logged.cookie;
    const connected=await api('connect',{hostConfirmed:true,eventUrl:'https://luma.com/fictional-demo',apiKey:'synthetic-calendar-key'});
    assert.equal(connected.status,200,JSON.stringify({result:connected.body,calls:provider.calls}));
    assert.equal((await api('configure',setup())).status,200);
    const preview=await waitFor(d=>d.preview&&Object.values(d.config.icpProposals).every(j=>j.state==='ready'));
    assert.equal(preview.preview.people.length,2);assert.ok(!JSON.stringify(preview).includes('private@example.org'));
    assert.equal(preview.config.icpProposals['aud-1'].proposal.rules[0].value,'11–50');
    assert.equal((await api('activate',{revision:preview.preview.revision,confirmed:true,icpApproved:true})).status,200);
    await waitFor(d=>d.revision>=2);
    assert.equal((await api('monitor',{active:false})).status,200);
    let live=(await api('dashboard')).body;assert.equal(live.people.length,2);assert.equal(live.people[0].id,'g-one');
    const owner=live.team[0].id;
    assert.equal((await api('work',{personId:'g-one',revision:0,owner,status:'meeting'})).status,200);
    assert.equal((await api('work',{personId:'g-one',revision:0,owner,status:'done'})).status,409);
    const invite=await api('keys/create',{name:'Sponsor Example',role:'viewer',audience:'aud-2'});assert.equal(invite.status,200);
    const sponsorCookie=(await api('login',{key:invite.body.key})).cookie;
    const sponsor=await api('dashboard',undefined,sponsorCookie);assert.equal(sponsor.status,200);assert.equal(sponsor.body.people.length,1);
    assert.ok(!sponsor.body.people[0].research);assert.ok(!sponsor.body.people[0].answers.company);
    assert.equal((await api('dashboard?audience=aud-1',undefined,sponsorCookie)).status,403);
    assert.equal((await api('work',{personId:'g-one',revision:1,status:'done'},sponsorCookie)).status,403);
    assert.equal((await api('photo/g-one',undefined,sponsorCookie)).status,403);
    const other=await request('/api/workspaces',{agree:true},null);
    assert.equal((await request(`/api/w/${other.body.id}/dashboard`,undefined,ownerCookie)).status,401);
    await mf.setOptions(options); // Recreate runtime against retained local DO state, no live provider.
    live=(await api('dashboard')).body;assert.equal(live.people.find(p=>p.id==='g-one').work.status,'meeting');
    provider.rows[2].event_tickets[0].checked_in_at=new Date().toISOString();
    await api('monitor',{active:true});await waitFor(d=>d.people?.[0]?.id==='g-two');await api('monitor',{active:false});
    const good=(await api('dashboard')).body;
    provider.fail=true;await api('preview',{});await waitFor(d=>d.config.sync.error==='luma_reconnect_required');
    const failed=(await api('dashboard')).body;assert.equal(failed.revision,good.revision);assert.equal(failed.people[0].id,'g-two');
    assert.ok(!JSON.stringify(failed).includes('RAW SECRET'));
    assert.equal((await api('keys/revoke',{id:invite.body.id})).status,200);assert.equal((await api('dashboard',undefined,sponsorCookie)).status,401);
    await api('disconnect',{});assert.equal((await api('dashboard')).body.people.length,2);
    assert.equal((await api('delete',{confirm:id})).status,200);assert.equal((await api('dashboard')).status,404);
    assert.ok(provider.calls.filter(c=>c.host==='public-api.luma.com').every(c=>c.method==='GET'));
  }finally{await mf.dispose();}
});

test('disconnect invalidates an in-flight Luma connection',{timeout:30000},async()=>{
  const provider=fixture();
  let release,entered;
  const gate=new Promise(r=>{release=r;}),started=new Promise(r=>{entered=r;});
  const mf=new Miniflare(convertV4MiniflareOptions({modules:true,scriptPath:'.wrangler/build/worker.js',compatibilityDate:'2026-10-20',cf:false,
    durableObjects:{WORKSPACES:{className:'Workspace',useSQLite:true},CONTROL:{className:'Control',useSQLite:true}},
    bindings:{KEY_ENCRYPTION_SECRET:'synthetic-encryption-secret-43-characters-long',LIVE_ADMISSION:'open',SERPER_API_KEY:'synthetic',GEMINI_API_KEY:'synthetic'},
    outboundService:async request=>{entered();await gate;return provider.fetch(request);}}));
  let session;
  const request=async(path,body)=>{
    const r=await mf.dispatchFetch('https://crm.test'+path,{method:body===undefined?'GET':'POST',headers:{Origin:'https://crm.test','Content-Type':'application/json',...(session?{Cookie:session}:{})},body:body===undefined?undefined:JSON.stringify(body)});
    return {status:r.status,body:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};
  };
  try {
    const created=await request('/api/workspaces',{agree:true});const base=`/api/w/${created.body.id}/`;
    session=(await request(base+'login',{key:created.body.ownerKey})).cookie;
    const connecting=request(base+'connect',{hostConfirmed:true,eventUrl:'https://luma.com/fictional-demo',apiKey:'synthetic-calendar-key'});
    await started;
    assert.equal((await request(base+'disconnect',{})).status,200);
    release();
    assert.equal((await connecting).status,409);
    const dashboard=(await request(base+'dashboard')).body;
    assert.equal(dashboard.config.connected,false);
    assert.equal(dashboard.config.sync.state,'disconnected');
  } finally {release();await mf.dispose();}
});
