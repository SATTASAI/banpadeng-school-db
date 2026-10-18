import {getCurrentUser,jsonResponse} from '../lib/auth.js';
import {evaluationPermissions} from './permissions.js';
import {ensureEvaluationSessions,validToken,tokenHash,randomToken,epoch,EVALUATION_ORIGIN,LINK_PROTOCOL} from './session-link.js';

export async function handleEvaluationLink(request,env){
 const url=new URL(request.url);if(!['/evaluation-connect','/evaluation-connect.html','/api/evaluation-link/authorize'].includes(url.pathname))return null;
 await ensureEvaluationSessions(env);
 const reply=(data,status)=>jsonResponse(data,status,{'Cache-Control':'no-store','Referrer-Policy':'no-referrer'});
 const user=await getCurrentUser(request,env);
 if(url.pathname!=='/api/evaluation-link/authorize'&&request.method==='GET'){
  const state=url.searchParams.get('state');if(!validToken(state))return Response.redirect(EVALUATION_ORIGIN+'/auth/start',302);
  if(!user?.role)return Response.redirect(new URL('/login.html?next='+encodeURIComponent('/evaluation-connect?state='+state),url.origin),302);
  if(!(await evaluationPermissions(env,user)).access)return reply({error:'บัญชีนี้ไม่มีสิทธิ์เข้าระบบประเมิน ครูดูผลของตนเองได้ในฝ่ายบุคลากร'},403);
  const pending=await env.DB.prepare('SELECT state_hash FROM evaluation_login_requests WHERE state_hash=? AND code_hash IS NULL AND expires_at>? AND protocol=?').bind(await tokenHash(state),epoch(),LINK_PROTOCOL).first();
  if(!pending)return reply({error:'คำขอเชื่อมบัญชีหมดอายุ กรุณาเปิดระบบประเมินและเข้าสู่ระบบใหม่'},400);
  const nonce=randomToken();
  return new Response(`<!doctype html><html lang="th"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>กำลังเข้าสู่ระบบประเมิน</title><body><form id="evaluation-connect" method="post" action="/api/evaluation-link/authorize"><input type="hidden" name="state" value="${state}"><noscript><p>เบราว์เซอร์ปิด JavaScript กรุณากดเพื่อเข้าสู่ระบบประเมิน</p><button type="submit">เข้าสู่ระบบประเมิน</button></noscript></form><script nonce="${nonce}">document.getElementById('evaluation-connect').submit();</script></body></html>`,{headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'no-referrer','Content-Security-Policy':`default-src 'none'; script-src 'nonce-${nonce}'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`}});
 }
 if(url.pathname==='/api/evaluation-link/authorize'&&request.method==='POST'){
  if(request.headers.get('origin')!==url.origin)return reply({error:'ที่มาคำขอไม่ถูกต้อง'},403);
  if(!user?.role)return reply({error:'กรุณาเข้าสู่ระบบโรงเรียนก่อน'},401);
  if(!(await evaluationPermissions(env,user)).access)return reply({error:'ไม่มีสิทธิ์เข้าระบบประเมิน'},403);
  if(Number(request.headers.get('content-length')||0)>1024)return reply({error:'คำขอมีขนาดใหญ่เกินไป'},413);
  const form=await request.formData(),state=form.get('state');if(!validToken(state))return reply({error:'คำขอไม่ถูกต้อง'},400);
  const code=randomToken(),r=await env.DB.prepare(`UPDATE evaluation_login_requests SET code_hash=?,user_id=?,session_version=?,expires_at=? WHERE state_hash=? AND code_hash IS NULL AND expires_at>? AND protocol=?`)
   .bind(await tokenHash(code),user.id,Number(user.session_version||1),epoch()+120,await tokenHash(state),epoch(),LINK_PROTOCOL).run();
  if(r.meta.changes!==1)return reply({error:'คำขอเชื่อมบัญชีหมดอายุหรือถูกใช้แล้ว'},409);
  return new Response(null,{status:302,headers:{Location:`${EVALUATION_ORIGIN}/auth/callback?code=${code}&state=${state}`,'Cache-Control':'no-store','Referrer-Policy':'no-referrer'}});
 }
 return reply({error:'Method not allowed'},405);
}
