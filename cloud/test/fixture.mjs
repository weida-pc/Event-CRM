// Fictional provider fixtures. Never contact a live provider from tests.
import {Response} from 'miniflare';
export const questions=[
  {id:'company',label:'Company and job title',question_type:'company'},
  {id:'size',label:'Team size',question_type:'select',options:['1','2–10','11–50']},
  {id:'optin',label:'Share professional registration with sponsors?',question_type:'select',options:['Yes','No']},
  {id:'hidden',label:'Private email',question_type:'text'}
];
export const people=()=>['host','one','two'].map((id,i)=>({id:'g-'+id,user_id:'u-'+id,user_name:i===0?'Host Example':i===1?'Jordan Example':'Riley Example',approval_status:'approved',
  user_email:'private@example.org',registration_answers:[
    {question_id:'company',label:questions[0].label,question_type:'company',value:{company:'Example Labs',job_title:'Founder'}},
    {question_id:'size',label:'Team size',question_type:'select',value:i===1?'11–50':'2–10'},
    {question_id:'optin',label:questions[2].label,question_type:'select',value:i===1?'Yes':'No'},
    {question_id:'hidden',label:'Private email',question_type:'text',value:'private@example.org'}
  ],event_tickets:[{checked_in_at:null}]}));
export function fixture(){
  const state={rows:people(),calls:[],fail:false,broken:false};
  state.event=()=>({id:'evt-one',calendar_id:'cal-one',access:'manage',url:'https://luma.com/fictional-demo',name:'Fictional Founder Gathering',
    start_at:new Date(Date.now()+3600000).toISOString(),end_at:new Date(Date.now()+7200000).toISOString(),
    hosts:[{id:'u-host',name:'Host Example'}],registration_questions:questions,
    guest_counts:Object.fromEntries(['approved','pending_approval','waitlist','invited','declined','checked_in'].map(k=>[k,{guests:k==='approved'?state.rows.length:k==='checked_in'?state.rows.filter(r=>r.event_tickets?.[0]?.checked_in_at).length:0}]))});
  state.fetch=async request=>{
    const u=new URL(request.url);state.calls.push({host:u.hostname,path:u.pathname,method:request.method});
    if(u.hostname==='public-api.luma.com'){
      if(state.fail)return new Response('SYNTHETIC RAW SECRET',{status:401});
      if(u.pathname==='/v1/calendars/get')return Response.json({id:'cal-one'});
      if(u.pathname==='/v1/calendars/events/list')return Response.json({entries:[state.event()],has_more:false});
      if(u.pathname==='/v1/events/get')return Response.json(state.event());
      if(u.pathname==='/v1/events/guests/list'){
        const second=u.searchParams.has('pagination_cursor');
        return Response.json({entries:state.broken?[]:second?state.rows.slice(2):state.rows.slice(0,2),has_more:!second,next_cursor:second?null:'page-2'});
      }
    }
    if(u.hostname==='scrape.serper.dev')return Response.json({text:'Example Business helps teams with more than ten people organize their employee benefits and payroll. This business serves growing employers.',title:'Example Business'});
    if(u.hostname==='google.serper.dev')return Response.json(u.pathname==='/images'?{images:[]}:{organic:[]});
    if(u.hostname==='generativelanguage.googleapis.com')return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({summary:'Growing employers with more than ten people.',quote:'Example Business helps teams with more than ten people organize their employee benefits and payroll.',rules:[{field:'size',op:'equals',value:'11–50',points:30,group:0,reason:'Larger employer'}]})}]}}]});
    throw new Error('Unexpected external call: '+u.origin+u.pathname);
  };
  return state;
}
export function setup(){const now=Date.now();return {questions:['company','size','optin'],fields:{company:'company',title:'company'},
  hostConfirmed:true,fieldsConfirmed:true,researchConfirmed:true,
  monitorStart:new Date(now).toISOString(),monitorEnd:new Date(now+7200000).toISOString(),retentionEnd:new Date(now+86400000).toISOString(),
  audiences:[{id:'aud-1',name:'Host team',website:'https://www.example.org/',icp:'Growing employers',questions:['company','size','optin'],
    rules:[{field:'size',op:'equals',value:'11–50',points:30,group:0,reason:'Larger employer'}]},
    {id:'aud-2',name:'Example Sponsor',website:'https://www.example.org/',icp:'Employer services',questions:['size','optin'],optInQuestion:'optin',optInValue:'Yes',
      rules:[{field:'size',op:'equals',value:'11–50',points:30,group:0,reason:'Larger employer'}]}]};}
