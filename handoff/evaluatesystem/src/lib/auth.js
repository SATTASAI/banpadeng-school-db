import {evaluationSessionUser,readCookies} from '../evaluation/session-link.js';
export const getCurrentUser=evaluationSessionUser;
export const parseCookies=readCookies;
export function jsonResponse(data,status=200,headers={}){return new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json; charset=utf-8',...headers}});}
