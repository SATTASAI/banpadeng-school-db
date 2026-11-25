import test from 'node:test';
import assert from 'node:assert/strict';
import { thaiDateText } from '../src/lib/thai-time.js';

test('database UTC timestamps are shown on the Thai calendar day',()=>{
  // 18:30 UTC = 01:30 ของวันถัดไปตามเวลาไทย
  assert.equal(thaiDateText('2026-11-25 18:30:00'),thaiDateText('2026-11-26'));
  assert.equal(thaiDateText('2026-11-25 08:00:00'),thaiDateText('2026-11-25'));
  assert.equal(thaiDateText('2026-11-25T18:30:00Z'),thaiDateText('2026-11-26'));
  assert.match(thaiDateText('2026-11-26'),/26/);
  assert.equal(thaiDateText(''),'');assert.equal(thaiDateText('ไม่ใช่วันที่'),'');
});
