// Protocol shared by the school identity bridge and the independent evaluatesystem app.
export const SCHOOL_ORIGIN='https://system.banpadengschool.ac.th';
export const EVALUATION_ORIGIN='https://evaluate.banpadengschool.ac.th';
export const SESSION_COOKIE='__Host-bpd_evaluation_session';
export const LOGIN_COOKIE='__Host-bpd_evaluation_login';
export const LINK_PROTOCOL='evaluation-link-v1';
export const epoch=()=>Math.floor(Date.now()/1000);
export const randomToken=()=>Array.from(crypto.getRandomValues(new Uint8Array(32)),b=>b.toString(16).padStart(2,'0')).join('');
export const tokenHash=async text=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text))),b=>b.toString(16).padStart(2,'0')).join('');
export const validToken=token=>typeof token==='string'&&/^[0-9a-f]{64}$/.test(token);
export function readCookies(request){const result={};for(const part of (request.headers.get('cookie')||'').split(';')){const i=part.indexOf('=');if(i<0)continue;try{result[part.slice(0,i).trim()]=decodeURIComponent(part.slice(i+1).trim());}catch{}}return result;}
const ready=new WeakMap();
export function ensureEvaluationSessions(env){let p=ready.get(env.DB);if(!p){p=env.DB.batch([
 env.DB.prepare(`CREATE TABLE IF NOT EXISTS evaluation_login_requests (state_hash TEXT PRIMARY KEY,code_hash TEXT UNIQUE,user_id INTEGER REFERENCES users(id),session_version INTEGER,expires_at INTEGER NOT NULL,protocol TEXT NOT NULL DEFAULT 'evaluation-link-v1')`),
 env.DB.prepare(`CREATE TABLE IF NOT EXISTS evaluation_login_sessions (session_hash TEXT PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id),session_version INTEGER NOT NULL,expires_at INTEGER NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`),
 env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_evaluation_session_expiry ON evaluation_login_sessions(expires_at)'),
 env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_evaluation_login_expiry ON evaluation_login_requests(expires_at)')
]);ready.set(env.DB,p);p.catch(()=>ready.delete(env.DB));}return p;}
export async function evaluationSessionUser(request,env){const token=readCookies(request)[SESSION_COOKIE];if(!validToken(token))return null;await ensureEvaluationSessions(env);
 return await env.DB.prepare(`SELECT u.id,u.full_name,u.role,u.status,u.session_version FROM evaluation_login_sessions s JOIN users u ON u.id=s.user_id
 WHERE s.session_hash=? AND s.expires_at>? AND u.status='active' AND u.role IS NOT NULL AND s.session_version=COALESCE(u.session_version,1)`)
 .bind(await tokenHash(token),epoch()).first();
}
function redirect(location,cookies=[]){const headers=new Headers({'Location':location,'Cache-Control':'no-store','Referrer-Policy':'no-referrer'});for(const cookie of cookies)headers.append('Set-Cookie',cookie);return new Response(null,{status:302,headers});}
function cookie(name,value,ttl){return `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${ttl}`;}
const error=(message,status=401)=>new Response(JSON.stringify({error:message}),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'no-referrer'}});
export async function handleEvaluationLogin(request,env){const url=new URL(request.url),path=url.pathname;if(!['/auth/start','/auth/callback','/auth/logout'].includes(path))return null;
 await ensureEvaluationSessions(env);
 if(path==='/auth/start'&&request.method==='GET'){
  const state=randomToken(),time=epoch();await env.DB.batch([
   env.DB.prepare('DELETE FROM evaluation_login_requests WHERE expires_at<=?').bind(time),
   env.DB.prepare('DELETE FROM evaluation_login_sessions WHERE expires_at<=?').bind(time),
   env.DB.prepare('INSERT INTO evaluation_login_requests(state_hash,expires_at) VALUES(?,?)').bind(await tokenHash(state),time+300)
  ]);
  return redirect(`${SCHOOL_ORIGIN}/evaluation-connect?state=${state}`,[cookie(LOGIN_COOKIE,state,300)]);
 }
 if(path==='/auth/callback'&&request.method==='GET'){
  const state=url.searchParams.get('state'),code=url.searchParams.get('code');
  if(!validToken(state)||!validToken(code)||readCookies(request)[LOGIN_COOKIE]!==state)return error('การเชื่อมบัญชีหมดอายุหรือไม่ตรงกับเบราว์เซอร์นี้ กรุณาเข้าสู่ระบบใหม่');
  const grant=await env.DB.prepare(`DELETE FROM evaluation_login_requests WHERE state_hash=? AND code_hash=? AND expires_at>? AND protocol=? RETURNING user_id,session_version`)
   .bind(await tokenHash(state),await tokenHash(code),epoch(),LINK_PROTOCOL).first();
  if(!grant?.user_id)return error('รหัสเชื่อมบัญชีหมดอายุหรือถูกใช้แล้ว');
  const user=await env.DB.prepare("SELECT id,role,COALESCE(session_version,1) AS session_version FROM users WHERE id=? AND status='active'").bind(grant.user_id).first();
  if(!user?.role||Number(user.session_version)!==Number(grant.session_version))return error('บัญชีหรือ session โรงเรียนถูกเปลี่ยน กรุณาเข้าสู่ระบบใหม่');
  const token=randomToken();await env.DB.prepare('INSERT INTO evaluation_login_sessions(session_hash,user_id,session_version,expires_at) VALUES(?,?,?,?)').bind(await tokenHash(token),user.id,user.session_version,epoch()+604800).run();
  return redirect('/evaluate',[cookie(SESSION_COOKIE,token,604800),cookie(LOGIN_COOKIE,'',0)]);
 }
 if(path==='/auth/logout'&&request.method==='POST'){
  if(request.headers.get('origin')!==url.origin)return error('ที่มาคำขอไม่ถูกต้อง',403);
  const token=readCookies(request)[SESSION_COOKIE];if(validToken(token))await env.DB.prepare('DELETE FROM evaluation_login_sessions WHERE session_hash=?').bind(await tokenHash(token)).run();
  return new Response(JSON.stringify({ok:true}),{headers:{'Content-Type':'application/json','Cache-Control':'no-store','Set-Cookie':cookie(SESSION_COOKIE,'',0)}});
 }
 return error('Method not allowed',405);
}
