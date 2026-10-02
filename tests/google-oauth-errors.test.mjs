import test from 'node:test';
import assert from 'node:assert/strict';
import {googleOAuthTokenError} from '../src/lib/google-oauth-errors.js';
test('Google OAuth distinguishes revoked token from invalid app credentials',()=>{assert.match(googleOAuthTokenError(400,{error:'invalid_grant'}),/invalid_grant.*เชื่อมต่อบัญชี Google Drive ใหม่/);assert.match(googleOAuthTokenError(401,{error:'invalid_client'}),/invalid_client.*Client ID/);});
test('OAuth diagnostics never expose raw descriptions, tokens, or unknown errors',()=>{for(const error of ['unknown secret-value',{refresh_token:'secret-value'},'__proto__']){assert.equal(googleOAuthTokenError(400,{error,error_description:'secret-value',refresh_token:'secret-value'}),'เชื่อมต่อ Google Drive ไม่สำเร็จ (400)');}assert.equal(googleOAuthTokenError(400,null),'เชื่อมต่อ Google Drive ไม่สำเร็จ (400)');assert.doesNotMatch(googleOAuthTokenError(400,{error:'invalid_grant',error_description:'secret-value'}),/secret-value/);});
