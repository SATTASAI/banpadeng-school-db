import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const src = await readFile(new URL("../public/js/whats-new.js", import.meta.url), "utf8");
const api = await readFile(new URL("../public/js/api.js", import.meta.url), "utf8");
const updates = new Function(`${src.match(/const UPDATES = (\[[\s\S]*?\n  \]);/)[1].replace(/^/, "return ")}`)();

test("whats-new pop-up is loaded by api.js on every page", () => {
  assert.match(api, /src="\/js\/whats-new\.js"/);
});

test("pop-up shows at most 3 unread updates, once per device, news only", () => {
  assert.match(src, /const MAX = 3;/);
  assert.match(src, /\.slice\(0, MAX\)/);
  assert.match(src, /localStorage/);
  assert.match(src, /รับทราบ/);
  assert.doesNotMatch(src, /href|location\.assign|location\.href\s*=/);
  assert.match(src, /\/api\/auth\/me/);
  assert.match(src, /window\.parent !== window/);
  assert.doesNotMatch(src, /innerHTML/);
});

test("each update is one short topic: title + one sentence", () => {
  for (const u of updates) {
    assert.ok(u.id && u.title && u.text, u.id);
    assert.equal(u.items, undefined, `${u.id}: no bullet lists`);
    assert.ok(u.title.length <= 50, `${u.id}: title too long`);
    assert.ok(u.text.length <= 100, `${u.id}: text too long`);
  }
});

test("disbursement announcement stays paused", () => {
  assert.equal(updates.find((u) => u.id === "2026-11-disbursement-trial").paused, true);
  assert.match(src, /!u\.paused/);
});
