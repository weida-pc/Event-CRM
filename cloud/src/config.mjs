import {requireThat,text,redact,publicUrl,stamp} from './core.mjs';

export function configuration(body,event,now=Date.now()) {
  requireThat(body.hostConfirmed===true&&body.fieldsConfirmed===true&&body.researchConfirmed===true,'authorization_required');
  requireThat(Array.isArray(body.questions)&&body.questions.length<=5,'question_limit');
  const selected=body.questions.map(id=>event.questions.find(q=>q.id===id));
  requireThat(selected.every(Boolean)&&new Set(body.questions).size===selected.length,'invalid_question');
  const fields={};
  for(const field of ['company','title','linkedin']) {
    if(body.fields?.[field]) {
      const q=selected.find(q=>q.id===body.fields[field]);
      requireThat(q&&!q.multiple&&q.type!=='agree-check','invalid_field_mapping');fields[field]=q.id;
    }
  }
  requireThat(Array.isArray(body.audiences)&&body.audiences.length>=1&&body.audiences.length<=5,'audience_limit');
  const audiences=body.audiences.map((a,i)=>{
    requireThat(a.id===`aud-${i+1}`,'invalid_audience');
    requireThat(Array.isArray(a.questions)&&a.questions.every(id=>body.questions.includes(id)),'invalid_audience_question');
    requireThat(Array.isArray(a.rules)&&a.rules.length<=20,'rule_limit');
    const rules=a.rules.map(r=>{
      requireThat(['company','title',...a.questions].includes(r.field)&&['equals','number_gte'].includes(r.op),'invalid_rule');
      requireThat(Number.isInteger(r.points)&&r.points>=-100&&r.points<=100&&Number.isInteger(r.group||0)&&(r.group||0)>=0&&(r.group||0)<=9,'invalid_points');
      const value=redact(r.value,300);
      requireThat(value&&(r.op!=='number_gte'||/^\d+(?:\.\d+)?$/.test(value)),'invalid_rule_value');
      return {field:r.field,op:r.op,value,points:r.points,group:r.group||0,reason:redact(r.reason,200)};
    });
    return {id:a.id,name:redact(a.name,80),website:publicUrl(a.website),icp:redact(a.icp||'',1500),
      questions:[...new Set(a.questions)],rules,attendanceFirst:a.attendanceFirst!==false,
      optInQuestion:a.optInQuestion&&a.questions.includes(a.optInQuestion)?a.optInQuestion:null,
      optInValue:a.optInValue?redact(a.optInValue,300):null};
  });
  const monitorStart=stamp(body.monitorStart),monitorEnd=stamp(body.monitorEnd),retentionEnd=stamp(body.retentionEnd);
  requireThat(monitorStart>=now-86400000&&monitorEnd>Math.max(now,monitorStart)&&monitorEnd-monitorStart<=48*3600000
    &&monitorEnd<=now+30*86400000,'invalid_monitor_window');
  requireThat(retentionEnd>monitorEnd&&retentionEnd<=now+30*86400000,'invalid_retention');
  return {selected,fields,audiences,monitorStart,monitorEnd,retentionEnd};
}
export function keySpec(body,cfg) {
  requireThat(['team','viewer'].includes(body.role),'invalid_role');
  const audience=body.audience||null;
  requireThat(!audience||cfg.audiences.some(a=>a.id===audience),'invalid_scope');
  requireThat(body.role!=='viewer'||audience,'viewer_scope_required');
  const name=redact(body.name,80);requireThat(name,'name_required');
  return {name,role:body.role,audience};
}
