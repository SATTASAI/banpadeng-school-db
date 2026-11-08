import {handlePasskeys} from './passkeys.js';
// Only real staff accounts may enroll. Re-read account and viewer state on every operation.
export function schoolPasskeys({currentUser,verifyPassword,issue,roles}){
 const lookup=async(request,env,id)=>{
  const u=await env.DB.prepare('SELECT id,email,full_name,role,status,deleted_at,session_version,password_hash,password_salt FROM users WHERE id=?').bind(id).first();
  if(!u||u.status!=='active'||u.deleted_at||!u.role||roles&&!roles.includes(u.role))return null;
  // A missing viewer table in a fresh installation means no external viewer accounts.
  let viewer;try{viewer=await env.DB.prepare('SELECT 1 AS found FROM viewer_accounts WHERE user_id=?').bind(u.id).first();}catch(e){if(!String(e.message).includes('no such table: viewer_accounts'))throw e;}
  if(viewer)return null;
  u.passkey_version=String(u.session_version||1);return u;
 };
 return (request,env)=>handlePasskeys(request,env,{namespace:'school',lookup,current:async(r,e)=>{const u=await currentUser(r,e);return u&&!u.impersonator?lookup(r,e,u.id):null;},stepUp:async(r,e,u,password)=>verifyPassword(password,u.password_salt,u.password_hash),issue});
}
