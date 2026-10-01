// Live dashboard aggregates use the stored ledgers; no totals are kept in browser storage.
export async function dashboardActivitySummary(env, fiscalYear = null) {
  const start = fiscalYear ? `${fiscalYear-544}-10-01` : null;
  const end = fiscalYear ? `${fiscalYear-543}-09-30` : null;
  const [leaveRows, today, finances, years] = await Promise.all([
    env.DB.prepare(`SELECT leave_type,status,COUNT(*) request_count,
      COALESCE(SUM(CASE WHEN status='approved' THEN MAX(0,
        julianday(MIN(end_date,COALESCE(?,end_date)))-julianday(MAX(start_date,COALESCE(?,start_date)))+1) ELSE 0 END),0) approved_days
      FROM leave_requests WHERE (? IS NULL OR (end_date>=? AND start_date<=?)) GROUP BY leave_type,status`)
      .bind(end,start,start,start,end).all(),
    env.DB.prepare(`SELECT COUNT(DISTINCT user_id) people FROM leave_requests WHERE status='approved'
      AND start_date<=date('now','+7 hours') AND end_date>=date('now','+7 hours')`).first(),
    env.DB.prepare(`SELECT
      (SELECT COALESCE(SUM(amount),0) FROM budget_income WHERE (? IS NULL OR fiscal_year=?)) received_amount,
      (SELECT COALESCE(SUM(amount),0) FROM project_expenses WHERE status='paid' AND (? IS NULL OR fiscal_year=?)) paid_amount,
      (SELECT COALESCE(SUM(amount),0) FROM project_expenses WHERE status IN ('pending','approved') AND (? IS NULL OR fiscal_year=?)) reserved_amount`)
      .bind(fiscalYear,fiscalYear,fiscalYear,fiscalYear,fiscalYear,fiscalYear).first(),
    env.DB.prepare(`SELECT fiscal_year FROM projects WHERE fiscal_year IS NOT NULL UNION SELECT fiscal_year FROM budget_income
      UNION SELECT fiscal_year FROM project_expenses WHERE fiscal_year IS NOT NULL ORDER BY fiscal_year DESC`).all(),
  ]);
  const labels={sick:'ลาป่วย',personal:'ลากิจ',maternity:'ลาคลอด',other:'ลาอื่น ๆ'};
  const byType=Object.entries(labels).map(([key,label])=>{
    const rows=leaveRows.results.filter(r=>r.leave_type===key);
    const count=status=>Number(rows.find(r=>r.status===status)?.request_count||0);
    return {key,label,pending:count('pending'),approved:count('approved'),rejected:count('rejected'),
      total:rows.reduce((sum,r)=>sum+Number(r.request_count),0),approved_days:rows.reduce((sum,r)=>sum+Number(r.approved_days),0)};
  });
  const sum=key=>byType.reduce((n,r)=>n+r[key],0);
  return { fiscal_year:fiscalYear, fiscal_years:years.results.map(r=>Number(r.fiscal_year)),
    finance_summary:{received_amount:Number(finances.received_amount),paid_amount:Number(finances.paid_amount),
      reserved_amount:Number(finances.reserved_amount),balance_amount:Number(finances.received_amount)-Number(finances.paid_amount)},
    leave_summary:{total:sum('total'),pending:sum('pending'),approved:sum('approved'),rejected:sum('rejected'),
      approved_days:sum('approved_days'),on_leave_today:Number(today.people||0),by_type:byType} };
}

const revisionReady=new WeakSet();
export async function ensureDashboardRevision(env) {
  if(revisionReady.has(env.DB)) return;
  await env.DB.batch([
    env.DB.prepare('CREATE TABLE IF NOT EXISTS dashboard_revision (id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL DEFAULT 0)'),
    env.DB.prepare('INSERT OR IGNORE INTO dashboard_revision(id,revision) VALUES(1,0)'),
  ]);
  const tables=['projects','project_expenses','project_owners','budget_income','leave_requests','tasks','students','personnel_records',
    'project_balance_requests','project_balance_changes','users','academic_years','academic_terms','inventory_items','inventory_transactions'];
  const existing=await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
  const names=new Set(existing.results.map(r=>r.name));
  const statements=[];
  for(const table of tables.filter(t=>names.has(t))) for(const operation of ['INSERT','UPDATE','DELETE']) {
    statements.push(env.DB.prepare(`CREATE TRIGGER IF NOT EXISTS dashboard_${table}_${operation.toLowerCase()}
      AFTER ${operation} ON ${table} BEGIN UPDATE dashboard_revision SET revision=revision+1 WHERE id=1; END`));
  }
  if(statements.length) await env.DB.batch(statements);
  revisionReady.add(env.DB);
}
export async function dashboardRevision(env) {
  const row=await env.DB.prepare("SELECT revision,date('now','+7 hours') today FROM dashboard_revision WHERE id=1").first();
  return `${Number(row?.revision||0)}:${row.today}`;
}
