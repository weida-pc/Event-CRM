import test from 'node:test';
import assert from 'node:assert/strict';
import {Portraits} from '../public/portraits.js';
const person=()=>({id:'synthetic',name:'Jordan Example',company:'Example Labs',title:'Founder',research:{photoState:'stored',updatedAt:1}});
test('polling and filters reuse the exact portrait node and count only connected images',()=>{
  const c=new Portraits(),p=person();let created=0;
  const create=r=>{created++;r.state='loaded';return {isConnected:true};};
  const first=c.get(p,create);c.retain([p]);assert.equal(c.get(structuredClone(p),create),first);assert.equal(created,1);
  assert.deepEqual(c.counts(),{loaded:1,failed:0});first.isConnected=false;assert.deepEqual(c.counts(),{loaded:0,failed:0});
  first.isConnected=true;assert.equal(c.get(p,create),first);
});
test('identity, portrait revision, scope and logout discard cached nodes',()=>{
  const c=new Portraits(),p=person(),create=()=>({isConnected:false}),first=c.get(p,create);
  p.company='Different Labs';assert.notEqual(c.get(p,create),first);const second=c.get(p,create);
  p.research.updatedAt=2;assert.notEqual(c.get(p,create),second);const third=c.get(p,create);
  c.retain([{...p,research:undefined}]);assert.notEqual(c.get(p,create),third);c.clear();assert.equal(c.records.size,0);
});
