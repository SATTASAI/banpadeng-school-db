// Run locally, then open http://127.0.0.1:8799/ in a browser.
// Exercises the actual request wrapper against stalled HTTP responses.
import http from 'node:http';
import fs from 'node:fs';
const api=fs.readFileSync(new URL('../public/js/api.js',import.meta.url),'utf8');
const page=`<!doctype html><meta charset="utf-8"><p id="result">RUNNING</p><script src="/js/api.js"></script><script>
(async()=>{
 const assert=(ok,message)=>{if(!ok)throw Error(message);};
 await apiRequest('/test/stall',{timeoutMs:30}).then(()=>{throw Error('timeout missing');},e=>assert(e.code==='REQUEST_TIMEOUT','timeout code'));
 await apiRequest('/test/write',{method:'POST',body:{value:1},timeoutMs:30}).then(()=>{throw Error('write timeout missing');},e=>assert(e.code==='REQUEST_TIMEOUT','write timeout code'));
 const controller=new AbortController(),p=apiRequest('/test/cancel',{signal:controller.signal});controller.abort();
 await p.then(()=>{throw Error('cancellation missing');},e=>assert(e.name==='AbortError','cancellation'));
 const counts=await apiRequest('/test/counts');assert(counts.stall===2,'GET retry count '+counts.stall);assert(counts.write===1,'POST retry count '+counts.write);
 document.getElementById('result').textContent='PASS: browser timeout, read retry, no write retry, cancellation';
})().catch(e=>{document.getElementById('result').textContent='FAIL: '+e.message;});
</script>`;
const counts={stall:0,write:0};
const server=http.createServer((req,res)=>{
 const path=new URL(req.url,'http://localhost').pathname;
 if(path==='/test/stall'){counts.stall++;return;}
 if(path==='/test/write'){counts.write++;return;}
 if(path==='/test/cancel')return;
 if(path==='/test/counts'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(counts));return;}
 if(path==='/js/api.js'){res.setHeader('Content-Type','text/javascript');res.end(api);return;}
 if(path.startsWith('/js/')){res.setHeader('Content-Type','text/javascript');res.end('');return;}
 if(path.startsWith('/css/')){res.setHeader('Content-Type','text/css');res.end('');return;}
 if(path==='/api/activity/ping'){res.setHeader('Content-Type','application/json');res.end('{}');return;}
 res.setHeader('Content-Type','text/html; charset=utf-8');res.end(page);
});
server.listen(8799,'127.0.0.1',()=>console.log('browser smoke server ready on 8799'));
