import {handleEvaluationRoute} from './evaluation/routes.js';
import {handleEvaluationLogin} from './evaluation/session-link.js';
import {jsonResponse} from './lib/auth.js';
export default {
 async fetch(request,env){
  const url=new URL(request.url),path=url.pathname;
  try{
   const login=await handleEvaluationLogin(request,env);if(login)return login;
   if(path==='/api/health'&&request.method==='GET')return jsonResponse({app:'evaluatesystem',protocol:'evaluation-link-v1',database:!!env.DB},200,{'Cache-Control':'no-store'});
   if(path.startsWith('/api/evaluation/'))return await handleEvaluationRoute(request,env,path,request.method);
   if(path==='/')return Response.redirect(new URL('/evaluate',url.origin),302);
   if(['/evaluate','/evaluate.html','/css/evaluation.css','/js/evaluation.js'].includes(path))return env.ASSETS.fetch(request);
   return jsonResponse({error:'ไม่พบหน้าในระบบประเมิน'},404);
  }catch(error){console.error('evaluation request failed',error?.name||'Error');return jsonResponse({error:'ระบบประเมินยังไม่พร้อม กรุณาลองใหม่หรือติดต่อผู้ดูแล'},503,{'Cache-Control':'no-store'});}
 }
};
