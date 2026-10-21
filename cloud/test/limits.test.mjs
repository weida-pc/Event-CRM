import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {fixture,setup} from './fixture.mjs';
test('budget reservations are atomic and exhausted budgets never dispatch paid calls',{timeout:15000},async()=>{
  const provider=fixture(),mf=new Miniflare(convertV4MiniflareOptions({modules:true,scriptPath:'.wrangler/build/worker.js',cf:false,compatibilityDate:'2026-10-20',
    durableObjects:{WORKSPACES:{className:'Workspace',useSQLite:true},CONTROL:{className:'Control',useSQLite:true}},
    bindings:{MONTHLY_RESEARCH_MICRO_USD:'10000'},outboundService:provider.fetch}));
  try{const ns=await mf.getDurableObjectNamespace('CONTROL'),control=ns.getByName('control');
    const id=await control.create('synthetic-ip');const results=await Promise.allSettled(Array.from({length:3},()=>control.reserve(id,'synthetic',4000)));
    assert.equal(results.filter(r=>r.status==='fulfilled').length,2);assert.equal((await control.budget(id)).workspaceReservedUsd,0.008);
    assert.equal(provider.calls.length,0);
  }finally{await mf.dispose();}
});
test('final scan and missed deadline remove Luma key but preserve snapshots and team work',{timeout:30000},async()=>{
  // Fixture-only subclass is composed in memory; it is absent from the production bundle.
  const script=await readFile('.wrangler/build/worker.js','utf8')+`
export class FixtureWorkspace extends Workspace {
  async fixture(values){for(const [k,v] of Object.entries(values))this.db.put(k,v);}
  async inspect(){return {config:this.db.get('config'),snapshot:this.db.get('snapshot'),work:this.db.get('work:g-one'),scan:this.db.get('scan')};}
  async tick(){const s=this.db.get('scan');if(s){s.nextAt=0;this.db.put('scan',s);}await this.alarm();}
}`;
  const provider=fixture(),mf=new Miniflare(convertV4MiniflareOptions({modules:true,script,cf:false,compatibilityDate:'2026-10-20',
    durableObjects:{WORKSPACES:{className:'FixtureWorkspace',useSQLite:true},CONTROL:{className:'Control',useSQLite:true}},
    bindings:{KEY_ENCRYPTION_SECRET:'synthetic-encryption-secret-43-characters-long'},outboundService:provider.fetch}));
  try{const cn=await mf.getDurableObjectNamespace('CONTROL'),control=cn.getByName('control'),ns=await mf.getDurableObjectNamespace('WORKSPACES');
    const id=await control.create('synthetic-ip'),w=ns.getByName(id);const keys=await w.initialize(id);
    const req=async(action,body,cookie)=>{const r=await w.fetch('https://crm.test/api/w/'+id+'/'+action,{method:'POST',headers:{'content-type':'application/json',...(cookie?{cookie}:{})},body:JSON.stringify(body)});return {body:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0],status:r.status};};
    const session=await req('login',{key:keys.ownerKey});assert.equal((await req('connect',{eventUrl:'https://luma.com/fictional-demo',apiKey:'synthetic-calendar-key',hostConfirmed:true},session.cookie)).status,200);
    const state=await w.inspect(),base=setup();
    const selected=state.config.event.questions;
    const people=provider.rows.slice(1).map(r=>({id:r.id,userId:r.user_id,name:r.user_name,company:'Example Labs',title:'Founder',linkedin:null,status:'approved',checkedIn:false,answers:{company:{company:'Example Labs',title:'Founder'},size:r.registration_answers[1].value,optin:r.registration_answers[2].value}}));
    const cfg={...state.config,selected,fields:base.fields,audiences:base.audiences,setupVersion:'synthetic',active:true,nextScan:0,monitorStart:Date.now()-3600000,monitorEnd:Date.now()-1,retentionEnd:Date.now()+86400000};
    await w.fixture({config:cfg,snapshot:{people,revision:1,capturedAt:Date.now()-10000},'work:g-one':{owner:'synthetic-owner',status:'meeting',revision:1}});
    for(let i=0;i<5;i++)await w.tick();
    const final=await w.inspect();assert.equal(final.config.finalScan,true);assert.equal(final.config.active,false);assert.equal(final.config.encryptedKey,undefined);
    assert.equal(final.snapshot.people.length,2);assert.equal(final.work.status,'meeting');
    const callCount=provider.calls.length;
    await w.fixture({config:{...cfg,monitorEnd:Date.now()-181000}});await w.tick();
    const missed=await w.inspect();assert.equal(provider.calls.length,callCount);assert.equal(missed.config.encryptedKey,undefined);assert.equal(missed.snapshot.revision,final.snapshot.revision);
  }finally{await mf.dispose();}
});
