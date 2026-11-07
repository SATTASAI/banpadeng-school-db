import assert from 'node:assert/strict';
import {pushChatUnread} from '../src/lib/push-feed.js';
const env={NOTIFY_API_KEY:'test-only-key',PUSH_PILOT_ROLES:'all'};
const originalFetch=globalThis.fetch;let calls=0,mode='ok';
globalThis.fetch=async(url,options)=>{
  calls++;const target=new URL(url);
  assert.equal(target.origin,'https://notify.banpadengschool.ac.th');assert.equal(target.pathname,'/api/chat/admin/unread');
  assert.equal(options.headers.authorization,'Bearer test-only-key');assert.equal(target.searchParams.get('role'),'teacher');
  if(mode==='failure')return new Response('{}',{status:503});
  if(mode==='invalid')return Response.json({unread:'yes'});
  return Response.json({unread:target.searchParams.get('ref')==='u:12'});
};
try{
  assert.deepEqual(await pushChatUnread(env,{id:12,role:'teacher'}),{status:200,data:{allowed:true,unread:true}});
  assert.deepEqual(await pushChatUnread(env,{id:23,role:'teacher'}),{status:200,data:{allowed:true,unread:false}});
  const before=calls;assert.equal((await pushChatUnread({}, {id:12,role:'teacher'})).data.unread,false);assert.equal(calls,before);
  mode='failure';assert.equal((await pushChatUnread(env,{id:12,role:'teacher'})).status,502);
  mode='invalid';assert.equal((await pushChatUnread(env,{id:12,role:'teacher'})).status,502);
  console.log('✓ Unread proxy: authenticated account reference, server-only key, unavailable service and invalid responses');
}finally{globalThis.fetch=originalFetch;}
