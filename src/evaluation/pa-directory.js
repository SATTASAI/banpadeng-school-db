import {getCurrentUser,jsonResponse} from '../lib/auth.js';
import {evaluationPermissions} from './permissions.js';
import {paDirectory} from './pa-directory-data.js';

export async function handlePaDirectory(request,env,path,method){
 if(path!=='/api/pa-directory'&&!/^\/api\/pa-directory\/\d+\/photo$/.test(path))return null;
 const reply=(body,status=200)=>jsonResponse(body,status,{'Cache-Control':'private, no-store'});
 const user=await getCurrentUser(request,env);
 if(!user?.role)return reply({error:'กรุณาเข้าสู่ระบบ'},401);
 if(user.role==='viewer')return reply({error:'ไม่มีสิทธิ์เข้าถึงแฟ้ม PA'},403);
 const permissions=await evaluationPermissions(env,user);
 await env.DB.prepare('CREATE TABLE IF NOT EXISTS evaluation_pa_photos (teacher_id INTEGER PRIMARY KEY, image_data TEXT NOT NULL)').run();
 if(path==='/api/pa-directory'&&method==='GET'){
  const rows=await env.DB.prepare('SELECT teacher_id,image_data FROM evaluation_pa_photos').all();
  const photos=new Map(rows.results.map(x=>[x.teacher_id,x.image_data]));
  return reply({teachers:paDirectory.map(p=>({...p,photo:photos.get(p.id)||''})),manage:permissions.manage});
 }
 if(method!=='PUT')return reply({error:'ไม่รองรับคำขอนี้'},405);
 if(!permissions.manage)return reply({error:'ไม่มีสิทธิ์จัดการรูปภาพ'},403);
 if(request.headers.get('origin')!==new URL(request.url).origin||request.headers.get('sec-fetch-site')==='cross-site')return reply({error:'ที่มาคำขอไม่ถูกต้อง'},403);
 if(!(request.headers.get('content-type')||'').includes('application/json'))return reply({error:'รองรับข้อมูล JSON เท่านั้น'},415);
 const id=Number(path.match(/\/(\d+)\/photo$/)[1]);
 if(!paDirectory.some(p=>p.id===id))return reply({error:'ไม่พบครู'},404);
 if(Number(request.headers.get('content-length')||0)>120000)return reply({error:'รูปภาพใหญ่เกินไป'},413);
 const reader=request.body?.getReader();let size=0,chunks=[];
 if(reader)while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>120000){await reader.cancel();return reply({error:'รูปภาพใหญ่เกินไป'},413);}chunks.push(value);}
 let body;try{const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}body=JSON.parse(new TextDecoder().decode(bytes));}catch{return reply({error:'ข้อมูลไม่ถูกต้อง'},400);}
 if(!body||typeof body.photo!=='string'||body.photo.length>100000||(body.photo!==''&&!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/.test(body.photo)))return reply({error:'รูปภาพไม่ถูกต้องหรือใหญ่เกินไป'},400);
 if(body.photo)await env.DB.prepare('INSERT INTO evaluation_pa_photos(teacher_id,image_data) VALUES(?,?) ON CONFLICT(teacher_id) DO UPDATE SET image_data=excluded.image_data').bind(id,body.photo).run();
 else await env.DB.prepare('DELETE FROM evaluation_pa_photos WHERE teacher_id=?').bind(id).run();
 return reply({ok:true});
}
