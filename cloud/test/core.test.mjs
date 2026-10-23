import test from 'node:test';
import assert from 'node:assert/strict';
import {eventUrl,linkedin,publicUrl,questions,checkIn,normalizeGuest,validateScan,rank} from '../src/core.mjs';
import {lumaClient,resolveEvent,boundedBody} from '../src/luma.mjs';

const q = {id:'q-company',label:'Company and job title',type:'company',options:[],multiple:false};
const guest = (id='g-1') => ({id,user_id:`u-${id}`,user_name:'Jordan Example',approval_status:'approved',
  registration_answers:[{question_id:q.id,label:q.label,question_type:'company',value:{company:'Example Labs',job_title:'Founder'}}],
  event_tickets:[{checked_in_at:null}]});
const person = id => normalizeGuest(guest(id),[q],{company:q.id,title:q.id});
const withFakeCredentials=value=>{const u=new URL(value);u.username='synthetic-user';u.password='synthetic-password';return u.href;};
const detail = () => ({id:'evt-one',calendarId:'cal-one',url:'https://luma.com/demo',questions:[q],hosts:[],
  counts:{approved:1,pending_approval:0,waitlist:0,invited:0,declined:0,checked_in:0}});
test('event links cannot redirect secrets to other origins',()=>{
  assert.equal(eventUrl('https://lu.ma/demo?utm_source=x'),'https://luma.com/demo');
  for(const u of ['http://luma.com/demo','https://luma.com.attacker.tld/demo',withFakeCredentials('https://luma.com/demo'),'https://luma.com:4433/demo']) assert.throws(()=>eventUrl(u));
});
test('professional profile links are not company/search profiles',()=>{
  assert.equal(linkedin('https://www.linkedin.com/in/jordan-example/?trk=x'),'https://www.linkedin.com/in/jordan-example');
  assert.equal(linkedin('https://www.linkedin.com/company/example'),null);
  assert.equal(linkedin('https://www.linkedin.com.attacker.tld/in/a'),null);
});
test('public fetch URL rejects credentials, local networks and local aliases',()=>{
  for(const u of ['https://127.1/','https://[::1]/','https://169.254.169.254/','https://a.internal/','https://localhost/','https://a.nip.io/',withFakeCredentials('https://example.org/')]) assert.throws(()=>publicUrl(u));
  assert.equal(publicUrl('https://www.example.org/about#bio'),'https://www.example.org/about');
});
test('only eligible professional questions can be mapped',()=>{
  const raw=[{id:'safe',label:'Team size',question_type:'select',options:['1','2–10']},
    {id:'bad',label:'Immigration status',question_type:'text'},{id:'phone',label:'Mobile',question_type:'phone-number'}];
  assert.equal(questions(raw).length,1);
});
test('RSVP, empty tickets and group tickets are never attendance',()=>{
  assert.equal(checkIn(guest()),false);
  assert.equal(checkIn({...guest(),event_tickets:[{checked_in_at:'2030-01-01T10:00:00Z'}]}),true);
  for(const ts of [[],[{}],[{checked_in_at:'invalid'}],[{checked_in_at:null},{checked_in_at:null}]]) assert.equal(checkIn({...guest(),event_tickets:ts}),null);
});
test('normalization keeps mapped values and discards contact/QR/wallet fields',()=>{
  const g={...guest(),user_email:'private@example.org',phone_number:'555-555-1234',check_in_qr_code:'secret'};
  g.registration_answers.push({question_id:'hidden',label:'Private',value:'DO NOT RETAIN'});
  const p=normalizeGuest(g,[q],{company:q.id,title:q.id});
  assert.equal(p.company,'Example Labs'); assert.equal(p.title,'Founder');
  assert.ok(!JSON.stringify(p).includes('private')); assert.ok(!JSON.stringify(p).includes('RETAIN'));
});
test('a changed question or duplicate answer rejects the scan',()=>{
  const g=guest(); g.registration_answers.push({...g.registration_answers[0]});
  assert.throws(()=>normalizeGuest(g,[q]));
  g.registration_answers=[{...g.registration_answers[0],label:'Different'}]; assert.throws(()=>normalizeGuest(g,[q]));
});

test('oversized optional answers are explicit omissions, not a global attendance failure or ranking evidence',()=>{
  const about={id:'about',label:'Professional background',type:'text',multiple:false};
  const g=guest();g.registration_answers.push({question_id:'about',label:about.label,question_type:'text',value:'Long public biography '.repeat(100)});
  const p=normalizeGuest(g,[q,about],{company:q.id,title:q.id});
  assert.equal(p.answers.about,'');assert.deepEqual(p.omittedAnswers,['about']);assert.equal(p.company,'Example Labs');
  assert.equal(p.checkedIn,false);assert.equal(rank([p],[{field:'about',op:'equals',value:'',points:50,reason:'Invalid'}])[0].score,0);
});

test('500 multilingual guests fit in a bounded complete snapshot without shortening identities',()=>{
  const qs=Array.from({length:4},(_,i)=>({id:'q'+i,label:'Professional option '+i,type:'select',multiple:true}));
  const rows=Array.from({length:500},(_,i)=>{
    const g=guest('g-'+i);g.registration_answers.push(...qs.map(q=>({question_id:q.id,label:q.label,question_type:q.type,value:Array(20).fill('团队'.repeat(100))})));
    return normalizeGuest(g,[q,...qs],{company:q.id,title:q.id});
  });
  assert.equal(rows.length,500);assert.ok(new TextEncoder().encode(JSON.stringify({people:rows})).length<1_900_000);
  assert.ok(rows.every(p=>p.company==='Example Labs'&&p.omittedAnswers.length));
});
test('complete source validation rejects duplicates, missing rows and moving counts',()=>{
  const d=detail(); assert.equal(validateScan(d,d,[person('g-1')]).guests.length,1);
  assert.throws(()=>validateScan(d,d,[])); assert.throws(()=>validateScan(d,d,[person('g-1'),person('g-1')]));
  assert.throws(()=>validateScan(d,{...d,counts:{...d.counts,checked_in:1}},[person('g-1')]));
});
test('hosts are excluded by provider identity, never by their name',()=>{
  const d=detail(); d.hosts=[{userId:'u-g-1',name:'Jordan Example'}];
  assert.equal(validateScan(d,d,[person('g-1')]).guests.length,0);
  d.hosts=[{userId:'someone-else',name:'Jordan Example'}]; assert.equal(validateScan(d,d,[person('g-1')]).guests.length,1);
});
test('frozen identities, unknown attendance and explicit undo semantics',()=>{
  const d=detail(), old={...person('g-1'),checkedIn:true};
  assert.equal(validateScan(d,d,[person('g-1')],[old]).guests[0].checkedIn,false);
  assert.throws(()=>validateScan(d,d,[{...person('g-1'),checkedIn:null}],[old]));
  assert.throws(()=>validateScan(d,d,[{...person('g-1'),company:'Other'}],[old]));
});
test('an unchanged unknown ticket does not block another guest explicit check-in',()=>{
  const d=detail();d.counts.approved=2;d.counts.checked_in=1;
  const unknown={...person('g-1'),checkedIn:null},known=person('g-2');
  const result=validateScan(d,d,[unknown,{...known,checkedIn:true}],[unknown,known]);
  assert.equal(result.guests[0].checkedIn,null);assert.equal(result.guests[1].checkedIn,true);
});
test('new registration can be reviewed without silently adding it',()=>{
  const d=detail(); d.counts.approved=2;
  assert.equal(validateScan(d,d,[person('g-1'),person('g-2')],[person('g-1')]).extra.length,1);
});
test('check-ins lead within groups and low-priority group stays last',()=>{
  const people=[{...person('a'),title:'Founder',checkedIn:false},{...person('b'),title:'Founder',checkedIn:true},
    {...person('c'),title:'No bandwidth',checkedIn:true}];
  const rules=[{field:'title',op:'equals',value:'Founder',points:20,reason:'Decision maker'},
    {field:'title',op:'equals',value:'No bandwidth',points:0,group:9,reason:'Not available'}];
  assert.deepEqual(rank(people,rules).map(p=>p.id),['b','a','c']);
});
test('provider facade permits only documented GETs and suppresses raw errors',async()=>{
  let request; const get=lumaClient('synthetic-key-not-real',async(u,o)=>{request={u,o};return Response.json({ok:true});});
  await get('/v1/calendars/get'); assert.equal(request.o.method,'GET'); assert.equal(request.o.redirect,'manual');
  assert.ok(!request.u.includes('synthetic')); await assert.rejects(()=>get('/v1/events/update'));
  await assert.rejects(()=>lumaClient('synthetic-key-not-real',async()=>new Response('SECRET',{status:403}))('/v1/calendars/get'),{code:'luma_reconnect_required'});
});
test('provider body bounds and cyclic pagination fail closed',async()=>{
  await assert.rejects(()=>boundedBody(new Response('too long'),3));
  const get=async(path)=>path.endsWith('/get')?{id:'cal-one'}:{entries:[],has_more:true,next_cursor:'repeat'};
  await assert.rejects(()=>resolveEvent(get,'https://luma.com/demo'),{code:'invalid_pagination'});
});
