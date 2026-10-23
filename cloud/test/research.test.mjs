import test from 'node:test';
import assert from 'node:assert/strict';
import {search,page,corroborate,namedImage,queueResearch,researchStep} from '../src/research.mjs';
import {configuration,scoringRules} from '../src/config.mjs';
import {setup} from './fixture.mjs';
import {cleanRaster} from '../src/image.mjs';
const db=()=>{const rows=new Map();return {get:(k,d=null)=>structuredClone(rows.get(k)??d),put:(k,v)=>rows.set(k,structuredClone(v)),remove:k=>rows.delete(k),prefix:p=>[...rows].filter(([k])=>k.startsWith(p))};};
test('Bright Data original image and thumbnail fields remain distinct',async()=>{
  const original=globalThis.fetch,w={db:db(),env:{BRIGHTDATA_API_KEY:'synthetic',BRIGHTDATA_SERP_ZONE:'synthetic'},control:{reserve:async()=>{}}};w.db.put('config',{id:'synthetic'});
  globalThis.fetch=async()=>Response.json({status_code:200,body:JSON.stringify({images:[{title:'Jordan Example',link:'https://www.example.org/team/jordan',image:'https://encrypted-tbn0.gstatic.com/thumbnail',original_image:'https://www.example.org/jordan.jpg'}]})});
  try{const [r]=await search(w,'synthetic',true);assert.equal(r.image,'https://www.example.org/jordan.jpg');assert.equal(r.thumbnail,'https://encrypted-tbn0.gstatic.com/thumbnail');}finally{globalThis.fetch=original;}
});
test('identity evidence needs the full name and company in distinct sources',()=>{
  const p={name:'Jordan Example',company:'Example Labs'},a={url:'https://www.linkedin.com/in/jordan-example',title:'Jordan Example',body:'Jordan Example is a founder at Example Labs.'},b={...a,url:'https://www.example.org/team'};
  assert.equal(corroborate(p,a,b),true);assert.equal(corroborate(p,a,a),false);assert.equal(corroborate(p,a,{...b,body:'Jordan Example founded Different Labs.'}),false);
  assert.equal(corroborate({...p,name:'Jordan Ex'},a,b),false);
});
test('portrait attribution requires exact original image and named source association',()=>{
  const p={name:'Jordan Example'},source={title:'Example team',body:'Jordan Example is a founder.',images:[{alt:'Jordan Example',url:'https://www.example.org/jordan.jpg'}]};
  assert.equal(namedImage(source,p,'https://www.example.org/jordan.jpg'),true);
  assert.equal(namedImage(source,p,'https://www.example.org/someone-else.jpg'),false);
  assert.equal(namedImage({...source,images:[{alt:'Team',url:'https://www.example.org/jordan.jpg'}]},p,'https://www.example.org/jordan.jpg'),false);
  assert.equal(namedImage({...source,images:[{alt:'Jordan Example with Riley Example',url:'https://www.example.org/jordan.jpg'}]},p,'https://www.example.org/jordan.jpg'),false);
  assert.equal(namedImage({...source,images:[...source.images,{alt:'Jordan Example',url:'https://www.example.org/namesake.jpg'}]},p,'https://www.example.org/jordan.jpg'),false);
});
test('raster parser rejects SVG, oversized and truncated signature-only images',()=>{
  assert.equal(cleanRaster(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>bad()</script></svg>')),null);
  assert.equal(cleanRaster(new Uint8Array(200001)),null);
  assert.equal(cleanRaster(Uint8Array.from([255,216,255,...Array(40).fill(0)])),null);
});
test('ambiguous profile search proceeds to biographies instead of claiming no portrait',async()=>{
  const original=globalThis.fetch,w={db:db(),env:{SERPER_API_KEY:'synthetic'},control:{reserve:async()=>{}}};
  const p={id:'p-one',name:'Jordan Example',company:'Example Labs',linkedin:null};
  w.db.put('config',{id:'synthetic',setupVersion:'one'});w.db.put('snapshot',{people:[p]});queueResearch(w,[p]);
  globalThis.fetch=async()=>Response.json({organic:[]});
  try{await researchStep(w);assert.equal(w.db.get('research-job').stage,'independent_search');assert.equal(w.db.get('research:p-one').photoState,'pending');}finally{globalThis.fetch=original;}
});
test('requeued research invalidates an in-flight old result',async()=>{
  const original=globalThis.fetch,w={db:db(),env:{SERPER_API_KEY:'synthetic'},control:{reserve:async()=>{}}};
  const p={id:'p-one',name:'Jordan Example',company:'Example Labs'};w.db.put('config',{id:'synthetic',setupVersion:'one'});w.db.put('snapshot',{people:[p]});queueResearch(w,[p]);
  globalThis.fetch=async()=>{queueResearch(w,[p]);return Response.json({organic:[]});};
  try{await researchStep(w);assert.equal(w.db.get('research-job').stage,'search');assert.equal(w.db.get('research:p-one'),null);}finally{globalThis.fetch=original;}
});
test('a rejected research reservation prevents the external HTTP request',async()=>{
  const original=globalThis.fetch,w={db:db(),env:{SERPER_API_KEY:'synthetic'},control:{reserve:async()=>{throw new Error('limit');}}};w.db.put('config',{id:'synthetic'});let requests=0;
  globalThis.fetch=async()=>{requests++;return Response.json({organic:[]});};
  try{await assert.rejects(()=>search(w,'synthetic'),{code:'budget_paused'});assert.equal(requests,0);}finally{globalThis.fetch=original;}
});
test('missing independent evidence still tries a name-labelled LinkedIn portrait before image search',async()=>{
  const w={db:db(),env:{},control:{}},p={id:'p-one',name:'Jordan Example',company:'Example Labs'};
  w.db.put('config',{id:'synthetic',setupVersion:'one'});w.db.put('snapshot',{people:[p]});queueResearch(w,[p]);
  const job=w.db.get('research-job');job.stage='independent';job.candidates=[];w.db.put('research-job',job);
  await researchStep(w);assert.equal(w.db.get('research-job').stage,'direct_photo');assert.equal(w.db.get('research:p-one').photoState,'pending');
});
test('roster adoption resumes partially researched identities without repeating completed ones',()=>{
  const w={db:db()};w.db.put('research:partial',{state:'searching',photoState:'pending'});w.db.put('research:done',{state:'corroborated',photoState:'stored'});
  queueResearch(w,[{id:'partial'},{id:'done'},{id:'new'}]);assert.deepEqual(w.db.get('research-job').ids,['partial','new']);
});
test('a research budget failure preserves concurrent attendance pause',async()=>{
  const w={db:db(),env:{SERPER_API_KEY:'synthetic'},control:{reserve:async()=>{const fresh=w.db.get('config');fresh.active=false;w.db.put('config',fresh);throw new Error('limit');}}};
  const p={id:'p-one',name:'Jordan Example',company:'Example Labs'};w.db.put('config',{id:'synthetic',setupVersion:'one',active:true});w.db.put('snapshot',{people:[p]});queueResearch(w,[p]);
  await researchStep(w);assert.equal(w.db.get('config').active,false);assert.equal(w.db.get('config').researchPaused,true);
});

test('markdown portrait URLs survive contact redaction and failed biography pages retry in place',async()=>{
  const original=globalThis.fetch,w={db:db(),env:{SERPER_API_KEY:'synthetic'},control:{reserve:async()=>{}}};
  w.db.put('config',{id:'synthetic',setupVersion:'one'});
  const url='https://media.licdn.com/dms/image/12345678901234/profile.jpg';
  globalThis.fetch=async()=>Response.json({markdown:`Jordan Example works at Example Labs as a founder. ![Jordan Example](${url})`});
  try {
    const source=await page(w,'https://www.example.org/team');assert.equal(namedImage(source,{name:'Jordan Example'},url),true);
    const person={id:'p-one',name:'Jordan Example',company:'Example Labs'};w.db.put('snapshot',{people:[person]});queueResearch(w,[person]);
    const job=w.db.get('research-job');job.stage='independent';job.profile={url:'',body:'',title:''};job.candidates=[{url:'https://www.example.org/team'}];w.db.put('research-job',job);
    globalThis.fetch=async()=>new Response('',{status:503});await researchStep(w);
    assert.equal(w.db.get('research-job').candidates.length,1);assert.equal(w.db.get('research-job').attempt,1);
    globalThis.fetch=async()=>Response.json({text:'Jordan Example works at Example Labs as a founder.'});await researchStep(w);
    assert.equal(w.db.get('research-job').candidates.length,0);assert.equal(w.db.get('research-job').attempt,0);
  } finally {globalThis.fetch=original;}
});

test('sponsor consent is required before activation and AI rules use the host rule validator',()=>{
  const body=setup(),event={questions:[{id:'company',type:'company'},{id:'size',type:'select'},{id:'optin',type:'select'}]};
  delete body.audiences[1].optInQuestion;
  assert.throws(()=>configuration(body,event),{code:'sharing_consent_required'});
  assert.throws(()=>scoringRules([{field:'private',op:'equals',value:'x',points:1}],['size']),{code:'invalid_rule'});
  assert.throws(()=>scoringRules([{field:'size',op:'equals',value:'11–50',points:999}],['size']),{code:'invalid_points'});
});

test('a candidate portrait is held for review without downloading or caching an uncorroborated person',async()=>{
  const original=globalThis.fetch,w={db:db(),env:{},control:{}},person={id:'p-one',name:'Jordan Example',company:'Example Labs'};
  w.db.put('config',{id:'synthetic',setupVersion:'one'});w.db.put('snapshot',{people:[person]});queueResearch(w,[person]);
  const job=w.db.get('research-job');job.stage='direct_photo';job.profile={url:'https://www.linkedin.com/in/jordan-example',title:'Jordan Example',body:'Jordan Example works at Example Labs.',images:[{alt:'Jordan Example',url:'https://media.licdn.com/jordan.jpg'}]};w.db.put('research-job',job);
  w.db.put('research:p-one',{state:'candidate',photoState:'pending',sources:[],attempts:[]});let calls=0;
  globalThis.fetch=async()=>{calls++;throw new Error('must not download');};
  try {await researchStep(w);assert.equal(calls,0);assert.equal(w.db.get('photo:p-one'),null);assert.equal(w.db.get('research:p-one').photoState,'needs_review');}
  finally {globalThis.fetch=original;}
});
