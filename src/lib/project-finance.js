// Monetary arithmetic uses integer satang. Project balances always follow the
// project ledger across its lifetime, even when a payment crosses fiscal years.
export function cents(value) {
  const n=Number(value);
  if (!Number.isFinite(n)) return NaN;
  const match=String(value).trim().match(/^([+-]?)(\d+)(?:\.(\d*))?(?:e([+-]?\d+))?$/i);
  if (!match) return Math.round(n*100);
  const sign=match[1]==='-'?-1:1, fraction=match[3]||'', exponent=Number(match[4]||0);
  const digits=BigInt(match[2]+fraction), scale=fraction.length-exponent-2;
  if(Math.abs(scale)>400)return Math.round(n*100);
  let result;
  if(scale<=0)result=digits*10n**BigInt(-scale);
  else {const divisor=10n**BigInt(scale);result=(digits+divisor/2n)/divisor;}
  const number=sign*Number(result);return Number.isSafeInteger(number)?number:NaN;
}
export const money=value=>cents(value)/100;
export function multiplyMoney(quantity,price) {
 const decimal=value=>{const m=String(value).trim().match(/^([+-]?)(\d+)(?:\.(\d*))?(?:e([+-]?\d+))?$/i);return m?{digits:BigInt((m[1]==='-'?'-':'')+m[2]+(m[3]||'')),exponent:Number(m[4]||0)-(m[3]||'').length}:null;};
 const a=decimal(quantity),b=decimal(price);if(!a||!b)return NaN;
 return money(`${a.digits*b.digits}e${a.exponent+b.exponent}`);
}

export const sumMoney=values=>values.reduce((sum,value)=>sum+cents(value),0)/100;
export function financialTotals(projects) {
 const total=key=>sumMoney(projects.map(p=>p[key]||0));
 const allocated=total('budget_amount'),paid=total('spent_amount'),pending=total('pending_amount'),approved=total('approved_amount');
 return {project_count:projects.length,total_amount:allocated,spent_amount:paid,pending_amount:pending,approved_amount:approved,
  reserved_amount:sumMoney([pending,approved]),remaining_amount:sumMoney([allocated,-paid]),available_amount:sumMoney([allocated,-paid,-pending,-approved])};
}
export async function projectFinancialRows(env,fiscalYear=null,department=null) {
 const {results}=await env.DB.prepare(`SELECT p.id,COALESCE(p.management_area,p.department) department,p.funding_type,p.fiscal_year,
  CAST(ROUND(COALESCE(p.budget_amount,0)*100+0.000001) AS INTEGER) budget_cents,
  COALESCE(SUM(CASE WHEN e.status='paid' THEN CAST(ROUND(e.amount*100+0.000001) AS INTEGER) ELSE 0 END),0) paid_cents,
  COALESCE(SUM(CASE WHEN e.status='pending' THEN CAST(ROUND(e.amount*100+0.000001) AS INTEGER) ELSE 0 END),0) pending_cents,
  COALESCE(SUM(CASE WHEN e.status='approved' THEN CAST(ROUND(e.amount*100+0.000001) AS INTEGER) ELSE 0 END),0) approved_cents,
  COALESCE(SUM(CASE WHEN e.status='paid' AND e.category='opening_balance' THEN CAST(ROUND(e.amount*100+0.000001) AS INTEGER) ELSE 0 END),0) opening_cents
  FROM projects p LEFT JOIN project_expenses e ON e.project_id=p.id
  WHERE (? IS NULL OR p.fiscal_year=?) AND (? IS NULL OR COALESCE(p.management_area,p.department)=?) GROUP BY p.id`)
  .bind(fiscalYear,fiscalYear,department,department).all();
 return results.map(p=>({id:p.id,department:p.department,funding_type:p.funding_type,fiscal_year:p.fiscal_year,
  budget_amount:p.budget_cents/100,spent_amount:p.paid_cents/100,pending_amount:p.pending_cents/100,approved_amount:p.approved_cents/100,
  reserved_amount:(p.pending_cents+p.approved_cents)/100,opening_spent_amount:p.opening_cents/100,confirmed_spent_amount:(p.paid_cents-p.opening_cents)/100,
  remaining_amount:(p.budget_cents-p.paid_cents)/100,available_amount:(p.budget_cents-p.paid_cents-p.pending_cents-p.approved_cents)/100}));
}

// ปีงบประมาณตามปฏิทินราชการ (ต.ค.–ก.ย.) ตามเวลาไทย
export function calendarFiscalYear(date = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10)) {
 const [year, month] = String(date).split('-').map(Number);
 return year + (month >= 10 ? 544 : 543);
}
// "ปีงบประมาณที่ใช้งาน" ของโครงการ = ปีของโครงการในปีการศึกษาปัจจุบัน
// โครงการของปีการศึกษาหนึ่งต้องใช้ต่อได้ทั้งปี (พ.ค.–มี.ค.) แม้ปฏิทินงบประมาณจะขึ้นปีใหม่ตั้งแต่ 1 ต.ค. แล้ว
// ไม่เช่นนั้นหน้าเบิกจ่าย/จัดซื้อจะเปิดมาเป็นปีใหม่ที่ยังไม่มีโครงการ และโครงการที่เพิ่มในภาคเรียนที่ 2 จะไปอยู่คนละปีกับโครงการเดิม
export async function workingFiscalYear(env) {
 const calendar = calendarFiscalYear();
 try {
  const row = await env.DB.prepare(`SELECT y.year_be, MAX(p.fiscal_year) max_fy,
    SUM(CASE WHEN p.fiscal_year=y.year_be THEN 1 ELSE 0 END) same_year
    FROM academic_years y LEFT JOIN projects p ON p.academic_year_id=y.id AND p.status<>'cancelled'
    WHERE y.status='active' GROUP BY y.id ORDER BY y.year_be DESC LIMIT 1`).first();
  if (row && Number(row.same_year) > 0) return Number(row.year_be);
  if (row?.max_fy) return Number(row.max_fy);
 } catch { /* ตารางยังไม่พร้อม → ใช้ปฏิทิน */ }
 return calendar;
}
