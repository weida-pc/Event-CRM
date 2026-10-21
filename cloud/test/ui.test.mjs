// Exercise shipped browser functions offline. Only module imports and boot routing
// are removed; rendering/loading/export logic is the production source unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {Portraits} from '../public/portraits.js';
class Element {
  constructor(){this.children=[];this.textContent='';this.classList={toggle(){}};}
  append(...children){this.children.push(...children);}
  replaceChildren(...children){this.children=children.map(v=>v instanceof Element?v:String(v));}
  addEventListener(){}
  setAttribute(){}
  querySelector(){return this.openDetails?{}:null;}
  click(){}
}
function ui(fetcher){
  const app=new Element(),notice=new Element();let interval,download;
  const document={hidden:false,activeElement:null,querySelector:s=>s==='#app'?app:notice,querySelectorAll:()=>[],createElement:()=>new Element(),createTextNode:text=>Object.assign(new Element(),{textContent:text})};
  const context=vm.createContext({document,Node:Element,Portraits,location:{pathname:'/w/'+ 'a'.repeat(24)},
    fetch:fetcher,AbortSignal,Blob,URL:{createObjectURL:blob=>{download=blob;return 'blob:synthetic';},revokeObjectURL(){}},
    setInterval:fn=>{interval=fn;},setTimeout(){},demoData:{},selectDemoAudience(){}});
  let source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8').replace(/^import .*;\r?\n/gm,'');
  source=source.replace(/^if\(location.pathname==='\/privacy'\).*;\r?$/m,'');
  vm.runInContext(source,context);
  return {context,app,document,interval:()=>interval(),download:()=>download};
}
test('late successful or failed dashboard response cannot reopen data after sign-out',async()=>{
  for(const rejected of [false,true]){
    let resolve;const {context}=ui(()=>new Promise(r=>{resolve=r;}));
    vm.runInContext('let rendered=0; renderDashboard=()=>{rendered++}; let pending=load(); login();',context);
    resolve({ok:!rejected,json:async()=>rejected?{error:'scope_denied'}:{config:{event:{}},revision:1,people:[]}});
    await vm.runInContext('pending',context);
    assert.equal(vm.runInContext('rendered',context),0);assert.equal(vm.runInContext('data',context),undefined);
  }
});
test('automatic refresh does not interrupt open controls or focused edits, and avoids overlapping loads',async()=>{
  let calls=0,resolve;const h=ui(()=>{calls++;return new Promise(r=>{resolve=r;});});
  vm.runInContext('data={config:{active:true}}; renderDashboard=()=>{};',h.context);
  h.app.openDetails=true;h.interval();assert.equal(calls,0);
  h.app.openDetails=false;h.document.activeElement={tagName:'INPUT'};h.interval();assert.equal(calls,0);
  h.document.activeElement=null;h.interval();h.interval();assert.equal(calls,1);
  resolve({ok:true,json:async()=>({config:{event:{}},revision:1,people:[]})});await new Promise(r=>setImmediate(r));
});
test('CSV uses only the filtered view, escapes formula cells, and excludes sponsor work/research columns',async()=>{
  const h=ui(()=>{throw new Error('No HTTP in export test');});
  h.context.fixture={role:'viewer',questions:[],team:[],people:[
    {id:'one',name:'=2+2',company:'Example Labs',title:'Founder',answers:{},checkedIn:null,score:0,group:0,reasons:[]},
    {id:'two',name:'Riley Example',company:'Different Labs',title:'Founder',answers:{},checkedIn:false,score:0,group:0,reasons:[]}]};
  vm.runInContext("data=fixture; filters.search='=2+2'; exportView();",h.context);
  const csv=await h.download().text();assert.equal(csv.split('\r\n').length,2);assert.ok(csv.includes('"\'=2+2"'));assert.ok(csv.includes('Unknown'));
  assert.ok(!csv.includes('Riley'));assert.ok(!csv.includes('Follow-up'));assert.ok(!csv.includes('Experience evidence'));
});
test('optional dashboard banners never render literal null strings',()=>{
  const h=ui(()=>{throw new Error('No HTTP in rendering test');});
  h.context.fixture={role:'viewer',config:{event:{name:'Synthetic event'},sync:{state:'paused'}},people:[],team:[],questions:[],audiences:[],capturedAt:Date.now()};
  vm.runInContext('data=fixture; renderDashboard();',h.context);
  assert.ok(!h.app.children.includes('null'));assert.ok(!h.app.children.includes('undefined'));
});
