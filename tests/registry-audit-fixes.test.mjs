import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { signJWT } from '../src/lib/crypto.js';
import { ensureBudgetSchema } from '../src/routes/budget.js';
import worker from '../src/index.js';

const secret = 'registry-audit-fixes';
async function fixture() {
  const raw = new DatabaseSync(':memory:');
  raw.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  raw.exec(`INSERT INTO users(id,email,password_hash,password_salt,full_name,role) VALUES
    (1,'admin@test','x','x','ผู้ดูแล','superadmin'),(2,'owner@test','x','x','เจ้าของ','teacher'),
    (3,'finance@test','x','x','การเงิน','staff'),(4,'other@test','x','x','ครูอื่น','teacher'),(5,'b@test','x','x','ครูบี','teacher');
    INSERT INTO projects(id,department,name,budget_amount,fiscal_year,created_by,funding_type) VALUES (10,'academic','อ่านคล่อง',1000,2570,1,'subsidy');
    INSERT INTO project_owners(project_id,user_id) VALUES(10,2);`);
  function prepare(sql) { let values = []; return { bind(...v) { values = v; return this; }, async first() { return raw.prepare(sql).get(...values) || null; }, async all() { return { results: raw.prepare(sql).all(...values) }; }, async run() { const r = raw.prepare(sql).run(...values); return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; } }; }
  const env = { raw, JWT_SECRET: secret, DB: { prepare, async batch(statements) { raw.exec('BEGIN'); try { const out = []; for (const s of statements) out.push(await s.run()); raw.exec('COMMIT'); return out; } catch (e) { raw.exec('ROLLBACK'); throw e; } } } };
  await ensureBudgetSchema(env);
  raw.exec(`INSERT INTO budget_role_assignments(role_key,department,user_id,assigned_by) VALUES('finance_review','',3,1)`);
  return env;
}
async function call(env, user, path, method = 'GET', body) {
  const token = await signJWT({ sub: user }, secret);
  const r = await worker.fetch(new Request('https://school.test' + path, { method, headers: { Cookie: 'bpd_session=' + token, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }), env, {});
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json };
}

test('income can be edited/deleted by admin only, with audit trail and a required delete reason', async () => {
  const env = await fixture();
  const created = await call(env, 1, '/api/budget/income', 'POST', { received_date: '2026-10-05', source_name: 'อุดหนุน', source_type: 'subsidy', amount: 5000 });
  assert.equal(created.status, 201);
  const id = created.body.id;
  assert.equal((await call(env, 4, `/api/budget/income/${id}`, 'PATCH', { received_date: '2026-10-05', source_name: 'x', amount: 1 })).status, 403);
  assert.equal((await call(env, 1, `/api/budget/income/${id}`, 'PATCH', { received_date: '2026-10-05', source_name: 'อุดหนุน (แก้)', source_type: 'subsidy', amount: 4500 })).status, 200);
  assert.equal(env.raw.prepare('SELECT amount FROM budget_income WHERE id=?').get(id).amount, 4500);
  assert.equal((await call(env, 1, `/api/budget/income/${id}`, 'DELETE', {})).status, 400);
  assert.equal((await call(env, 1, `/api/budget/income/${id}`, 'DELETE', { reason: 'บันทึกซ้ำ' })).status, 200);
  assert.equal(env.raw.prepare('SELECT COUNT(*) n FROM budget_income').get().n, 0);
  assert.deepEqual(env.raw.prepare("SELECT action FROM audit_logs WHERE resource='budget_income' ORDER BY id").all().map((r) => r.action), ['create', 'update', 'delete']);
});

test('ordinary teachers see only their own budget requests and no income/audit in the overview', async () => {
  const env = await fixture();
  await call(env, 1, '/api/budget/income', 'POST', { received_date: '2026-10-05', source_name: 'อุดหนุน', source_type: 'subsidy', amount: 5000 });
  const teacher = await call(env, 4, '/api/budget/overview?fiscal_year=2570');
  assert.equal(teacher.status, 200);
  assert.equal(teacher.body.incomes.length, 0);
  assert.equal(teacher.body.permissions.can_view_finance, false);
  const finance = await call(env, 3, '/api/budget/overview?fiscal_year=2570');
  assert.equal(finance.body.incomes.length, 1);
  assert.equal(finance.body.permissions.can_view_finance, true);
});

test('CSV export neutralises spreadsheet formulas', async () => {
  const env = await fixture();
  env.raw.exec(`INSERT INTO project_expenses(id,project_id,expense_date,description,amount,created_by,status,fiscal_year,payee) VALUES (1,10,'2026-10-02','=HYPERLINK("http://x")',100,1,'paid',2570,'@evil')`);
  const csv = await call(env, 1, '/api/budget/reports/export?fiscal_year=2570');
  assert.equal(csv.status, 200);
  assert.match(csv.body, /'=HYPERLINK/);
  assert.ok(!/(^|,)"[=@]/m.test(csv.body), 'formula cells must be prefixed');
});

test('balance correction requests require project owner or finance', async () => {
  const env = await fixture();
  const outsider = await call(env, 4, '/api/projects/10/balance-requests', 'POST', { total_spent: 100, reason: 'ทดสอบ' });
  assert.equal(outsider.status, 403);
  const owner = await call(env, 2, '/api/projects/10/balance-requests', 'POST', { total_spent: 100, reason: 'ทดสอบ' });
  assert.notEqual(owner.status, 403);
});

test('task assignees are deduplicated, validated and keep their personal status on edit', async () => {
  const env = await fixture();
  assert.equal((await call(env, 2, '/api/tasks', 'POST', { title: 'งาน', assignee_ids: [999] })).status, 400);
  const created = await call(env, 2, '/api/tasks', 'POST', { title: 'งาน', assignee_ids: [4, 4, '5'] });
  assert.equal(created.status, 201);
  const id = created.body.id;
  assert.equal(env.raw.prepare('SELECT COUNT(*) n FROM task_assignees WHERE task_id=?').get(id).n, 2);
  env.raw.exec(`UPDATE task_assignees SET status='done' WHERE task_id=${id} AND user_id=4`);
  assert.equal((await call(env, 2, `/api/tasks/${id}`, 'PATCH', { title: '   ' })).status, 400);
  assert.equal((await call(env, 2, `/api/tasks/${id}`, 'PATCH', { assignee_ids: [] })).status, 400);
  assert.equal((await call(env, 2, `/api/tasks/${id}`, 'PATCH', { assignee_ids: [4, 3] })).status, 200);
  const rows = env.raw.prepare('SELECT user_id,status FROM task_assignees WHERE task_id=? ORDER BY user_id').all(id).map((r) => ({ ...r }));
  assert.deepEqual(rows, [{ user_id: 3, status: 'pending' }, { user_id: 4, status: 'done' }]);
});

test('inventory value excludes lost/disposed items and a good inspection clears repair status', async () => {
  const env = await fixture();
  const a = await call(env, 1, '/api/inventory/items', 'POST', { item_code: 'A1', name: 'โต๊ะ', item_type: 'equipment', unit: 'ตัว', opening_quantity: 2, unit_price: 100, status: 'repair' });
  assert.equal(a.status, 201, JSON.stringify(a.body));
  const b = await call(env, 1, '/api/inventory/items', 'POST', { item_code: 'A2', name: 'เก้าอี้', item_type: 'equipment', unit: 'ตัว', opening_quantity: 1, unit_price: 50, status: 'lost' });
  assert.equal(b.status, 201);
  assert.equal((await call(env, 1, '/api/inventory/summary')).body.total_value, 200);
  const insp = await call(env, 1, `/api/inventory/items/${a.body.id}/inspections`, 'POST', { inspection_date: '2026-10-10', quantity_found: 2, item_condition: 'good' });
  assert.ok(insp.status < 300, JSON.stringify(insp.body));
  assert.equal(env.raw.prepare('SELECT status FROM inventory_items WHERE id=?').get(a.body.id).status, 'active');
});
