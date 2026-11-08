// Shared school Passkey protocol v1. Keep copies identical across Workers.
import {generateRegistrationOptions,verifyRegistrationResponse,generateAuthenticationOptions,verifyAuthenticationResponse} from '@simplewebauthn/server';
const enc=new TextEncoder(),ready=new WeakMap(),TTL=300000;
export const b64=b=>btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
export const unb64=s=>Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));
export const hash=async s=>b64(await crypto.subtle.digest('SHA-256',enc.encode(s)));
const random=()=>b64(crypto.getRandomValues(new Uint8Array(32)));
const reply=(data,status=200,cookie)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...(cookie?{'Set-Cookie':cookie}:{})}});
const reject=(message,status=400)=>{throw Object.assign(new Error(message),{passkeyStatus:status});};
const hosts=['system','grades','teachingmedia','activity','publicservice','notify','bank'].map(s=>s+'.banpadengschool.ac.th');
export function passkeyRp(request){const u=new URL(request.url);if(u.protocol!=='https:'&&!['localhost','127.0.0.1'].includes(u.hostname))reject('Passkey ต้องใช้ HTTPS');return {origin:u.origin,rpID:hosts.includes(u.hostname)?'banpadengschool.ac.th':u.hostname};}
export async function ensurePasskeys(env){if(ready.has(env.DB))return ready.get(env.DB);const p=env.DB.batch([
 env.DB.prepare(`CREATE TABLE IF NOT EXISTS auth_passkey_users(namespace TEXT NOT NULL,subject TEXT NOT NULL,handle TEXT NOT NULL UNIQUE,PRIMARY KEY(namespace,subject))`),
 env.DB.prepare(`CREATE TABLE IF NOT EXISTS auth_passkeys(rp_id TEXT NOT NULL,id TEXT NOT NULL,namespace TEXT NOT NULL,subject TEXT NOT NULL,user_handle TEXT NOT NULL,public_key TEXT NOT NULL,counter INTEGER NOT NULL DEFAULT 0,transports TEXT NOT NULL DEFAULT '[]',name TEXT NOT NULL,created_at INTEGER NOT NULL,last_used_at INTEGER,PRIMARY KEY(rp_id,id))`),
 env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_passkeys_subject ON auth_passkeys(namespace,subject)'),
 env.DB.prepare(`CREATE TABLE IF NOT EXISTS auth_passkey_challenges(id TEXT PRIMARY KEY,browser_hash TEXT NOT NULL,namespace TEXT NOT NULL,purpose TEXT NOT NULL,subject TEXT,version TEXT,challenge TEXT NOT NULL,origin TEXT NOT NULL,rp_id TEXT NOT NULL,ip_hash TEXT NOT NULL,expires_at INTEGER NOT NULL)`),
 env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_passkey_challenges_expiry ON auth_passkey_challenges(expires_at)'),
 env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_passkey_challenges_ip ON auth_passkey_challenges(ip_hash,expires_at)'),
 env.DB.prepare('CREATE TABLE IF NOT EXISTS auth_passkey_rates(ip_hash TEXT PRIMARY KEY,n INTEGER NOT NULL,expires_at INTEGER NOT NULL)')
]).catch(e=>{ready.delete(env.DB);throw e;});ready.set(env.DB,p);return p;}
// Adapter: current, lookup, stepUp, issue. All authorization stays in each application's adapter.
export async function handlePasskeys(request,env,adapter){const url=new URL(request.url),path=url.pathname;
 if(!path.startsWith('/api/passkeys'))return null;
 try{
 const {origin,rpID}=passkeyRp(request),method=request.method;
 if(!['GET','POST','DELETE'].includes(method))return reply({error:'Method not allowed'},405);
 if(method!=='GET'&&request.headers.get('Origin')!==origin)reject('คำขอไม่ได้มาจากเว็บนี้',403);
 await ensurePasskeys(env);
 const namespace=adapter.namespace;
 const current=async()=>{const u=await adapter.current(request,env);if(!u)reject('กรุณาเข้าสู่ระบบด้วยรหัสผ่านก่อน',401);return u;};
 if(path==='/api/passkeys'&&method==='GET'){const u=await current();const {results}=await env.DB.prepare('SELECT id,name,created_at,last_used_at FROM auth_passkeys WHERE namespace=? AND subject=? AND rp_id=? ORDER BY created_at DESC').bind(namespace,String(u.id),rpID).all();return reply({passkeys:results});}
 if(path.startsWith('/api/passkeys/')&&method==='DELETE'){const u=await current();const id=decodeURIComponent(path.slice('/api/passkeys/'.length));await env.DB.prepare('DELETE FROM auth_passkeys WHERE namespace=? AND subject=? AND rp_id=? AND id=?').bind(namespace,String(u.id),rpID,id).run();return reply({ok:true});}
 if(method!=='POST')return reply({error:'ไม่พบเส้นทาง'},404);
 if(Number(request.headers.get('Content-Length')||0)>32768)reject('ข้อมูลมีขนาดใหญ่เกินไป',413);
 const text=await request.text();if(text.length>32768)reject('ข้อมูลมีขนาดใหญ่เกินไป',413);let body;try{body=JSON.parse(text);}catch{reject('รูปแบบข้อมูลไม่ถูกต้อง');}
 if(!body||typeof body!=='object')reject('รูปแบบข้อมูลไม่ถูกต้อง');
 const purpose=path.includes('/register/')?'register':'login';
 if(path===`/api/passkeys/${purpose}/options`){
  const ipHash=await hash(namespace+'|'+(request.headers.get('CF-Connecting-IP')||'local'));
  await env.DB.prepare('DELETE FROM auth_passkey_rates WHERE expires_at<=?').bind(Date.now()).run();
  const rate=await env.DB.prepare('INSERT INTO auth_passkey_rates(ip_hash,n,expires_at) VALUES(?,1,?) ON CONFLICT(ip_hash) DO UPDATE SET n=n+1 RETURNING n').bind(ipHash,Date.now()+TTL).first();if(rate.n>120)reject('ลองหลายครั้งเกินไป กรุณารอ 5 นาที',429);
  let u=null;if(purpose==='register'){u=await current();if(!await adapter.stepUp(request,env,u,String(body.password||'')))reject('รหัสผ่านปัจจุบันไม่ถูกต้อง',403);}
  let options;
  if(u){
   await env.DB.prepare('INSERT OR IGNORE INTO auth_passkey_users(namespace,subject,handle) VALUES(?,?,?)').bind(namespace,String(u.id),random()).run();
   const handle=await env.DB.prepare('SELECT handle FROM auth_passkey_users WHERE namespace=? AND subject=?').bind(namespace,String(u.id)).first();
   const {results}=await env.DB.prepare('SELECT id,transports FROM auth_passkeys WHERE namespace=? AND subject=? AND rp_id=?').bind(namespace,String(u.id),rpID).all();if(results.length>=10)reject('มี Passkey ครบ 10 รายการแล้ว กรุณาลบรายการที่ไม่ใช้');
   options=await generateRegistrationOptions({rpName:'โรงเรียนบ้านป่าเด็ง',rpID,userID:unb64(handle.handle),userName:u.email||u.username||String(u.id),userDisplayName:u.full_name||u.display_name||'ผู้ดูแลระบบ',attestationType:'none',supportedAlgorithmIDs:[-7,-257],authenticatorSelection:{residentKey:'required',userVerification:'required'},excludeCredentials:results.map(r=>({id:r.id,transports:JSON.parse(r.transports)})),timeout:TTL});
  }else options=await generateAuthenticationOptions({rpID,userVerification:'required',timeout:TTL});
  const id=random(),browser=random();
  await env.DB.batch([env.DB.prepare('DELETE FROM auth_passkey_challenges WHERE expires_at<=?').bind(Date.now()),env.DB.prepare('INSERT INTO auth_passkey_challenges(id,browser_hash,namespace,purpose,subject,version,challenge,origin,rp_id,ip_hash,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').bind(id,await hash(browser),namespace,purpose,u?String(u.id):null,u?String(u.passkey_version):null,options.challenge,origin,rpID,ipHash,Date.now()+TTL)]);
  return reply({options,challenge_id:id},200,`bpd_passkey_${purpose}=${browser}; Path=/api/passkeys; HttpOnly; Secure; SameSite=Strict; Max-Age=300`);
 }
 if(path!==`/api/passkeys/${purpose}/verify`)return reply({error:'ไม่พบเส้นทาง'},404);
 const cookie=(request.headers.get('Cookie')||'').split(';').map(s=>s.trim()).find(s=>s.startsWith(`bpd_passkey_${purpose}=`))?.split('=')[1]||'';
 const ch=await env.DB.prepare('DELETE FROM auth_passkey_challenges WHERE id=? AND browser_hash=? AND namespace=? AND purpose=? AND origin=? AND rp_id=? AND expires_at>? RETURNING *').bind(String(body.challenge_id||''),await hash(cookie),namespace,purpose,origin,rpID,Date.now()).first();
 if(!ch)reject('คำขอหมดอายุหรือใช้ไปแล้ว กรุณาลองอีกครั้ง',401);
 const credential=body.credential;if(!credential||typeof credential.id!=='string'||credential.id.length>2048)reject('Passkey ไม่ถูกต้อง',401);
 if(purpose==='register'){
  const u=await current();if(String(u.id)!==ch.subject||String(u.passkey_version)!==ch.version)reject('บัญชีถูกเปลี่ยน กรุณาเข้าสู่ระบบใหม่',401);
  const verification=await verifyRegistrationResponse({response:credential,expectedChallenge:ch.challenge,expectedOrigin:origin,expectedRPID:rpID,requireUserVerification:true,supportedAlgorithmIDs:[-7,-257]});if(!verification.verified)reject('ยืนยัน Passkey ไม่สำเร็จ',401);
  const c=verification.registrationInfo.credential;
  const h=await env.DB.prepare('SELECT handle FROM auth_passkey_users WHERE namespace=? AND subject=?').bind(namespace,String(u.id)).first();
  await env.DB.prepare('INSERT INTO auth_passkeys(rp_id,id,namespace,subject,user_handle,public_key,counter,transports,name,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)').bind(rpID,c.id,namespace,String(u.id),h.handle,b64(c.publicKey),c.counter,JSON.stringify((c.transports||[]).filter(t=>['usb','nfc','ble','internal','hybrid'].includes(t))),String(body.name||'Passkey ของฉัน').slice(0,80),Date.now()).run();
  return reply({ok:true});
 }
 const saved=await env.DB.prepare('SELECT * FROM auth_passkeys WHERE namespace=? AND rp_id=? AND id=?').bind(namespace,rpID,credential.id).first();if(!saved)reject('ไม่พบ Passkey ของบัญชีนี้ กรุณาใช้รหัสผ่าน',401);
 if(credential.response?.userHandle!==saved.user_handle)reject('Passkey ไม่ตรงกับบัญชี',401);
 const u=await adapter.lookup(request,env,saved.subject);if(!u)reject('บัญชีนี้ไม่มีสิทธิ์เข้าสู่ระบบ',403);
 const verification=await verifyAuthenticationResponse({response:credential,expectedChallenge:ch.challenge,expectedOrigin:origin,expectedRPID:rpID,credential:{id:saved.id,publicKey:unb64(saved.public_key),counter:saved.counter,transports:JSON.parse(saved.transports)},requireUserVerification:true});if(!verification.verified)reject('ยืนยัน Passkey ไม่สำเร็จ',401);
 const updated=await env.DB.prepare('UPDATE auth_passkeys SET counter=?,last_used_at=? WHERE namespace=? AND rp_id=? AND id=? AND counter=? RETURNING id').bind(verification.authenticationInfo.newCounter,Date.now(),namespace,rpID,saved.id,saved.counter).first();if(!updated)reject('Passkey ถูกเปลี่ยน กรุณาลองใหม่',401);
 return await adapter.issue(request,env,u);
 }catch(e){if(e.passkeyStatus)return reply({error:e.message},e.passkeyStatus);console.error('Passkey failed',e?.name||'Error');return reply({error:'ยืนยัน Passkey ไม่สำเร็จ กรุณาลองใหม่หรือใช้รหัสผ่าน'},400);}
}
