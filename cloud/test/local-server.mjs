// Explicit synthetic-only UI harness. Not imported by the production Worker.
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {fixture} from './fixture.mjs';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
const provider=fixture();
const mf=new Miniflare(convertV4MiniflareOptions({name:'event-crm-test',host:'127.0.0.1',modules:true,
  scriptPath:'.wrangler/build/worker.js',compatibilityDate:'2026-10-20',cf:false,
  durableObjects:{WORKSPACES:{className:'Workspace',useSQLite:true},CONTROL:{className:'Control',useSQLite:true}},
  bindings:{KEY_ENCRYPTION_SECRET:'synthetic-encryption-secret-43-characters-long',LIVE_ADMISSION:'open',SERPER_API_KEY:'synthetic',GEMINI_API_KEY:'synthetic'},
  outboundService:provider.fetch
}));
await mf.ready;
const server=createServer(async(req,res)=>{
  try {
    if(req.url.startsWith('/api/')) {
      let body='';for await(const chunk of req){body+=chunk;if(body.length>32000){res.writeHead(413).end();return;}}
      const r=await mf.dispatchFetch('http://127.0.0.1:8788'+req.url,{method:req.method,headers:req.headers,...(body?{body}:{})});
      res.writeHead(r.status,Object.fromEntries(r.headers));res.end(Buffer.from(await r.arrayBuffer()));return;
    }
    const path=new URL(req.url,'http://127.0.0.1').pathname;
    const names={'/app.js':['app.js','text/javascript'],'/demo.js':['demo.js','text/javascript'],'/portraits.js':['portraits.js','text/javascript'],'/style.css':['style.css','text/css']};
    const [file,mime]=names[path]||['index.html','text/html'];
    res.writeHead(200,{'Content-Type':mime,'Cache-Control':'no-store'});res.end(await readFile('public/'+file));
  } catch {res.writeHead(500,{'Content-Type':'application/json'}).end(JSON.stringify({error:'test_harness_unavailable'}));}
});
server.listen(8788,'127.0.0.1');
console.log('Synthetic-only preview: http://127.0.0.1:8788/');
console.log('Fixture event: https://luma.com/fictional-demo; API key: synthetic-calendar-key');
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{server.close();await mf.dispose();process.exit(0);});
