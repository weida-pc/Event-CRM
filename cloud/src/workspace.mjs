import {DurableObject} from 'cloudflare:workers';
import {Store} from './store.mjs';
import {Fault,requireThat,text,redact,rank} from './core.mjs';
import {token,hash,encrypt,cookie,json,errorResponse,input,sessionCookie,securityHeaders} from './security.mjs';
import {lumaClient,resolveEvent} from './luma.mjs';
import {configuration,keySpec} from './config.mjs';
import {startScan,scanStep} from './sync.mjs';
import {researchStep,queueResearch,queueICP,icpStep} from './research.mjs';

export class Workspace extends DurableObject {
  constructor(ctx,env) {super(ctx,env);this.db=new Store(ctx);this.control=env.CONTROL.getByName('control');}
  async initialize(id) {
    requireThat(!this.db.get('config'),'already_exists',409);
    const owner=token(),backup=token();
    const ownerHash=await hash(owner),backupHash=await hash(backup);
    this.db.transaction(()=>{
      this.db.put('config',{id,createdAt:Date.now(),retentionEnd:Date.now()+86400000,active:false,sync:{state:'setup'}});
      this.db.put('key:'+ownerHash,{id:token().slice(0,16),name:'Owner',role:'owner',audience:null,revoked:false});
      this.db.put('key:'+backupHash,{id:token().slice(0,16),name:'Backup owner',role:'owner',audience:null,revoked:false});
    });
    await this.schedule(); return {id,ownerKey:owner,backupKey:backup};
  }
  async authenticate(request) {
    const sessionToken=cookie(request);requireThat(sessionToken,'sign_in_required',401);
    const s=this.db.get('session:'+await hash(sessionToken));
    const key=s&&s.expires>Date.now()?this.db.get('key:'+s.keyHash):null;
    requireThat(key&&!key.revoked,'sign_in_required',401);return key;
  }
  keys() {return this.db.prefix('key:').map(([,v])=>v);}
  publicConfig(cfg) {
    return {id:cfg.id,event:cfg.event,selected:cfg.selected,fields:cfg.fields,audiences:cfg.audiences,
      monitorStart:cfg.monitorStart,monitorEnd:cfg.monitorEnd,retentionEnd:cfg.retentionEnd,
      active:cfg.active,sync:cfg.sync,connected:!!cfg.encryptedKey,researchState:cfg.researchPaused?'budget_paused':this.db.get('research-job')?'running':cfg.researchState,
      icpProposals:Object.fromEntries((cfg.audiences||[]).map(a=>[a.id,this.db.get('icp:'+a.id)]))};
  }
  peopleFor(key,cfg,snapshot,audienceId) {
    const audience=cfg.audiences?.find(a=>a.id===(key.audience||audienceId||cfg.audiences[0].id));
    requireThat(audience,'audience_not_found',404);
    requireThat(!key.audience||!audienceId||key.audience===audienceId,'scope_denied',403);
    let people=snapshot?.people||[];
    if(key.audience) {
      requireThat(audience.optInQuestion&&audience.optInValue,'sharing_consent_required',403);
      // A failed complete scan cannot certify that a previous sharing opt-in still holds.
      if(cfg.sync?.error)people=[];
      people=people.filter(p=>{
        const v=p.answers[audience.optInQuestion];return (Array.isArray(v)?v:[v]).includes(audience.optInValue);
      });
    }
    // Scope before score/explanation/filter/export. Research is not shared with sponsor keys.
    const permitted=field=>!key.audience||audience.questions.includes(cfg.fields?.[field]);
    people=people.map(p=>({id:p.id,name:p.name,company:permitted('company')?p.company:'',title:permitted('title')?p.title:'',linkedin:permitted('linkedin')?p.linkedin:null,
      checkedIn:p.checkedIn,status:p.status,
      answers:Object.fromEntries(audience.questions.map(id=>[id,p.answers[id]??''])),
      omittedAnswers:(p.omittedAnswers||[]).filter(id=>audience.questions.includes(id))}));
    return {audience,people:rank(people,audience.rules,audience.attendanceFirst)};
  }
  dashboard(key,cfg,audienceId) {
    const snapshot=this.db.get('snapshot');
    if(!snapshot) {
      requireThat(key.role==='owner','setup_in_progress',409);
      return {config:this.publicConfig(cfg),role:key.role,keyId:key.id,preview:this.db.get('preview'),people:[]};
    }
    const {audience,people}=this.peopleFor(key,cfg,snapshot,audienceId);
    return {role:key.role,keyId:key.id,audience,
      config:key.role==='owner'?this.publicConfig(cfg):{id:cfg.id,event:{name:cfg.event.name,url:cfg.event.url},sync:cfg.sync,retentionEnd:cfg.retentionEnd,active:cfg.active,
        researchState:key.audience?undefined:cfg.researchPaused?'budget_paused':this.db.get('research-job')?'running':cfg.researchState},
      audiences:(key.audience?[audience]:cfg.audiences).map(a=>({id:a.id,name:a.name})),
      questions:cfg.selected.filter(q=>audience.questions.includes(q.id)),
      people:people.map(p=>({...p,
        work:key.role==='viewer'?undefined:this.db.get(this.workKey(key,p.id),{revision:0,owner:null,status:'new'}),
        research:key.audience?undefined:this.db.get('research:'+p.id,{state:'pending',photoState:'pending'})})),
      capturedAt:snapshot.capturedAt,revision:snapshot.revision,
      extraCount:key.audience?undefined:snapshot.extraCount,
      team:key.role==='viewer'?[]:this.keys().filter(k=>!k.revoked&&k.role!=='viewer'&&(!key.audience||k.audience===key.audience)).map(k=>({id:k.id,name:k.name})),
      preview:key.role==='owner'?this.db.get('preview'):undefined};
  }
  workKey(key,id) {return key.audience?'scoped-work:'+key.audience+':'+id:'work:'+id;}
  async fetch(request) {
    try {
      let cfg=this.db.get('config');
      if(cfg&&cfg.retentionEnd<=Date.now()){await this.erase();throw new Fault('workspace_expired',404);}
      requireThat(cfg,'workspace_expired',404);
      const u=new URL(request.url),action=u.pathname.split('/').slice(4).join('/');
      const body=request.method==='POST'?await input(request):null;
      if(action==='login'&&request.method==='POST') {
        const r=this.db.get('login-rate',{until:0,n:0});if(r.until<Date.now()){r.n=0;r.until=Date.now()+60000;}
        requireThat(r.n<20,'rate_limited',429);r.n++;this.db.put('login-rate',r);
        requireThat(/^[A-Za-z0-9_-]{43}$/.test(body.key||''),'invalid_access_key',401);
        const keyHash=await hash(body.key),key=this.db.get('key:'+keyHash);
        requireThat(key&&!key.revoked,'invalid_access_key',401);
        requireThat(this.db.get('config'),'workspace_expired',404);
        for(const [k,v] of this.db.prefix('session:'))if(v.expires<Date.now()||this.db.get('key:'+v.keyHash)?.revoked)this.db.remove(k);
        const own=this.db.prefix('session:').filter(([,v])=>v.keyHash===keyHash).sort((a,b)=>a[1].expires-b[1].expires);
        for(const [k] of own.slice(0,Math.max(0,own.length-3)))this.db.remove(k);
        requireThat(this.db.prefix('session:').length<100,'session_limit',429);
        const s=token();this.db.put('session:'+await hash(s),{keyHash,expires:Date.now()+43200000});
        return json({ok:true},200,{'Set-Cookie':sessionCookie(s,cfg.id)});
      }
      const key=await this.authenticate(request);
      // Invalid sessions cannot drain the authenticated service request allowance.
      try {await this.control.takeRate('requests:global',5000,86400000);}
      catch {throw new Fault('capacity_paused',429,60);}
      // Authentication yields to other requests and alarms; never mutate its stale config.
      cfg=this.db.get('config');requireThat(cfg&&cfg.retentionEnd>Date.now(),'workspace_expired',404);
      if(request.method==='GET') {
        if(action==='dashboard')return json(this.dashboard(key,cfg,u.searchParams.get('audience')));
        if(action==='keys'){requireThat(key.role==='owner','owner_required',403);return json({keys:this.keys(),budget:await this.control.budget(cfg.id)});}
        if(action.startsWith('photo/')) {
          requireThat(!key.audience,'scope_denied',403);
          const personId=decodeURIComponent(action.slice(6)),snapshot=this.db.get('snapshot');
          requireThat(snapshot?.people.some(p=>p.id===personId),'not_found',404);
          requireThat(this.db.get('research:'+personId)?.state==='corroborated','portrait_review_required',409);
          const photo=this.db.get('photo:'+personId);requireThat(photo,'not_found',404);
          return new Response(Uint8Array.from(atob(photo.base64),c=>c.charCodeAt(0)),{headers:{...securityHeaders,'Content-Type':photo.mime}});
        }
        throw new Fault('not_found',404);
      }
      requireThat(request.method==='POST','method_not_allowed',405);
      if(action==='logout') {
        this.db.remove('session:'+await hash(cookie(request)));return json({ok:true},200,{'Set-Cookie':sessionCookie('',cfg.id,true)});
      }
      if(action==='work') {
        requireThat(['owner','team'].includes(key.role),'read_only',403);
        const {people}=this.peopleFor(key,cfg,this.db.get('snapshot'),body.audience);
        requireThat(people.some(p=>p.id===body.personId),'not_found',404);
        const workKey=this.workKey(key,body.personId),old=this.db.get(workKey,{revision:0,owner:null,status:'new'});
        requireThat(body.revision===old.revision,'work_conflict',409);
        requireThat(['new','contacted','meeting','done','skip'].includes(body.status),'invalid_work_status');
        const owner=body.owner?this.keys().find(k=>k.id===body.owner&&!k.revoked&&k.role!=='viewer'):null;
        requireThat(!body.owner||owner&&(!key.audience||owner.audience===key.audience),'invalid_owner');
        const next={revision:old.revision+1,owner:owner?.id||null,status:body.status,updatedAt:Date.now(),updatedBy:key.id};
        this.db.put(workKey,next);return json(next);
      }
      requireThat(key.role==='owner','owner_required',403);
      if(action==='connect') {
        requireThat(body.hostConfirmed===true,'authorization_required');
        requireThat(!cfg.monitorEnd||Date.now()<=cfg.monitorEnd,'monitoring_ended',409);
        requireThat(!this.db.get('scan'),'scan_in_progress',409);
        const get=lumaClient(body.apiKey),attempt=token();
        cfg.connectionAttempt=attempt;this.db.put('config',cfg);
        const kh=await hash(body.apiKey);
        const event=await resolveEvent(async(path,params)=>{try{await this.control.providerSlot(kh);}catch{throw new Fault('luma_rate_limited',429,60);}return get(path,params);},body.eventUrl);
        const encryptedKey=await encrypt(body.apiKey,this.env.KEY_ENCRYPTION_SECRET,cfg.id);
        const fresh=this.db.get('config');requireThat(fresh,'workspace_expired',404);
        requireThat(fresh.connectionAttempt===attempt,'connection_cancelled',409);
        requireThat(fresh.retentionEnd>Date.now()&&(!fresh.monitorEnd||Date.now()<=fresh.monitorEnd),'monitoring_ended',409);
        requireThat(!fresh.event||fresh.event.id===event.id&&fresh.event.calendarId===event.calendarId,'event_binding_immutable',409);
        delete fresh.connectionAttempt;fresh.event=event;fresh.encryptedKey=encryptedKey;
        if(this.db.get('snapshot')){fresh.sync={...fresh.sync,state:fresh.active?'scheduled':'paused',error:null};fresh.nextScan=Date.now();}
        this.db.put('config',fresh);await this.schedule();return json({event});
      }
      if(action==='configure') {
        requireThat(cfg.event&&!this.db.get('snapshot')&&!this.db.get('scan'),'configuration_locked',409);
        const setup=configuration(body,cfg.event);requireThat(setup.retentionEnd<=cfg.createdAt+30*86400000,'invalid_retention');
        Object.assign(cfg,setup);cfg.setupVersion=token();
        this.db.put('config',cfg);queueICP(this,cfg);this.db.remove('preview');startScan(this,{preview:true});await this.schedule();return json({ok:true});
      }
      if(action==='icp') {
        requireThat(cfg.audiences&&body.researchConfirmed===true,'authorization_required');
        const a=cfg.audiences.find(a=>a.id===body.audience);requireThat(a,'audience_not_found',404);
        const job=this.db.get('icp:'+a.id);requireThat(job?.state==='ready','icp_not_ready',409);return json(job.proposal);
      }
      if(action==='activate') {
        const preview=this.db.get('preview');requireThat(preview&&preview.revision===body.revision&&Date.now()-preview.capturedAt<300000,'fresh_preview_required',409);
        requireThat(body.confirmed===true&&body.icpApproved===true,'confirmation_required');
        requireThat(cfg.audiences.every(a=>this.db.get('icp:'+a.id)?.state!=='queued'),'icp_not_ready',409);
        requireThat(cfg.audiences.every(a=>a.icp&&a.rules.length),'icp_rules_required',409);
        const previous=this.db.get('snapshot');
        requireThat(!previous,'already_active',409);
        cfg.active=true;cfg.nextScan=Date.now();cfg.sync={state:'scheduled',lastSuccess:preview.capturedAt,error:null};
        this.db.transaction(()=>{
          this.db.put('config',cfg);this.db.put('snapshot',{people:preview.people,capturedAt:preview.capturedAt,revision:1,extraCount:0});
          this.db.remove('preview');queueResearch(this,rank(preview.people,cfg.audiences[0].rules,cfg.audiences[0].attendanceFirst));
        });await this.schedule();return json({ok:true});
      }
      if(action==='preview') {
        startScan(this,{preview:true});await this.schedule();return json({ok:true});
      }
      if(action==='adopt') {
        const preview=this.db.get('preview'),old=this.db.get('snapshot');
        requireThat(old&&preview&&body.confirmed===true&&preview.revision===body.revision&&Date.now()-preview.capturedAt<300000,'fresh_preview_required',409);
        const existing=new Map(old.people.map(p=>[p.id,p]));
        this.db.transaction(()=>{
          const identity=p=>p&&JSON.stringify([p.userId,p.name,p.company,p.title,p.linkedin]);
          for(const p of preview.people) if(identity(existing.get(p.id))!==identity(p)) {
            this.db.remove('research:'+p.id);this.db.remove('photo:'+p.id);
          }
          const retained=new Set(preview.people.map(p=>p.id));
          for(const p of old.people)if(!retained.has(p.id))for(const prefix of ['work:','research:','photo:'])this.db.remove(prefix+p.id);
          for(const [k] of this.db.prefix('scoped-work:'))if(!retained.has(k.split(':').slice(2).join(':')))this.db.remove(k);
          const hashes=this.db.get('photo-hashes',{});
          for(const id of Object.keys(hashes))if(!retained.has(id)||identity(existing.get(id))!==identity(preview.people.find(p=>p.id===id)))delete hashes[id];
          this.db.put('photo-hashes',hashes);
          this.db.put('snapshot',{people:preview.people,capturedAt:preview.capturedAt,revision:old.revision+1,extraCount:0});
          this.db.remove('preview');queueResearch(this,rank(preview.people,cfg.audiences[0].rules,cfg.audiences[0].attendanceFirst));
          cfg.active=!!(cfg.active&&cfg.encryptedKey&&Date.now()<=cfg.monitorEnd);cfg.nextScan=Date.now();
          cfg.sync={state:cfg.active?'scheduled':'paused',lastSuccess:preview.capturedAt,error:null};this.db.put('config',cfg);
        });await this.schedule();return json({ok:true});
      }
      if(action==='monitor') {
        requireThat(this.db.get('snapshot'),'setup_required',409);
        requireThat(typeof body.active==='boolean','invalid_input');
        if(body.active) requireThat(cfg.encryptedKey&&Date.now()<=cfg.monitorEnd,'monitoring_ended',409);
        cfg.active=body.active;cfg.nextScan=Date.now();cfg.sync={...cfg.sync,state:body.active?'scheduled':'paused'};
        this.db.put('config',cfg);if(!body.active){this.db.remove('scan');for(const [k] of this.db.prefix('scan-page:'))this.db.remove(k);}
        await this.schedule();return json({ok:true});
      }
      if(action==='disconnect') {
        delete cfg.connectionAttempt;delete cfg.encryptedKey;cfg.active=false;cfg.sync={...cfg.sync,state:'disconnected'};this.db.put('config',cfg);this.db.remove('scan');
        for(const [k] of this.db.prefix('scan-page:'))this.db.remove(k);
        await this.schedule();return json({ok:true});
      }
      if(action==='keys/create') {
        requireThat(cfg.audiences&&this.keys().filter(k=>!k.revoked).length<25,'key_limit');
        const spec=keySpec(body,cfg);
        if(spec.audience){const a=cfg.audiences.find(a=>a.id===spec.audience);requireThat(a.optInQuestion&&a.optInValue,'sharing_consent_required');}
        const value=token(),keyHash=await hash(value),entry={...spec,id:token().slice(0,16),revoked:false};
        requireThat(this.db.get('config'),'workspace_expired',404);
        requireThat(this.keys().filter(k=>!k.revoked).length<25&&this.keys().length<100,'key_limit');
        this.db.put('key:'+keyHash,entry);return json({...entry,key:value});
      }
      if(action==='keys/revoke') {
        const pair=this.db.prefix('key:').find(([,k])=>k.id===body.id);requireThat(pair,'not_found',404);
        requireThat(pair[1].role!=='owner'||this.keys().filter(k=>k.role==='owner'&&!k.revoked).length>1,'last_owner_key');
        pair[1].revoked=true;this.db.put(...pair);
        for(const [k,v] of this.db.prefix('session:'))if('key:'+v.keyHash===pair[0])this.db.remove(k);
        return json({ok:true});
      }
      if(action==='delete') {
        requireThat(body.confirm===cfg.id,'confirmation_required');await this.erase();return json({ok:true},200,{'Set-Cookie':sessionCookie('',cfg.id,true)});
      }
      throw new Fault('not_found',404);
    } catch(error){return errorResponse(error);}
  }
  async erase() {
    const id=this.db.get('config')?.id;this.db.remove('config'); // In-flight work cannot resurrect deleted data.
    await this.ctx.storage.deleteAlarm();await this.ctx.storage.deleteAll();
    this.db=new Store(this.ctx);if(id)await this.control.forget(id);
  }
  async schedule() {
    const cfg=this.db.get('config');if(!cfg)return;
    const now=Date.now(),scan=this.db.get('scan');
    const dates=[cfg.retentionEnd];
    if(cfg.encryptedKey&&cfg.monitorEnd)dates.push(cfg.monitorEnd+180001);
    const backgroundAt=cfg.backgroundRetryAt||now;
    if(scan)dates.push(Math.max(backgroundAt,scan.nextAt||now));
    else if(cfg.active&&!cfg.finalScan)dates.push(Math.max(backgroundAt,cfg.monitorStart,Math.min(cfg.nextScan||now,cfg.monitorEnd+180000)));
    const research=this.db.get('research-job');if(research&&!cfg.researchPaused)dates.push(Math.max(backgroundAt,research.nextAt||now));
    for(const [,job] of this.db.prefix('icp:'))if(job.state==='queued')dates.push(Math.max(backgroundAt,job.nextAt||now));
    await this.ctx.storage.setAlarm(Math.max(now+1000,Math.min(...dates)));
  }
  async alarm() {
    let cfg=this.db.get('config');if(!cfg)return;
    if(Date.now()>=cfg.retentionEnd){await this.erase();return;}
    try {
      if(cfg.encryptedKey&&Date.now()>cfg.monitorEnd+180000) {
        cfg.active=false;delete cfg.connectionAttempt;delete cfg.encryptedKey;cfg.sync={...cfg.sync,state:'ended',error:cfg.finalScan?null:'final_scan_not_completed'};
        this.db.put('config',cfg);this.db.remove('scan');
        for(const [k] of this.db.prefix('scan-page:'))this.db.remove(k);
      }
      if((cfg.backgroundRetryAt||0)>Date.now())return;
      const capacity=await this.control.backgroundSlot();
      cfg=this.db.get('config');if(!cfg)return;
      if(!capacity.ok) {
        cfg.backgroundRetryAt=capacity.retryAt;cfg.sync={...cfg.sync,error:'background_capacity_paused'};
        this.db.put('config',cfg);this.db.remove('scan');
        for(const [k] of this.db.prefix('scan-page:'))this.db.remove(k);
        return;
      }
      if(cfg.backgroundRetryAt){delete cfg.backgroundRetryAt;this.db.put('config',cfg);}
      if(!this.db.get('scan')&&cfg.active&&!cfg.finalScan&&Date.now()>=Math.max(cfg.monitorStart,cfg.nextScan||0)
        &&Date.now()<=cfg.monitorEnd+180000) startScan(this);
      const scan=this.db.get('scan');
      if(scan&&scan.nextAt<=Date.now())await scanStep(this);
      if(!this.db.get('scan'))await icpStep(this);
      // Separate bounded work step; never runs as part of source normalization or publication.
      const job=this.db.get('research-job');
      if(job&&!this.db.get('scan')&&!this.db.get('config')?.researchPaused&&job.nextAt<=Date.now())await researchStep(this);
      cfg=this.db.get('config');if(cfg?.finalScan){cfg.active=false;delete cfg.connectionAttempt;delete cfg.encryptedKey;this.db.put('config',cfg);}
    } catch {
      cfg=this.db.get('config');if(cfg){cfg.sync={...cfg.sync,error:'background_unavailable'};cfg.nextScan=Date.now()+60000;this.db.put('config',cfg);}
    } finally {await this.schedule();}
  }
}
