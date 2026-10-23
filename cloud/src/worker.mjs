import {Fault,requireThat} from './core.mjs';
import {hash,input,json,errorResponse,mutationOrigin,securityHeaders} from './security.mjs';
export {Workspace} from './workspace.mjs';
export {Control} from './control.mjs';

export default {
  async fetch(request,env) {
    try {
      const url=new URL(request.url);
      if(!url.pathname.startsWith('/api/')) {
        const r=await env.ASSETS.fetch(request);const response=new Response(r.body,r);
        for(const [k,v] of Object.entries(securityHeaders))response.headers.set(k,v);
        return response;
      }
      if(url.pathname==='/api/health')return json({ok:true,provider:'luma',admission:env.LIVE_ADMISSION==='open'?'open':'closed'});
      if(request.method!=='GET')mutationOrigin(request);
      requireThat(['GET','POST'].includes(request.method),'method_not_allowed',405);
      const control=env.CONTROL.getByName('control');
      if(url.pathname==='/api/workspaces'&&request.method==='POST') {
        const researchReady=env.GEMINI_API_KEY&&((env.BRIGHTDATA_API_KEY&&env.BRIGHTDATA_SERP_ZONE&&env.BRIGHTDATA_PAGE_ZONE)||env.SERPER_API_KEY);
        requireThat(env.LIVE_ADMISSION==='open'&&env.KEY_ENCRYPTION_SECRET&&researchReady,'onboarding_paused',503);
        const body=await input(request);requireThat(body.agree===true,'authorization_required');
        const ipHash=await hash((request.headers.get('cf-connecting-ip')||'local')+env.KEY_ENCRYPTION_SECRET);
        let id;try{id=await control.create(ipHash);}catch{throw new Fault('capacity_paused',429,60);}
        return json(await env.WORKSPACES.getByName(id).initialize(id),201);
      }
      const m=url.pathname.match(/^\/api\/w\/([A-Za-z0-9_-]{24})\/[a-z/]+(?:[^?]*)$/);
      requireThat(m&&await control.exists(m[1]),'not_found',404);
      // Bound unauthenticated ingress separately; only valid sessions use the global allowance.
      const ipHash=await hash((request.headers.get('cf-connecting-ip')||'local')+env.KEY_ENCRYPTION_SECRET);
      try {await control.takeRate('ingress:'+ipHash,120,60000);}
      catch {throw new Fault('capacity_paused',429,60);}
      return await env.WORKSPACES.getByName(m[1]).fetch(request);
    }catch(error){return errorResponse(error);}
  }
};
