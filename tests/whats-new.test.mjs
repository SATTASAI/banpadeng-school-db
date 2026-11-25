import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const src = await readFile(new URL("../public/js/whats-new.js", import.meta.url), "utf8");
const api = await readFile(new URL("../public/js/api.js", import.meta.url), "utf8");

test("whats-new pop-up is loaded by api.js on every page", () => {
  assert.match(api, /src="\/js\/whats-new\.js"/);
});

test("latest update announces disbursement trial, once per device, news only", () => {
  assert.match(src, /ระบบเบิกจ่ายงบประมาณโครงการ ใช้งานได้แล้ว/);
  assert.match(src, /ช่วงทดลอง/);
  assert.match(src, /localStorage/);
  assert.match(src, /รับทราบ/);
  assert.doesNotMatch(src, /href|location\.assign|location\.href\s*=/);
  assert.match(src, /\/api\/auth\/me/);
  assert.match(src, /window\.parent !== window/);
  assert.doesNotMatch(src, /innerHTML/);
});

test("whats-new script parses", () => { new Function(src); });
