import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const code=await readFile(new URL('../public/js/notify-chat.js',import.meta.url),'utf8');
async function run({data={allowed:true,url:'https://notify.banpadengschool.ac.th/?t=signed-token'},error=null,message='42'}={}){
 const nodes=Object.fromEntries(['status','open','retry'].map(id=>[id,{hidden:true}]));let destination;
 await vm.runInNewContext(code,{URL,AbortSignal,location:{href:'https://system.banpadengschool.ac.th/notify-chat.html?message='+encodeURIComponent(message),replace(url){destination=url;},reload(){}},document:{getElementById:id=>nodes[id]},async apiRequest(path){assert.equal(path,'/api/push/link');if(error)throw error;return data;}});
 return {nodes,destination};
}
let result=await run();let target=new URL(result.destination);assert.equal(target.hostname,'notify.banpadengschool.ac.th');assert.equal(target.searchParams.get('t'),'signed-token');assert.equal(target.searchParams.get('message'),'42');assert.equal(target.searchParams.get('chat'),'1');assert.equal(result.nodes.open.href,target.href);assert.equal(result.nodes.open.hidden,false);
result=await run({error:{status:401,message:'unauthorized'}});target=new URL(result.destination,'https://system.banpadengschool.ac.th');assert.equal(target.pathname,'/login.html');assert.equal(target.searchParams.get('next'),'/notify-chat.html?message=42');
result=await run({error:new Error('network unavailable')});assert.equal(result.destination,undefined);assert.equal(result.nodes.retry.hidden,false);
for(const data of [{allowed:false},{allowed:true,url:'https://evil.example/?t=secret'}]){result=await run({data});assert.equal(result.destination,undefined);assert.equal(result.nodes.retry.hidden,false);}
result=await run({message:'<script>'});assert.equal(new URL(result.destination).searchParams.has('message'),false);
console.log('✓ Chat bridge: signed account link, exact message, login return, safe destination and retry');
