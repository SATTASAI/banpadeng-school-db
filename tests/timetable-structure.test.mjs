import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { solveTimetable } from '../src/lib/timetable-solver.js';
import { validateStructure, classActivityCells, bandOf, DEFAULT_STRUCTURE } from '../src/lib/timetable-structure.js';
import { handleAuto, ensureAutoSchema } from '../src/routes/timetable-auto.js';

test('band template: activity cells are never used for subjects and reduce capacity', () => {
  const classes = [{ grade_level: 'ป.1', classroom: '1' }, { grade_level: 'ป.5', classroom: '1' }];
  const structure = validateStructure({ ...DEFAULT_STRUCTURE, bands: { lower: [{ weekday: 1, period: 1, name: 'เข้าแถว' }, { weekday: 5, period: 6, name: 'แนะแนว' }], upper: [{ weekday: 3, period: 4, name: 'ชุมนุม' }] } }).structure;
  const cells = classActivityCells(structure, classes);
  assert.equal(cells.length, 3);
  const assignments = classes.map((c) => ({ ...c, subject: 'คณิต', teacher_id: c.grade_level === 'ป.1' ? 1 : 2, periods_per_week: 28, max_per_day: 6 }));
  const r = solveTimetable({ classes, assignments, periods_per_day: [6, 6, 6, 6, 6], class_activity: cells, keep_existing: false });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  for (const c of cells) assert.ok(!r.entries.some((e) => e.grade_level === c.grade_level && e.classroom === c.classroom && e.weekday === c.weekday && e.period === c.period));
  assert.deepEqual(r.summary.map((s) => s.unfilled), [0, 1]);
  // ภาระเกินช่องรายวิชาที่เหลือ
  const over = solveTimetable({ classes: [classes[0]], assignments: [{ ...assignments[0], periods_per_week: 29 }], periods_per_day: [6, 6, 6, 6, 6], class_activity: cells });
  assert.equal(over.ok, false);
  assert.match(over.errors.join(' '), /เกินช่องรายวิชา 28 คาบ/);
});

test('structure validation and bands', () => {
  assert.equal(bandOf('ป.3'), 'lower'); assert.equal(bandOf('ป.4'), 'upper'); assert.equal(bandOf('อ.2'), null);
  assert.ok(validateStructure({ ...DEFAULT_STRUCTURE, lunch: { start: '10:00', end: '11:00' } }).error);
  assert.ok(validateStructure({ ...DEFAULT_STRUCTURE, bands: { lower: [{ weekday: 6, period: 1, name: 'x' }] } }).error);
  assert.equal(validateStructure(DEFAULT_STRUCTURE).structure.bands.upper.length, 4);
});

test('auto preview reads the saved band template from the database', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE users(id INTEGER PRIMARY KEY);INSERT INTO users VALUES(1);CREATE TABLE academic_terms(id INTEGER PRIMARY KEY);INSERT INTO academic_terms VALUES(1);
    CREATE TABLE timetable_plans(id INTEGER PRIMARY KEY,academic_term_id INTEGER,status TEXT,revision INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE timetable_entries(id INTEGER PRIMARY KEY,plan_id INTEGER,grade_level TEXT,classroom TEXT,weekday INTEGER,period INTEGER,subject TEXT,teacher_id INTEGER,room_name TEXT);`);
  const env = { DB: { prepare(sql) { let a = []; return { bind(...x) { a = x; return this; }, async first() { return db.prepare(sql).get(...a) || null; }, async all() { return { results: db.prepare(sql).all(...a) }; }, async run() { return { meta: { changes: db.prepare(sql).run(...a).changes } }; } }; }, async batch(list) { for (const x of list) await x.run(); return []; } } };
  await ensureAutoSchema(env);
  const st = validateStructure({ ...DEFAULT_STRUCTURE, bands: { lower: [1, 2, 3, 4, 5].map((d) => ({ weekday: d, period: 1, name: 'กิจกรรมหน้าเสาธง' })), upper: [] } }).structure;
  db.exec(`CREATE TABLE timetable_structure(academic_term_id INTEGER PRIMARY KEY,config_json TEXT NOT NULL,updated_by INTEGER,updated_at TEXT NOT NULL DEFAULT(datetime('now')))`);
  db.prepare('INSERT INTO timetable_structure(academic_term_id,config_json,updated_by) VALUES(1,?,1)').run(JSON.stringify(st));
  const config = { classes: [{ grade_level: 'ป.2', classroom: '1' }], assignments: [{ grade_level: 'ป.2', classroom: '1', teacher_id: 9, subject: 'ไทย', periods_per_week: 5, max_per_day: 1, room_name: '' }], unavailable: [], keep_existing: false, periods_per_day: [6, 5, 5, 5, 5] };
  const helpers = { setup: async () => new Response(JSON.stringify({ classes: config.classes, teachers: [{ id: 9 }] })), plan: async () => null, draft: async () => null };
  const res = await handleAuto(new Request('https://t/api/timetable/auto/preview', { method: 'POST', body: JSON.stringify({ config }) }), env, { id: 1 }, { id: 1 }, '/api/timetable/auto/preview', 'POST', helpers);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.entries.length, 5);
  assert.ok(body.entries.every((e) => e.period !== 1));
});
