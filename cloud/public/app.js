import {demoData,selectDemoAudience} from './demo.js';
import {Portraits} from './portraits.js';
const app=document.querySelector('#app'),notice=document.querySelector('#notice');
const match=location.pathname.match(/^\/w\/([A-Za-z0-9_-]{24})(?:\/a\/(aud-\d+))?\/?$/);
const workspace=match?.[1],isDemo=location.pathname==='/demo';
let data,filters={search:'',attendance:'all',owner:'all',answers:{}},busy=false,formDirty=false;
let viewGeneration=0,loadsInFlight=0;
const portraits=new Portraits();
let audienceId=match?.[2]||'aud-1';
const el=(tag,attrs={},...children)=>{const node=document.createElement(tag);for(const [k,v]of Object.entries(attrs)){
  if(k.startsWith('on'))node.addEventListener(k.slice(2).toLowerCase(),v);else if(k==='class')node.className=v;
  else if(k==='text')node.textContent=v;else if(k in node&&k!=='style')node[k]=v;else node.setAttribute(k,v);
}for(const child of children.flat(Infinity))if(child!=null)node.append(child instanceof Node?child:document.createTextNode(String(child)));return node;};
const button=(label,fn,primary=false)=>el('button',{type:'button',class:primary?'primary':'',onClick:()=>task(fn)},label);
const field=(label,type='text',value='',attrs={})=>{const input=el('input',{type,value,...attrs});return {input,node:el('label',{},label,input)};};
const select=(label,options,value='')=>{const input=el('select',{},options.map(([v,t])=>el('option',{value:v},t)));input.value=value;return {input,node:el('label',{},label,input)};};
const checkbox=(label,checked=false)=>{const input=el('input',{type:'checkbox',checked});return {input,node:el('label',{class:'check'},input,label)};};
const dt=n=>new Date(n).toLocaleString(undefined,{dateStyle:'medium',timeStyle:'short'});
const localDate=n=>{const d=new Date(n);return new Date(d-d.getTimezoneOffset()*60000).toISOString().slice(0,16);};
const fmt=v=>Array.isArray(v)?v.join(', '):typeof v==='object'&&v!==null?Object.values(v).join(' · '):String(v??'');
const initials=n=>n.split(' ').slice(0,2).map(p=>p[0]).join('');
function toast(message){notice.textContent=message;setTimeout(()=>{notice.textContent='';},6500);}
const errors={sign_in_required:'Enter your workspace access key to continue.',invalid_access_key:'That access key is invalid or revoked.',
  onboarding_paused:'New-event setup is paused while the service is being verified. The fictional demo remains available.',
  luma_reconnect_required:'Luma rejected the key. Reconnect with the calendar administrator’s current key.',event_not_in_calendar:'That event was not found in this key’s managed Luma calendar.',
  event_too_large:'This beta supports up to 500 registrations per event.',incomplete_source:'The full source list did not match Luma’s counts. The previous snapshot is safe.',
  cohort_review_required:'An attendee’s identity changed or disappeared. Review a fresh roster before restarting.',attendance_unknown:'Luma did not provide an unambiguous check-in for every tracked person. The previous snapshot is safe.',
  question_changed:'A mapped signup question changed. Review the event setup.',fresh_preview_required:'Create and review a fresh roster preview first.',
  work_conflict:'A teammate updated this person. Refresh and try again.',budget_paused:'The research budget is paused. Completed data remains available.',
  sharing_consent_required:'Choose an exact sponsor opt-in question and answer before creating scoped access.',
  research_provider_unavailable:'The research provider is unavailable. Your roster and saved work are unaffected.',
  icp_not_ready:'Website research is still running. The proposal will appear here automatically.',
  icp_rules_required:'Review the website proposal or supply your own evidence-based customer profile and at least one rule for each audience, then save a fresh preview.',
  invalid_monitor_window:'Choose a future monitoring end, a window of at most 48 hours, within the next 30 days.',
  invalid_retention:'Retention must end after monitoring and within 30 days of today.',scope_denied:'This key does not have access to that audience.',
  capacity_paused:'The service has reached its safe daily capacity. Saved data has not been deleted.',
  workspace_expired:'This workspace expired or was deleted.',internal_error:'The request could not finish. Please retry once; saved data is preserved.'};
async function api(path,body,absolute=false){const response=await fetch(absolute?path:`/api/w/${workspace}/${path}`,{method:body===undefined?'GET':'POST',
  headers:body===undefined?{}:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(60000)});
  let result;try{result=await response.json();}catch{throw new Error('The service returned an unexpected response. Saved data is unaffected.');}
  if(!response.ok){const error=new Error(errors[result.error]||String(result.error||'Request failed').replaceAll('_',' '));error.code=result.error;throw error;}return result;}
async function task(fn){if(busy)return;busy=true;viewGeneration++;document.querySelectorAll('button').forEach(b=>b.disabled=true);try{await fn();}catch(e){toast(e.message);}finally{busy=false;document.querySelectorAll('button').forEach(b=>b.disabled=false);}}
function landing(){app.replaceChildren(
  el('section',{class:'hero'},el('div',{},el('p',{class:'eyebrow'},'YOUR EVENT. ONE SHARED PICTURE.'),el('h1',{},'Know who’s here.\nKnow who matters.'),
    el('p',{},'Turn your guest list into a private, prioritized workspace. Find the right people, see recorded check-ins, and give every conversation an owner.'),
    el('div',{class:'hero-actions'},button('Connect your Luma event ↗',()=>document.querySelector('#setup').scrollIntoView({behavior:'smooth'}),true),button('Explore the demo',()=>{location.href='/demo';})),
    el('p',{class:'fineprint'},'Luma Plus calendar key required · No attendee emails sent · Partiful is not available in this hosted release')),
    el('div',{class:'hero-card'},el('div',{class:'row space'},el('span',{class:'eyebrow'},'THE FOUNDER GATHERING'),el('span',{class:'pill checked'},'●  Recorded check-ins')),
      demoData.people.slice(0,3).map(p=>el('div',{class:'mini-person'},el('div',{class:'avatar'},initials(p.name)),el('div',{},el('strong',{},p.name),el('span',{},p.title+' · '+p.company)),el('span',{class:'pill'},p.checkedIn?'Checked in':'Not checked in'))),
      el('small',{},'Fictional demo · not real attendee data'))),
  el('section',{class:'feature-grid'},...[
    ['01 · Relevant, explainable priorities','Use your business website and approved signup answers to define fit. Review the proposed rules; missing information stays unknown.'],
    ['02 · A clear handoff to your team','Independent teammate keys, shared ownership, and separate sponsor views. No one needs a copy of your calendar API key.'],
    ['03 · Useful after the event, too','The last complete snapshot remains readable when polling ends. Freshness and research gaps are visible, never hidden.']
  ].map(([title,body])=>el('article',{},el('h3',{},title),el('p',{},body)))),setupStart());}
function setupStart(){const agree=checkbox('I am authorized to process this event’s attendees and share selected professional data with my named team. I will review the event, questions, and research purpose before starting.');
  return el('section',{id:'setup',class:'panel narrow stack'},el('div',{},el('p',{class:'eyebrow'},'START WITH A PRIVATE WORKSPACE'),el('h2',{},'Your next event, organized.'),el('p',{class:'muted'},'Have your Luma Plus calendar API key and event link ready. You’ll save an owner key first, then connect Luma. No account, email login, or hidden password gate.')),
    agree.node,button('Create private workspace',async()=>{if(!agree.input.checked)throw new Error('Please confirm your event-host authorization.');const created=await api('/api/workspaces',{agree:true},true);showNewKeys(created);},true),
    el('small',{},'This beta is capacity-limited. Lost keys cannot be recovered; keep the separate backup owner key. Provider research may remain unresolved where evidence is unavailable.'));}
function showNewKeys(created){const saved=checkbox('I saved both keys in a safe place.');app.replaceChildren(el('section',{class:'panel narrow stack'},el('h2',{},'Save your workspace keys'),
  el('p',{class:'secret-warning'},'These keys are shown once. Anyone holding an owner key can access and administer this workspace. Do not put keys in links or public messages.'),
  el('label',{},'Workspace link',el('div',{class:'key'},`${location.origin}/w/${created.id}`)),
  el('label',{},'Owner access key',el('div',{class:'key'},created.ownerKey)),el('label',{},'Backup owner key — store separately',el('div',{class:'key'},created.backupKey)),saved.node,
  button('Keys saved · continue',async()=>{if(!saved.input.checked)throw new Error('Save both keys before continuing.');
    await api(`/api/w/${created.id}/login`,{key:created.ownerKey},true);created.ownerKey='';created.backupKey='';location.href='/w/'+created.id;},true)));}
function login(){viewGeneration++;data=undefined;portraits.clear();filters={search:'',attendance:'all',owner:'all',answers:{}};const key=field('Workspace access key','password','',{autocomplete:'off',required:true});const form=el('form',{class:'panel narrow stack',onSubmit:e=>{e.preventDefault();task(async()=>{const value=key.input.value;key.input.value='';await api('login',{key:value});await load();});}},
  el('p',{class:'eyebrow'},'PRIVATE WORKSPACE'),el('h2',{},'Welcome back.'),el('p',{class:'muted'},'Use your owner, team, or sponsor access key. The event URL alone does not grant access.'),key.node,el('button',{type:'submit',class:'primary'},'Open workspace'),
  el('small',{},'Keys stay out of URLs and browser storage. Sessions expire after 12 hours.'));app.replaceChildren(form);}
function connectView(config){const link=field('Luma event link','url',config.event?.url||'',{placeholder:'https://luma.com/your-event',required:true});const key=field('Calendar API key','password','',{autocomplete:'off',required:true});
  const agree=checkbox('I am this calendar’s administrator or have the host’s permission for this exact event.');
  const form=el('form',{class:'panel narrow stack',onSubmit:e=>{e.preventDefault();task(async()=>{if(!agree.input.checked)throw new Error('Host authorization is required.');const value=key.input.value;key.input.value='';await api('connect',{eventUrl:link.input.value,apiKey:value,hostConfirmed:true});await load();});}},
    el('p',{class:'eyebrow'},'STEP 1 · READ-ONLY CONNECTION'),el('h2',{},'Connect your Luma event'),el('p',{class:'muted'},'Use a Luma Plus calendar administrator key. Luma gives this key full calendar privileges; Event CRM uses only documented GET requests and never changes check-ins or approvals.'),link.node,key.node,agree.node,
    el('button',{type:'submit',class:'primary'},config.event?'Reconnect Luma':'Find my event'),el('small',{},'The key is encrypted in your workspace, never sent to teammates or research services, and removed when monitoring ends. Abandoned setups expire after 24 hours.'));
  app.replaceChildren(form);}
function setupView(cfg,preview){formDirty=false;const selected=new Set(cfg.selected?.map(q=>q.id)||cfg.event.questions.slice(0,5).map(q=>q.id));
  const questionChecks=cfg.event.questions.map(q=>{const c=checkbox(q.label,selected.has(q.id));c.input.addEventListener('change',()=>{c.input.checked?selected.add(q.id):selected.delete(q.id);formDirty=true;});return c;});
  const mappingOptions=[['','Not collected'],...cfg.event.questions.map(q=>[q.id,q.label])];
  const companyQuestion=cfg.event.questions.filter(q=>q.type==='company'),linkedinQuestion=cfg.event.questions.filter(q=>q.type==='linkedin');
  const company=select('Company field',mappingOptions,cfg.fields?.company??(companyQuestion.length===1?companyQuestion[0].id:'')),title=select('Job-title field',mappingOptions,cfg.fields?.title??(companyQuestion.length===1?companyQuestion[0].id:'')),li=select('LinkedIn field',mappingOptions,cfg.fields?.linkedin??(linkedinQuestion.length===1?linkedinQuestion[0].id:''));
  const now=Date.now(),defaultStart=Math.max(now,cfg.event.start-3600000),defaultEnd=Math.max(now+3600000,cfg.event.end);
  const start=field('Monitoring starts (your local timezone)','datetime-local',localDate(cfg.monitorStart||defaultStart)),end=field('Monitoring ends','datetime-local',localDate(cfg.monitorEnd||defaultEnd)),retention=field('Delete workspace after','datetime-local',localDate(cfg.retentionEnd>now+86400000?cfg.retentionEnd:defaultEnd+7*86400000));
  const host=checkbox('This is the correct event, and I authorize read-only monitoring.',!!cfg.selected);
  const scope=checkbox('I authorize the selected professional questions for this purpose. Contact and sensitive questions are excluded.',!!cfg.selected);
  const research=checkbox('Research public professional names, companies, profiles, and portraits using Bright Data or Serper and Gemini. Do not send private answers or attendance to research providers.',!!cfg.selected);
  const audienceContainer=el('div',{class:'stack'}),audiences=[];
  function addAudience(a={}){
    const id=`aud-${audiences.length+1}`,name=field('Audience name','text',a.name||(audiences.length?'Sponsor':'Your team'),{required:true,maxLength:80}),website=field('Business website','url',a.website||'',{required:true,placeholder:'https://your-company.com'});
    const summary=el('textarea',{value:a.icp||'',placeholder:'Who should this team meet?',maxLength:1500});
    const qs=cfg.event.questions.map(q=>({q,c:checkbox(q.label,(a.questions||[...selected]).includes(q.id))}));
    const optq=select('Sponsor sharing opt-in question',mappingOptions,a.optInQuestion||''),optv=field('Exact opt-in answer','text',a.optInValue||'',{placeholder:'Yes'});
    const attendance=checkbox('Prioritize recorded check-ins within each priority group',a.attendanceFirst!==false);
    const ruleBox=el('div'),rules=[];
    function addRule(r={}){
      const f=select('Field',[['company','Company'],['title','Job title'],...cfg.event.questions.map(q=>[q.id,q.label])],r.field||'company'),op=select('Match',[['equals','Exactly equals'],['number_gte','Number ≥']],r.op||'equals'),value=field('Answer / value','text',r.value||''),points=field('Points','number',String(r.points??20),{min:-100,max:100}),group=field('Group (0 first; 9 last)','number',String(r.group||0),{min:0,max:9}),reason=field('Reason shown to the team','text',r.reason||'',{maxLength:200});
      const wrap=el('div',{class:'panel'},el('div',{class:'rule'},f.node,op.node,value.node,points.node,button('Remove',()=>{const i=rules.indexOf(entry);if(i>=0)rules.splice(i,1);wrap.remove();formDirty=true;})),el('div',{class:'grid'},group.node,reason.node));
      const entry={get:()=>({field:f.input.value,op:op.input.value,value:value.input.value,points:Number(points.input.value),group:Number(group.input.value),reason:reason.input.value})};rules.push(entry);ruleBox.append(wrap);
    }
    for(const r of a.rules||[])addRule(r);
    const item={get:()=>({id,name:name.input.value,website:website.input.value,icp:summary.value,questions:qs.filter(x=>x.c.input.checked).map(x=>x.q.id),rules:rules.map(r=>r.get()),attendanceFirst:attendance.input.checked,optInQuestion:optq.input.value,optInValue:optv.input.value})};audiences.push(item);
    const proposal=el('div');
    function showProposal(p){proposal.replaceChildren(el('div',{class:'good-banner stack'},el('p',{},p.summary),el('small',{},'Source excerpt: '+p.quote),el('a',{href:p.sources[0].url,target:'_blank',rel:'noopener noreferrer'},'Review business source'),
      button('Use this proposal — review rules below',()=>{summary.value=p.summary;ruleBox.replaceChildren();rules.length=0;for(const r of p.rules)addRule(r);formDirty=true;toast('Review the proposed rules, then save a fresh preview.');})));}
    const automatic=cfg.icpProposals?.[id];
    if(automatic?.proposal)showProposal(automatic.proposal);
    else if(automatic)proposal.append(el('p',{class:'muted'},automatic.state==='queued'?'Automatically researching this business website…':'Website research could not produce verified evidence. Supply and review your own customer profile and rules; no claims were invented.'));
    audienceContainer.append(el('fieldset',{class:'stack'},el('legend',{},id==='aud-1'?'Host audience':`Separate sponsor ${audiences.length-1}`),el('div',{class:'grid'},name.node,website.node),el('label',{},'Ideal customer profile',summary),el('details',{},el('summary',{},'Questions visible to this audience'),el('div',{class:'stack'},qs.map(x=>x.c.node))),attendance.node,
      el('h3',{},'Explainable ranking rules'),el('small',{},'Exact answer buckets work best for team-size ranges. Give larger teams more points. Group 9 always stays below group 0, even when checked in.'),ruleBox,button('Add priority rule',()=>addRule()),
      el('div',{class:'grid'},optq.node,optv.node),el('small',{},'Scoped sponsor keys include only people with this exact opt-in answer. No research or photos are shared with sponsor keys.'),
      cfg.selected?button('Suggest ICP from website',async()=>{
        if(!research.input.checked)throw new Error('Confirm the research purpose first.');
        const current=item.get();if(current.website!==cfg.audiences.find(x=>x.id===id)?.website)throw new Error('Save a new preview with this website first.');
        const p=await api('icp',{audience:id,researchConfirmed:true});
        showProposal(p);
      }):el('small',{},'Saving your first preview starts automatic website-based ICP research.'),proposal));
  }
  for(const a of cfg.audiences||[{}])addAudience(a);
  const form=el('form',{class:'stack',onInput:()=>{formDirty=true;},onSubmit:e=>{e.preventDefault();task(async()=>{
    await api('configure',{questions:[...selected],fields:{company:company.input.value,title:title.input.value,linkedin:li.input.value},audiences:audiences.map(a=>a.get()),monitorStart:new Date(start.input.value).toISOString(),monitorEnd:new Date(end.input.value).toISOString(),retentionEnd:new Date(retention.input.value).toISOString(),hostConfirmed:host.input.checked,fieldsConfirmed:scope.input.checked,researchConfirmed:research.input.checked});formDirty=false;await load();
  });}},el('section',{class:'panel stack'},el('p',{class:'eyebrow'},'STEP 2 · CONFIRM & CONFIGURE'),el('h2',{},cfg.event.name),el('p',{class:'muted'},`${dt(cfg.event.start)} · ${cfg.event.url}`),
    el('p',{class:'fineprint'},'Hosts excluded by provider identity: '+cfg.event.hosts.map(h=>h.name).join(', ')),host.node,
    el('fieldset',{class:'stack'},el('legend',{},'Professional questions — select up to five'),questionChecks.map(c=>c.node),scope.node),el('div',{class:'grid three'},company.node,title.node,li.node),
    el('div',{class:'grid three'},start.node,end.node,retention.node),research.node),audienceContainer,
    button('Add a separate sponsor audience',()=>{if(audiences.length>=5)throw new Error('Maximum five audiences.');addAudience();}),el('button',{class:'primary',type:'submit'},'Save settings & build complete preview'));
  app.replaceChildren(form);
  if(cfg.sync?.state==='scanning')app.prepend(el('div',{class:'good-banner'},'Reading and validating the entire Luma guest list. No partial roster will be published.'));
  if(cfg.sync?.error)app.prepend(el('div',{class:'error-banner'},errors[cfg.sync.error]||cfg.sync.error.replaceAll('_',' ')));
  if(preview) {
    const approved=checkbox('I reviewed the complete cohort and approve these scoring rules, team purpose, monitoring window, and retention.');
    app.prepend(el('section',{class:'panel stack'},el('p',{class:'eyebrow'},'STEP 3 · REVIEW & LAUNCH'),el('h2',{},`${preview.people.length} guests · hosts excluded`),
      el('div',{class:'table-scroll'},el('table',{class:'preview-table'},el('thead',{},el('tr',{},['Name','Company','Title','Check-in'].map(t=>el('th',{},t)))),el('tbody',{},preview.people.map(p=>el('tr',{},[p.name,p.company,p.title,p.checkedIn===null?'Unknown':p.checkedIn?'Checked in':'Not checked in'].map(v=>el('td',{},v))))))),
      el('small',{},'Unknown check-ins cannot prove absence. Research runs automatically after launch; ambiguous matches remain reviewable.'),approved.node,
      button('Launch my private event workspace',async()=>{if(formDirty)throw new Error('Save your changed settings and review a fresh preview first.');if(!approved.input.checked)throw new Error('Confirm your review before launch.');await api('activate',{revision:preview.revision,confirmed:true,icpApproved:true});await load();},true)));
  }
}
async function load(){if(isDemo){data=structuredClone(demoData);renderDashboard();return;}const generation=++viewGeneration;loadsInFlight++;try{const received=await api('dashboard?audience='+encodeURIComponent(audienceId));if(generation!==viewGeneration)return;data=received;
  if(!data.config.event||!data.config.connected&&data.role==='owner'&&!data.revision)connectView(data.config);else if(!data.revision)setupView(data.config,data.preview);else renderDashboard();
}catch(e){if(generation!==viewGeneration)return;if(e.code==='sign_in_required')login();else app.replaceChildren(el('section',{class:'panel narrow'},el('h2',{},'Workspace unavailable'),el('p',{},e.message),button('Try again',load)));}finally{loadsInFlight--;}}
function filtered(){return data.people.filter(p=>{
  const search=(p.name+' '+p.company+' '+p.title).toLocaleLowerCase();
  return search.includes(filters.search.toLocaleLowerCase())&&(filters.attendance==='all'||filters.attendance==='in'&&p.checkedIn===true||filters.attendance==='out'&&p.checkedIn===false||filters.attendance==='unknown'&&p.checkedIn===null)
    &&(filters.owner==='all'||(p.work?.owner||'none')===filters.owner)
    &&Object.entries(filters.answers).every(([q,v])=>!v||(Array.isArray(p.answers[q])?p.answers[q]:[p.answers[q]]).includes(v));
});}
function exportView(){const internal=data.role!=='viewer',research=data.people.some(p=>p.research);
  const rows=[['Name','Company','Title','LinkedIn','Recorded check-in','Fit score','Priority group','Fit reasons',...data.questions.map(q=>q.label),...(internal?['Owner','Follow-up']:[]),...(research?['Research status','Portrait status','Experience evidence','Sources']:[])],
    ...filtered().map(p=>[p.name,p.company,p.title,p.research?.linkedin||p.linkedin||'',p.checkedIn===null?'Unknown':p.checkedIn?'Yes':'No',p.score,p.group,p.reasons.join('; '),...data.questions.map(q=>fmt(p.answers[q.id])),
      ...(internal?[data.team.find(t=>t.id===p.work?.owner)?.name||'',p.work?.status||'new']:[]),...(research?[p.research?.state||'pending',p.research?.photoState||'pending',JSON.stringify(p.research?.facts||[]),(p.research?.sources||[]).map(s=>s.url).join('; ')]:[])])];
  const csv=rows.map(row=>row.map(v=>{let s=String(v??'');if(/^[\s]*[=+\-@]/.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"';}).join(',')).join('\r\n');
  const a=el('a',{href:URL.createObjectURL(new Blob(['\uFEFF'+csv],{type:'text/csv;charset=utf-8'})),download:'event-crm-view.csv'});a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);}
function personCard(p){const avatar=!isDemo&&p.research?.photoState==='stored'?portraits.get(p,record=>{
  const node=el('div',{class:'avatar'}),img=el('img',{src:`/api/w/${workspace}/photo/${encodeURIComponent(p.id)}`,alt:p.name+' — source-attributed portrait',loading:'lazy',onLoad:()=>{record.state='loaded';updatePhotoCounter();},onError:()=>{record.state='failed';node.replaceChildren(initials(p.name));updatePhotoCounter();}});node.append(img);return node;
}):el('div',{class:'avatar'},initials(p.name));
  const state=p.checkedIn===true?'● Checked in':p.checkedIn===false?'Not checked in':'Check-in unknown';
  const card=el('article',{class:'person'+(p.checkedIn?' checked':''),'data-person':p.id},el('div',{class:'person-head'},avatar,el('div',{},el('h3',{},p.name),el('p',{},[p.title,p.company].filter(Boolean).join(' · ')||'Professional details not collected')),el('span',{class:'pill'+(p.checkedIn?' checked':p.checkedIn===null?' warn':'')},state)),
    el('div',{class:'score'},el('strong',{},p.score),' fit points · '+(p.group?'Lower-priority group':'Primary group')),el('div',{class:'reasons'},p.reasons.join(' · ')||'No positive fit evidence in the approved answers'));
  const link=p.research?.linkedin||p.linkedin;if(link)card.append(el('a',{href:link,target:'_blank',rel:'noopener noreferrer'},'LinkedIn ↗'));
  if(data.role!=='viewer'){
    const owner=select('Assigned to',[['','Unassigned'],...data.team.map(t=>[t.id,t.name])],p.work?.owner||''),status=select('Follow-up',[['new','New'],['contacted','Contacted'],['meeting','Meeting'],['done','Done'],['skip','Not now']],p.work?.status||'new');
    const update=()=>task(async()=>{if(isDemo){p.work={...p.work,owner:owner.input.value||null,status:status.input.value,revision:p.work.revision+1};toast('Demo assignment updated — no real data changed.');return;}
      try{p.work=await api('work',{personId:p.id,audience:audienceId,owner:owner.input.value||null,status:status.input.value,revision:p.work?.revision||0});toast('Team work saved.');}catch(e){await load();throw e;}});
    owner.input.addEventListener('change',update);status.input.addEventListener('change',update);card.append(el('div',{class:'work-controls'},owner.node,status.node));
  }
  const detail=el('details',{},el('summary',{},'Answers & professional context'),data.questions.map(q=>el('div',{class:'answer'},el('b',{},q.label),fmt(p.answers[q.id])||'Not provided')));
  if(p.research){detail.append(el('div',{class:'answer'},el('b',{},'Research'),String(p.research.state||'pending').replaceAll('_',' '),el('p',{class:'muted'},p.research.reason||'Automatic research is queued separately from attendance.'),
    el('small',{},p.research.photoReason||'Portrait: '+String(p.research.photoState||'pending').replaceAll('_',' '))));
    for(const fact of p.research.facts||[])detail.append(el('div',{class:'answer'},el('b',{},[fact.title,fact.company,fact.period].filter(Boolean).join(' · ')),fact.quote,el('a',{href:fact.source,target:'_blank',rel:'noopener noreferrer'},' Source ↗')));
    if(p.research.sources?.length)detail.append(el('details',{},el('summary',{},'Evidence sources'),p.research.sources.map(s=>el('p',{},el('a',{href:s.url,target:'_blank',rel:'noopener noreferrer'},s.title||s.kind||'Source')))));
  }card.append(detail);return card;}
function updatePhotoCounter(){const {loaded,failed}=portraits.counts(),node=document.querySelector('#photo-counter');if(node)node.textContent=`${loaded} visible portraits loaded${failed?' · '+failed+' failed to render':''}`;}
function renderCards(){portraits.retain(data.people);const people=filtered();document.querySelector('#cards')?.replaceChildren(...(people.length?people.map(personCard):[el('div',{class:'empty'},'No attendees match these filters.')]));const count=document.querySelector('#view-count');if(count)count.textContent=`${people.length} of ${data.people.length} guests`;updatePhotoCounter();}
function renderDashboard(){formDirty=false;const cfg=data.config,stale=!isDemo&&Date.now()-data.capturedAt>180000;
  const search=field('Search guests','search',filters.search,{placeholder:'Name, company, or role'});search.input.addEventListener('input',()=>{filters.search=search.input.value;renderCards();});
  const attendance=select('Attendance',[['all','All attendance'],['in','Checked in'],['out','Not checked in'],['unknown','Unknown']],filters.attendance);attendance.input.addEventListener('change',()=>{filters.attendance=attendance.input.value;renderCards();});
  const owner=select('Owner',[['all','Everyone'],['none','Unassigned'],...data.team.map(t=>[t.id,t.name])],filters.owner);owner.input.addEventListener('change',()=>{filters.owner=owner.input.value;renderCards();});
  const checked=data.people.filter(p=>p.checkedIn===true).length,known=data.people.filter(p=>p.checkedIn!==null).length;
  app.replaceChildren(el('section',{class:'dash-header'},el('div',{class:'row space'},el('span',{class:'eyebrow'},isDemo?'INTERACTIVE DEMO · ALL PEOPLE ARE FICTIONAL':'YOUR PRIVATE EVENT WORKSPACE'),el('div',{class:'row'},button('Export this view',exportView),isDemo?button('Connect your event',()=>{location.href='/#setup';},true):button('Sign out',async()=>{await api('logout',{});login();}))),
    el('h1',{},cfg.event.name),el('div',{class:'status-line'},isDemo?'Fictional data · changes stay in this tab':`${String(cfg.sync?.state||'unknown').replaceAll('_',' ')} · last complete source check ${dt(data.capturedAt)}${stale?' · STALE':''}`)),
    isDemo?el('div',{class:'good-banner'},'Explore filters, ownership, and priority groups. No Luma key is used and no messages are sent.'):cfg.sync?.error?el('div',{class:'error-banner'},(errors[cfg.sync.error]||cfg.sync.error.replaceAll('_',' '))+' Last good data remains visible.'):el('span',{hidden:true}),
    cfg.researchState==='budget_paused'?el('div',{class:'error-banner'},'Automatic research paused at its spending limit. Completed profiles, portraits and team work remain available; attendance polling is independent.'):el('span',{hidden:true}),
    el('div',{class:'stats'},...[[data.people.length,'Guests in this view'],[checked,'Recorded check-ins'],[data.people.filter(p=>p.score>0).length,'Positive fit evidence'],[data.people.length-known,'Unknown attendance']].map(([n,t])=>el('div',{class:'stat'},el('strong',{},n),el('span',{},t)))),
    el('div',{class:'tabs'},data.audiences.map(a=>{const b=button(a.name,async()=>{audienceId=a.id;filters.answers={};if(isDemo){selectDemoAudience(data,a.id);renderDashboard();}else{history.replaceState(null,'',`/w/${workspace}/a/${a.id}`);await load();}});b.classList.toggle('selected',a.id===audienceId);return b;})),
    el('div',{class:'toolbar'},search.node,attendance.node,data.role!=='viewer'?owner.node:null,button('Clear filters',()=>{filters={search:'',attendance:'all',owner:'all',answers:{}};renderDashboard();})),
    el('div',{},data.questions.map(q=>{const values=[...new Set(data.people.flatMap(p=>Array.isArray(p.answers[q.id])?p.answers[q.id]:[p.answers[q.id]]).filter(v=>typeof v==='string'&&v.length&&v.length<100))].sort();
      if(values.length>12||!values.length)return null;return el('div',{class:'toolbar'},el('small',{},q.label),values.map(value=>{const b=button(value,()=>{filters.answers[q.id]=filters.answers[q.id]===value?'':value;renderDashboard();});b.classList.toggle('selected',filters.answers[q.id]===value);return b;}));})),
    el('div',{class:'row space'},el('p',{id:'view-count',class:'muted'}),el('small',{id:'photo-counter'})),el('section',{id:'cards',class:'cards'}));renderCards();
  if(!isDemo&&data.role==='owner')app.append(ownerControls(cfg));
}
function ownerControls(cfg){const box=el('details',{class:'panel'},el('summary',{},'Workspace controls & team access'));
  box.append(el('div',{class:'toolbar'},button(cfg.active?'Pause attendance polling':'Resume attendance polling',async()=>{await api('monitor',{active:!cfg.active});await load();}),
    button('Preview new / changed registrations',async()=>{await api('preview',{});toast('A complete new roster preview is being prepared.');await load();}),button('Reconnect Luma',()=>connectView(cfg)),
    button('Disconnect calendar key',async()=>{await api('disconnect',{});await load();})),el('small',{},`Retention ends ${dt(cfg.retentionEnd)}. Pausing or disconnecting does not delete saved data. Research and attendance are separate.`));
  if(data.preview){const approve=checkbox('Replace the frozen roster with this reviewed preview. Keep ownership by provider ID; clear changed identity research.');
    box.append(el('h3',{},`${data.preview.people.length} guests in the new preview`),el('div',{class:'table-scroll'},el('table',{class:'preview-table'},data.preview.people.map(p=>el('tr',{},el('td',{},p.name),el('td',{},p.company),el('td',{},p.title))))),approve.node,
      button('Adopt reviewed roster',async()=>{if(!approve.input.checked)throw new Error('Review and confirm the replacement roster.');await api('adopt',{revision:data.preview.revision,confirmed:true});await load();}));}
  const name=field('Named teammate / sponsor recipient','text','',{maxLength:80}),role=select('Permission',[['team','Team editor'],['viewer','Sponsor viewer']],'team'),scope=select('Audience scope',[['','All host audiences'],...cfg.audiences.map(a=>[a.id,a.name])],'');
  const keyOutput=el('div');box.append(el('h3',{},'Invite by private access key'),el('div',{class:'grid three'},name.node,role.node,scope.node),
    el('div',{class:'toolbar'},button('Generate named access key',async()=>{const result=await api('keys/create',{name:name.input.value,role:role.input.value,audience:scope.input.value||null});keyOutput.replaceChildren(el('div',{class:'good-banner stack'},el('p',{},'Share this key privately with '+result.name+'. It is shown once.'),el('div',{class:'key'},result.key),el('div',{class:'key'},`${location.origin}/w/${workspace}${result.audience?'/a/'+result.audience:''}`)));}),
      button('View & revoke existing keys',async()=>{const result=await api('keys');keyOutput.replaceChildren(el('small',{},`Workspace research reserved: $${result.budget.workspaceReservedUsd.toFixed(3)} / $${result.budget.workspaceLimitUsd}. This conservative estimate is not the shared provider account’s bill.`),...result.keys.map(k=>el('div',{class:'team-key row space'},el('span',{},`${k.name} · ${k.role}${k.audience?' · '+k.audience:''}${k.revoked?' · revoked':''}`),!k.revoked?button('Revoke',async()=>{await api('keys/revoke',{id:k.id});keyOutput.replaceChildren(el('p',{},'Key revoked. Existing sessions using it are invalid.'));}):null)));})),keyOutput,
    el('details',{},el('summary',{},'Delete workspace'),el('p',{},'This deletes the active workspace and revokes all access. Cloudflare infrastructure recovery copies may remain for its retention period. This cannot be undone in the app.'),
      (()=>{const confirmation=field('Type your workspace ID to confirm','text','',{placeholder:workspace});return el('div',{class:'stack'},confirmation.node,button('Delete this workspace',async()=>{if(confirmation.input.value!==workspace)throw new Error('Enter the exact workspace ID.');await api('delete',{confirm:workspace});location.href='/';}));})()));return box;}
function privacy(){app.replaceChildren(el('section',{class:'panel narrow privacy'},el('p',{class:'eyebrow'},'DATA BOUNDARIES'),el('h1',{},'Private by design.'),
  el('p',{},'The hosted beta supports Luma only. Luma Plus and calendar administrator access are required. Event CRM reads the exact event you confirm; it never approves guests, changes check-ins, or sends outreach.'),
  el('h2',{},'You choose the scope'),el('p',{},'Only selected professional signup answers are retained. Contact, immigration, health, and other sensitive questions are excluded. Hosts and cohosts are removed using Luma user identities, not names. Sponsor keys are separate, server-enforced scopes and require an exact mapped opt-in answer. Research is not included in sponsor views.'),
  el('h2',{},'Research is evidence, not certainty'),el('p',{},'With your approval, public professional identity inputs go to configured Bright Data or Serper search/page services and Gemini extraction. Private signup answers and attendance are not sent. Namesakes, blocked sources, and missing portraits stay explicitly unresolved. Search ranking is not identity verification; no generated portraits or face recognition are used.'),
  el('h2',{},'Your data outlives the poller—not your retention choice'),el('p',{},'Complete snapshots persist independently of polling. Old data is marked stale. The Luma key is encrypted and expires after the monitoring deadline; abandoned setups expire after 24 hours. The active workspace is deleted on your chosen retention date, within 30 days. Cloudflare infrastructure recovery copies may remain for its recovery-retention period.'),
  el('h2',{},'Access & limitations'),el('p',{},'Owner and backup keys are shown once. Named team keys can be revoked. These are bearer capabilities, not email-verified identities. There is no email reset service. Sessions use Secure, HttpOnly, same-site cookies, never URL tokens or browser localStorage. Beta limits are 500 guests, five professional questions, five audiences, and a 48-hour monitoring window.'),
  el('p',{},'Research and service quotas can pause new work; they never erase your last good snapshot. Public source code contains only fictional examples. Your workspace is not public.')));}
if(location.pathname==='/privacy')privacy();else if(workspace||isDemo)load();else landing();
setInterval(()=>{if(!workspace||busy||formDirty||loadsInFlight||document.hidden||app.querySelector('details[open]'))return;const focused=document.activeElement;if(focused&&['INPUT','SELECT','TEXTAREA'].includes(focused.tagName))return;
  if(data?.config?.active||data?.config?.sync?.state==='scanning'||data?.config?.researchState==='running'||Object.values(data?.config?.icpProposals||{}).some(j=>j?.state==='queued'))load();},20000);
