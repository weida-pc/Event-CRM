import {DurableObject} from 'cloudflare:workers';
import {Store} from './store.mjs';
import {requireThat} from './core.mjs';
import {token} from './security.mjs';

// Only reachable through the Worker's binding, never through a public route.
export class Control extends DurableObject {
  constructor(ctx,env) { super(ctx,env); this.db=new Store(ctx); }
  takeRate(key,limit,windowMs) {
    const now=Date.now(), previous=this.db.get('rate:'+key);
    const state=previous&&previous.until>now?previous:{n:0,until:now+windowMs};
    requireThat(state.n<limit,'rate_limited',429); state.n++; this.db.put('rate:'+key,state);
    // Low-volume bounded beta. Sweep expired counters opportunistically, without a permanent timer.
    if(Math.random()<0.02) for(const [k,v] of this.db.prefix('rate:')) if(v.until<now) this.db.remove(k);
    return true;
  }
  create(ipHash) {
    this.takeRate('create:'+ipHash,3,3600000); this.takeRate('create:global',5,86400000);
    this.takeRate('create:month:'+new Date().toISOString().slice(0,7),20,32*86400000);
    const id=token().slice(0,24), expires=Date.now()+31*86400000;
    this.db.put('workspace:'+id,{expires}); return id;
  }
  exists(id) { const w=this.db.get('workspace:'+id); return !!w&&w.expires>Date.now(); }
  forget(id) { this.db.remove('workspace:'+id); }
  providerSlot(keyHash) { return this.takeRate('luma:'+keyHash,120,60000); }
  backgroundSlot() {
    // Keep paid-free-tier write headroom for retained dashboards and team work.
    // This bounds this app, not unrelated Workers on a shared Cloudflare account.
    const day=new Date().toISOString().slice(0,10);
    try {this.takeRate('background:'+day,3000,2*86400000);return {ok:true};}
    catch {return {ok:false,retryAt:Date.parse(day+'T00:00:00Z')+86400000};}
  }
  reserve(id,operation,microUsd) {
    requireThat(this.exists(id),'not_found',404);
    requireThat(Number.isSafeInteger(microUsd)&&microUsd>0&&microUsd<=100000,'invalid_reservation');
    const month=new Date().toISOString().slice(0,7), key='budget:'+month;
    const total=this.db.get(key,{reserved:0,workspaces:{}});
    // $40 service ceiling + $50 Cloudflare allowance leaves $10 contingency. This is
    // an app-enforced upper estimate, NOT a cap on other clients of shared accounts.
    const globalCap=Math.min(40_000_000,Number(this.env.MONTHLY_RESEARCH_MICRO_USD)||40_000_000);
    const perWorkspace=15_000_000;
    const amount=this.db.get('budget:ws:'+id,{reserved:0}).reserved;
    requireThat(total.reserved+microUsd<=globalCap&&amount+microUsd<=perWorkspace,'budget_paused',429);
    total.reserved+=microUsd; total.workspaces[id]=amount+microUsd; this.db.put(key,total);
    this.db.put('budget:ws:'+id,{reserved:amount+microUsd});
    return {operation,reserved:microUsd}; // No refunds: ambiguous network charges remain reserved.
  }
  budget(id) {
    return {workspaceReservedUsd:this.db.get('budget:ws:'+id,{reserved:0}).reserved/1e6,workspaceLimitUsd:15,monthlyServiceLimitUsd:40};
  }
}
