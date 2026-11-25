import test from 'node:test';
import assert from 'node:assert/strict';
import {readdirSync,readFileSync} from 'node:fs';

// กันหัวหน้าเว็บหาย (เคยเกิดตอนลบลิงก์ไอคอนทั้งบรรทัด ทำให้ <title>/stylesheet หายไปด้วย)
test('every page keeps its <title> inside <head>',()=>{
 const missing=readdirSync('public').filter(f=>f.endsWith('.html')).filter(f=>{
  const html=readFileSync(`public/${f}`,'utf8');
  const head=html.split(/<body[\s>]/i)[0];
  return /<body[\s>]/i.test(html)&&!/<title>[^<]+<\/title>/i.test(head);
 });
 assert.deepEqual(missing,[]);
});
