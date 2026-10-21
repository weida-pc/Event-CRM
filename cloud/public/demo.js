// Entirely fictional, static data. No provider calls or shared customer state.
export const demoData={role:'owner',keyId:'demo-owner',audience:{id:'aud-1',name:'Your team',attendanceFirst:true,icp:'Growing teams looking for a better way to run events.'},
  audiences:[{id:'aud-1',name:'Your team'},{id:'aud-2',name:'Team services sponsor'}],
  config:{id:'demo',event:{name:'The Founder Gathering',url:'https://luma.com/'},active:true,sync:{state:'demo'},retentionEnd:Date.now()+7*86400000},
  capturedAt:Date.now(),revision:1,extraCount:0,
  questions:[{id:'team',label:'How many people are on your team?'},{id:'timing',label:'When are you looking to start?'}],
  team:[{id:'demo-owner',name:'Alex'},{id:'demo-sam',name:'Sam'}],
  people:[
    {id:'fictional-1',name:'Jordan Avery',company:'Northstar Studio',title:'Co-founder',checkedIn:true,score:90,group:0,reasons:['Growing team · planning this quarter'],answers:{team:'51–100',timing:'This quarter'},work:{owner:'demo-owner',status:'new',revision:0},research:{state:'corroborated',photoState:'not_applicable',facts:[]}},
    {id:'fictional-2',name:'Casey Morgan',company:'Meadow Systems',title:'CEO',checkedIn:true,score:70,group:0,reasons:['Decision maker · team of 24'],answers:{team:'11–50',timing:'This quarter'},work:{owner:'demo-sam',status:'meeting',revision:0},research:{state:'corroborated',photoState:'not_applicable',facts:[]}},
    {id:'fictional-3',name:'Riley Chen',company:'Daybreak Labs',title:'Founder',checkedIn:false,score:95,group:0,reasons:['Larger team · near-term project'],answers:{team:'101+',timing:'This quarter'},work:{owner:null,status:'new',revision:0},research:{state:'pending',photoState:'pending',facts:[]}},
    {id:'fictional-4',name:'Taylor Ellis',company:'Common Ground',title:'Head of Operations',checkedIn:null,score:40,group:0,reasons:['Operations buyer · exploratory'],answers:{team:'11–50',timing:'Exploring'},work:{owner:null,status:'new',revision:0},research:{state:'candidate',photoState:'unresolved',reason:'A namesake needs another professional anchor.',facts:[]}},
    {id:'fictional-5',name:'Jamie Brooks',company:'Fieldwork',title:'Founder',checkedIn:false,score:20,group:0,reasons:['Early team'],answers:{team:'1–10',timing:'Later'},work:{owner:'demo-owner',status:'contacted',revision:0},research:{state:'pending',photoState:'pending',facts:[]}},
    {id:'fictional-6',name:'Avery Patel',company:'Quiet Hours',title:'Co-founder',checkedIn:true,score:0,group:9,reasons:['No current bandwidth · lower-priority group'],answers:{team:'1–10',timing:'No bandwidth'},work:{owner:null,status:'skip',revision:0},research:{state:'unresolved',photoState:'unresolved',facts:[]}}
  ]};

export function selectDemoAudience(data,id) {
  data.audience={...data.audiences.find(a=>a.id===id),attendanceFirst:id==='aud-1'};
  const sizes={'1–10':10,'11–50':40,'51–100':70,'101+':100};
  data.people=data.people.map(p=>{const original=demoData.people.find(x=>x.id===p.id);return {...p,
    score:id==='aud-1'?original.score:p.group===9?0:sizes[p.answers.team],
    reasons:id==='aud-1'?original.reasons:[p.group===9?'No current bandwidth · lower-priority group':'Team size: '+p.answers.team]};});
  data.people.sort((a,b)=>a.group-b.group||(id==='aud-1'?(Number(b.checkedIn===true)-Number(a.checkedIn===true)||b.score-a.score):(b.score-a.score||Number(b.checkedIn===true)-Number(a.checkedIn===true)))||a.name.localeCompare(b.name));
}
