import {Fault,requireThat,eventDetail,normalizeGuest,validateScan,statuses} from './core.mjs';
import {lumaClient} from './luma.mjs';
import {decrypt,hash,token} from './security.mjs';

export async function providerFor(workspace) {
  const cfg=workspace.db.get('config');
  requireThat(cfg?.encryptedKey,'luma_reconnect_required',403);
  const key=await decrypt(cfg.encryptedKey,workspace.env.KEY_ENCRYPTION_SECRET,cfg.id);
  const keyHash=await hash(key), client=lumaClient(key);
  return async(path,params)=>{
    try { await workspace.control.providerSlot(keyHash); }
    catch { throw new Fault('luma_rate_limited',429,60); }
    return client(path,params);
  };
}
function clearPages(db) { for(const [k] of db.prefix('scan-page:')) db.remove(k); }
export function startScan(workspace,{preview=false,attempt=0}={}) {
  const db=workspace.db,cfg=db.get('config'),now=Date.now();
  requireThat(cfg?.selected,'setup_required',409);
  requireThat(!db.get('scan'),'scan_in_progress',409);
  requireThat(preview||now<=cfg.monitorEnd+180000,'monitoring_ended',409);
  clearPages(db);
  db.put('scan',{generation:token(),preview,attempt,started:now,step:'before',page:0,cursors:[],nextAt:now});
  cfg.sync={...cfg.sync,state:'scanning',error:null}; db.put('config',cfg);
}
export async function scanStep(w) {
  const db=w.db,scan=db.get('scan'); if(!scan) return;
  const cfg=db.get('config'),now=Date.now();
  if(!cfg) return;
  const valid=()=>db.get('scan')?.generation===scan.generation && !!db.get('config');
  try {
    requireThat(now-scan.started<=150000,'scan_timeout',503);
    requireThat(scan.preview||now<=cfg.monitorEnd+180000,'monitoring_ended',409);
    const get=await providerFor(w);
    const detail=async()=>eventDetail(await get('/v1/events/get',{event_id:cfg.event.id}),cfg.event.calendarId,cfg.event.url);
    if(scan.step==='before') {
      const before=await detail(); if(!valid()) return;
      // Field definitions are frozen at host confirmation, not silently remapped.
      for(const q of cfg.selected) requireThat(JSON.stringify(before.questions.find(n=>n.id===q.id))===JSON.stringify(q),'question_changed',409);
      scan.before=before; scan.step='page';
    } else if(scan.step==='page') {
      requireThat(scan.page<10,'page_limit',502);
      const result=await get('/v1/events/guests/list',{event_id:cfg.event.id,pagination_limit:100,pagination_cursor:scan.cursor});
      if(!valid()) return;
      requireThat(Array.isArray(result.entries)&&result.entries.length<=100,'invalid_guest_page',502);
      const people=result.entries.map(r=>normalizeGuest(r,cfg.selected,cfg.fields));
      requireThat(people.every(p=>JSON.stringify(p).length<=3000),'guest_answer_limit',422);
      db.put('scan-page:'+String(scan.page).padStart(2,'0'),people); scan.page++;
      if(result.has_more===false) scan.step='after';
      else {
        requireThat(result.has_more===true&&typeof result.next_cursor==='string'&&result.next_cursor
          &&!scan.cursors.includes(result.next_cursor),'invalid_pagination',502);
        scan.cursor=result.next_cursor;scan.cursors.push(scan.cursor);
      }
    } else {
      const after=await detail(); if(!valid()) return;
      const rows=db.prefix('scan-page:').flatMap(([,r])=>r);
      requireThat(rows.length<=500,'event_too_large',422);
      const old=db.get('snapshot');
      // A separate explicit preview can propose cohort edits without changing live data.
      const result=validateScan(scan.before,after,rows,scan.preview?null:old?.people);
      const trueCount=rows.filter(p=>p.checkedIn===true).length,unknown=rows.filter(p=>p.checkedIn===null).length;
      requireThat(after.counts.checked_in>=trueCount&&after.counts.checked_in<=trueCount+unknown,'checkin_count_mismatch',502);
      const freshCfg=db.get('config'); if(!freshCfg) return;
      requireThat(scan.preview||Date.now()<=freshCfg.monitorEnd+180000,'monitoring_ended',409);
      const capturedAt=Date.now();
      db.transaction(()=>{
        if(scan.preview) db.put('preview',{people:result.guests,event:after,capturedAt,revision:token()});
        else {
          const live=new Map(result.guests.map(p=>[p.id,p]));
          // Attendance/status and sharing consent refresh; other answers and identity stay frozen.
          const consentFields=[...new Set(freshCfg.audiences.map(a=>a.optInQuestion).filter(Boolean))];
          db.put('snapshot',{...old,people:old.people.map(p=>({...p,checkedIn:live.get(p.id).checkedIn,status:live.get(p.id).status,
            answers:{...p.answers,...Object.fromEntries(consentFields.map(id=>[id,live.get(p.id).answers[id]??'']))}})),
            capturedAt,revision:old.revision+1,extraCount:result.extra.length});
        }
        freshCfg.sync={state:scan.preview?'preview_ready':scan.started>=freshCfg.monitorEnd?'ended':capturedAt>=freshCfg.monitorEnd?'finalizing':'live',
          error:null,lastSuccess:capturedAt,failures:0};
        if(!scan.preview && scan.started>=freshCfg.monitorEnd) freshCfg.finalScan=true;
        freshCfg.nextScan=scan.preview?null:Date.now()+60000;
        db.put('config',freshCfg);db.remove('scan');clearPages(db);
      });
      return;
    }
    if(valid()){ scan.nextAt=Date.now()+1000; db.put('scan',scan); }
  } catch(error) {
    if(!valid()) return;
    db.remove('scan');clearPages(db);
    const fresh=db.get('config');if(!fresh)return;
    const code=error instanceof Fault?error.code:'sync_unavailable';
    if(code==='source_changed'&&scan.attempt===0&&(scan.preview||Date.now()<fresh.monitorEnd+120000)) {
      startScan(w,{preview:scan.preview,attempt:1});return;
    }
    // A busy door is not an infrastructure outage. Keep strict validation, without
    // exponentially delaying the next complete attempt when the source is moving.
    const failures=code==='source_changed'?0:Math.min(6,(fresh.sync?.failures||0)+1);
    fresh.sync={...fresh.sync,state:'attention',error:code,failures};
    const permanent=['luma_reconnect_required','credential_unavailable','cohort_review_required','question_changed','attendance_unknown'];
    if(permanent.includes(code)) fresh.active=false;
    fresh.nextScan=Date.now()+Math.max(60000,error.retryAfter*1000||0,Math.min(3600000,60000*2**(failures-1)));
    db.put('config',fresh);
  }
}
