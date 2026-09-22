import { getCurrentUser, isAdmin, jsonResponse } from "../lib/auth.js";

const noStore={"Cache-Control":"private, no-store"};
const respond=(body,status=200)=>jsonResponse(body,status,noStore);
const integer=value=>Number.isSafeInteger(Number(value))&&Number(value)>0?Number(value):null;
const note=value=>typeof value==="string"?value.trim():"";
function money(value){
  if(typeof value!=="string"&&typeof value!=="number")return null;
  const text=String(value).trim();if(!/^(?:0|[1-9]\d{0,7})(?:\.\d{1,2})?$/.test(text))return null;
  const [baht,satang=""]=text.split(".");const amount=Number(baht)*100+Number(satang.padEnd(2,"0"));
  return Number.isSafeInteger(amount)&&amount>0?amount:null;
}
const ready=new WeakSet();
async function schema(env){if(ready.has(env.DB))return;
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS school_bank_accounts(
    id INTEGER PRIMARY KEY AUTOINCREMENT,student_id INTEGER NOT NULL UNIQUE REFERENCES students(id),
    balance_satang INTEGER NOT NULL DEFAULT 0 CHECK(balance_satang>=0),
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','closed')),
    opened_by INTEGER NOT NULL REFERENCES users(id),opened_at TEXT NOT NULL DEFAULT(datetime('now')),
    closed_at TEXT)`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS school_bank_loans(
    id INTEGER PRIMARY KEY AUTOINCREMENT,account_id INTEGER NOT NULL REFERENCES school_bank_accounts(id),
    principal_satang INTEGER NOT NULL CHECK(principal_satang>0),purpose TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'requested' CHECK(status IN ('requested','active','rejected','closed')),
    requested_by INTEGER NOT NULL REFERENCES users(id),approved_by INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT(datetime('now')),approved_at TEXT,closed_at TEXT)`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS school_bank_transactions(
    id INTEGER PRIMARY KEY AUTOINCREMENT,account_id INTEGER NOT NULL REFERENCES school_bank_accounts(id),
    type TEXT NOT NULL CHECK(type IN ('deposit','withdraw','loan_disburse','loan_repay')),
    amount_satang INTEGER NOT NULL CHECK(amount_satang>0),balance_after_satang INTEGER NOT NULL CHECK(balance_after_satang>=0),
    related_loan_id INTEGER REFERENCES school_bank_loans(id),request_key TEXT NOT NULL UNIQUE,
    note TEXT,created_by INTEGER NOT NULL REFERENCES users(id),created_at TEXT NOT NULL DEFAULT(datetime('now'))
  )`).run();
  await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_school_bank_transactions_account ON school_bank_transactions(account_id,id DESC)").run();
  await env.DB.prepare("CREATE UNIQUE INDEX IF NOT EXISTS uq_school_bank_loan_disbursement ON school_bank_transactions(related_loan_id) WHERE type='loan_disburse'").run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS school_bank_loan_repayments(
    loan_id INTEGER NOT NULL REFERENCES school_bank_loans(id),
    transaction_id INTEGER NOT NULL UNIQUE REFERENCES school_bank_transactions(id),
    amount_satang INTEGER NOT NULL CHECK(amount_satang>0))`).run();
  await env.DB.prepare(`CREATE TRIGGER IF NOT EXISTS school_bank_tx_guard BEFORE INSERT ON school_bank_transactions BEGIN
    SELECT CASE WHEN (SELECT status FROM school_bank_accounts WHERE id=NEW.account_id)<>'active'
      THEN RAISE(ABORT,'BANK_ACCOUNT_CLOSED') END;
    SELECT CASE WHEN NEW.balance_after_satang <> (SELECT balance_satang FROM school_bank_accounts WHERE id=NEW.account_id)
      + CASE WHEN NEW.type IN ('deposit','loan_disburse') THEN NEW.amount_satang ELSE -NEW.amount_satang END
      OR NEW.balance_after_satang<0 THEN RAISE(ABORT,'BANK_INSUFFICIENT') END;
  END`).run();
  await env.DB.prepare(`CREATE TRIGGER IF NOT EXISTS school_bank_tx_apply AFTER INSERT ON school_bank_transactions BEGIN
    UPDATE school_bank_accounts SET balance_satang=NEW.balance_after_satang WHERE id=NEW.account_id;
  END`).run();
  ready.add(env.DB);
}
async function account(env,id){return id&&env.DB.prepare(`SELECT a.*,s.student_code,s.full_name FROM school_bank_accounts a
  JOIN students s ON s.id=a.student_id WHERE a.id=?`).bind(id).first();}
async function list(env,termId){
  if(!termId)return respond({error:"เลือกภาคเรียนให้ถูกต้อง"},400);
  const term=await env.DB.prepare("SELECT id,name FROM academic_terms WHERE id=?").bind(termId).first();
  if(!term)return respond({error:"ไม่พบภาคเรียน"},404);
  const {results}=await env.DB.prepare(`SELECT s.id AS student_id,s.student_code,s.full_name,e.grade_level,e.classroom,
    a.id AS account_id,a.balance_satang,a.status AS account_status,
    (SELECT COUNT(*) FROM school_bank_loans l WHERE l.account_id=a.id AND l.status IN ('requested','active')) AS open_loans
    FROM student_enrollments e JOIN students s ON s.id=e.student_id
    LEFT JOIN school_bank_accounts a ON a.student_id=s.id
    WHERE e.academic_term_id=? AND e.status='enrolled' ORDER BY e.grade_level,e.classroom,s.full_name`)
    .bind(termId).all();
  return respond({term,students:results});
}
async function open(request,env,user){
  const body=await request.json().catch(()=>null),studentId=integer(body?.student_id),termId=integer(body?.term_id);
  if(!studentId||!termId)return respond({error:"เลือกนักเรียนและภาคเรียน"},400);
  const enrolled=await env.DB.prepare("SELECT 1 FROM student_enrollments WHERE student_id=? AND academic_term_id=? AND status='enrolled'")
    .bind(studentId,termId).first();if(!enrolled)return respond({error:"นักเรียนไม่อยู่ในทะเบียนภาคเรียนนี้"},400);
  const existing=await env.DB.prepare("SELECT id,status FROM school_bank_accounts WHERE student_id=?").bind(studentId).first();
  if(existing)return respond({error:"นักเรียนมีบัญชีอยู่แล้ว"},409);
  await env.DB.prepare("INSERT INTO school_bank_accounts(student_id,opened_by) VALUES (?,?)").bind(studentId,user.id).run();
  return respond({ok:true},201);
}
async function detail(env,id){
  const found=await account(env,id);if(!found)return respond({error:"ไม่พบบัญชี"},404);
  const [transactions,loans]=await Promise.all([
    env.DB.prepare(`SELECT id,type,amount_satang,balance_after_satang,note,created_at FROM school_bank_transactions
      WHERE account_id=? ORDER BY id DESC LIMIT 200`).bind(id).all(),
    env.DB.prepare(`SELECT l.*,l.principal_satang-COALESCE((SELECT SUM(r.amount_satang) FROM school_bank_loan_repayments r
      WHERE r.loan_id=l.id),0) AS outstanding_satang FROM school_bank_loans l WHERE l.account_id=? ORDER BY l.id DESC`).bind(id).all()
  ]);
  return respond({account:found,transactions:transactions.results,loans:loans.results});
}
async function transact(request,env,user,id){
  const body=await request.json().catch(()=>null),type=body?.type,amount=money(body?.amount),comment=note(body?.note);
  if(!["deposit","withdraw"].includes(type)||!amount||comment.length>300)return respond({error:"ระบุประเภท จำนวนเงิน และหมายเหตุให้ถูกต้อง"},400);
  const found=await account(env,id);if(!found||found.status!=="active")return respond({error:"ไม่พบบัญชีที่เปิดใช้งาน"},404);
  const key=typeof body?.request_key==="string"&&/^[a-zA-Z0-9_-]{12,100}$/.test(body.request_key)?body.request_key:null;
  if(!key)return respond({error:"คำขอทำรายการไม่ถูกต้อง"},400);
  const used=await env.DB.prepare("SELECT account_id FROM school_bank_transactions WHERE request_key=?").bind(key).first();
  if(used)return respond({error:"รายการนี้บันทึกแล้ว กรุณารีเฟรชบัญชี"},409);
  try{const result=await env.DB.prepare(`INSERT INTO school_bank_transactions(account_id,type,amount_satang,balance_after_satang,request_key,note,created_by)
    SELECT id,?,?,balance_satang+?, ?,?,? FROM school_bank_accounts WHERE id=? AND status='active'
    AND balance_satang+?>=0`)
    .bind(type,amount,type==="deposit"?amount:-amount,key,comment||null,user.id,id,type==="deposit"?amount:-amount).run();
    if(!result.meta.changes)return respond({error:"ยอดเงินไม่พอหรือบัญชีปิดแล้ว"},409);
  }catch(error){if(/UNIQUE constraint|BANK_INSUFFICIENT|BANK_ACCOUNT_CLOSED/i.test(String(error)))return respond({error:"รายการซ้ำ ยอดเงินไม่พอ หรือบัญชีปิดแล้ว"},409);throw error;}
  return respond({ok:true});
}
async function close(env,id){
  const loans=await env.DB.prepare("SELECT 1 FROM school_bank_loans WHERE account_id=? AND status IN ('requested','active') LIMIT 1").bind(id).first();
  if(loans)return respond({error:"ยังมีสินเชื่อที่ต้องดำเนินการ"},409);
  const result=await env.DB.prepare("UPDATE school_bank_accounts SET status='closed',closed_at=datetime('now') WHERE id=? AND status='active' AND balance_satang=0").bind(id).run();
  return result.meta.changes?respond({ok:true}):respond({error:"ปิดบัญชีได้เมื่อยอดคงเหลือเป็นศูนย์"},409);
}
async function applyLoan(request,env,user,id){
  const body=await request.json().catch(()=>null),amount=money(body?.amount),purpose=note(body?.purpose);
  if(!amount||!purpose||purpose.length>300)return respond({error:"ระบุวงเงินและวัตถุประสงค์"},400);
  const found=await account(env,id);if(!found||found.status!=="active")return respond({error:"ไม่พบบัญชีที่เปิดใช้งาน"},404);
  await env.DB.prepare("INSERT INTO school_bank_loans(account_id,principal_satang,purpose,requested_by) VALUES (?,?,?,?)")
    .bind(id,amount,purpose,user.id).run();return respond({ok:true},201);
}
async function loanById(env,id){return id&&env.DB.prepare(`SELECT l.*,a.balance_satang,a.status AS account_status FROM school_bank_loans l
  JOIN school_bank_accounts a ON a.id=l.account_id WHERE l.id=?`).bind(id).first();}
async function approveLoan(env,user,id){
  const loan=await loanById(env,id);if(!loan||loan.status!=="requested"||loan.account_status!=="active")return respond({error:"สินเชื่อนี้ดำเนินการแล้วหรือบัญชีปิด"},409);
  const key=`loan_${id}_disburse`;
  try{await env.DB.batch([
    env.DB.prepare(`INSERT INTO school_bank_transactions(account_id,type,amount_satang,balance_after_satang,related_loan_id,request_key,note,created_by)
      SELECT l.account_id,'loan_disburse',l.principal_satang,a.balance_satang+l.principal_satang,l.id,?,'จ่ายสินเชื่อ',?
      FROM school_bank_loans l JOIN school_bank_accounts a ON a.id=l.account_id WHERE l.id=? AND l.status='requested' AND a.status='active'`)
      .bind(key,user.id,id),
    env.DB.prepare("UPDATE school_bank_loans SET status='active',approved_by=?,approved_at=datetime('now') WHERE id=? AND status='requested'").bind(user.id,id)
  ]);}catch(error){if(/UNIQUE constraint|BANK_ACCOUNT_CLOSED/i.test(String(error)))return respond({error:"สินเชื่อถูกจ่ายแล้ว กรุณารีเฟรช"},409);throw error;}
  return respond({ok:true});
}
async function rejectLoan(env,id){const result=await env.DB.prepare("UPDATE school_bank_loans SET status='rejected' WHERE id=? AND status='requested'").bind(id).run();return result.meta.changes?respond({ok:true}):respond({error:"สินเชื่อนี้ดำเนินการแล้ว"},409);}
async function repayLoan(request,env,user,id){
  const body=await request.json().catch(()=>null),amount=money(body?.amount),key=body?.request_key;
  if(!amount||typeof key!=="string"||!/^[a-zA-Z0-9_-]{12,100}$/.test(key))return respond({error:"จำนวนเงินหรือคำขอไม่ถูกต้อง"},400);
  const loan=await loanById(env,id);if(!loan||loan.status!=="active"||loan.account_status!=="active")return respond({error:"สินเชื่อหรือบัญชีไม่พร้อมรับชำระ"},409);
  try{
    const results=await env.DB.batch([
      env.DB.prepare(`INSERT INTO school_bank_transactions(account_id,type,amount_satang,balance_after_satang,related_loan_id,request_key,note,created_by)
        SELECT a.id,'loan_repay',?,a.balance_satang-?,l.id,?,'ชำระสินเชื่อ',?
        FROM school_bank_loans l JOIN school_bank_accounts a ON a.id=l.account_id
        WHERE l.id=? AND l.status='active' AND a.status='active' AND a.balance_satang>=?
        AND ?<=l.principal_satang-COALESCE((SELECT SUM(amount_satang) FROM school_bank_loan_repayments WHERE loan_id=l.id),0)`)
        .bind(amount,amount,key,user.id,id,amount,amount),
      env.DB.prepare(`INSERT INTO school_bank_loan_repayments(loan_id,transaction_id,amount_satang)
        SELECT related_loan_id,id,amount_satang FROM school_bank_transactions WHERE request_key=? AND type='loan_repay'`).bind(key),
      env.DB.prepare(`UPDATE school_bank_loans SET status='closed',closed_at=datetime('now') WHERE id=? AND status='active'
        AND principal_satang<=COALESCE((SELECT SUM(amount_satang) FROM school_bank_loan_repayments WHERE loan_id=?),0)`).bind(id,id)
    ]);
    if(!results[0].meta.changes)return respond({error:"ยอดบัญชีไม่พอหรือจำนวนที่ชำระเกินยอดค้าง"},409);
  }catch(error){if(/UNIQUE constraint|BANK_INSUFFICIENT|BANK_ACCOUNT_CLOSED/i.test(String(error)))return respond({error:"รายการซ้ำหรือยอดเงินไม่พอ"},409);throw error;}
  return respond({ok:true});
}

export async function handleSchoolBankRoute(request,env,pathname,method){
  if(!pathname.startsWith("/api/school-bank/"))return null;
  const user=await getCurrentUser(request,env);
  if(!user||!user.role)return respond({error:"กรุณาเข้าสู่ระบบ"},401);
  if(!isAdmin(user)&&user.role!=="staff")return respond({error:"เฉพาะเจ้าหน้าที่ธนาคารโรงเรียนหรือผู้บริหาร"},403);
  await schema(env);const url=new URL(request.url);
  if(pathname==="/api/school-bank/students"&&method==="GET")return list(env,integer(url.searchParams.get("term_id")));
  if(pathname==="/api/school-bank/accounts"&&method==="POST")return open(request,env,user);
  const accountMatch=pathname.match(/^\/api\/school-bank\/accounts\/(\d+)$/);
  if(accountMatch&&method==="GET")return detail(env,Number(accountMatch[1]));
  if(accountMatch&&method==="DELETE")return isAdmin(user)?close(env,Number(accountMatch[1])):respond({error:"เฉพาะผู้บริหารหรือผู้ดูแลระบบ"},403);
  const txMatch=pathname.match(/^\/api\/school-bank\/accounts\/(\d+)\/transactions$/);
  if(txMatch&&method==="POST")return transact(request,env,user,Number(txMatch[1]));
  const loanMatch=pathname.match(/^\/api\/school-bank\/accounts\/(\d+)\/loans$/);
  if(loanMatch&&method==="POST")return applyLoan(request,env,user,Number(loanMatch[1]));
  const approveMatch=pathname.match(/^\/api\/school-bank\/loans\/(\d+)\/(approve|reject)$/);
  if(approveMatch&&method==="POST")return isAdmin(user)?approveMatch[2]==="approve"?approveLoan(env,user,Number(approveMatch[1])):rejectLoan(env,Number(approveMatch[1])):respond({error:"เฉพาะผู้บริหารหรือผู้ดูแลระบบ"},403);
  const repayMatch=pathname.match(/^\/api\/school-bank\/loans\/(\d+)\/repay$/);
  if(repayMatch&&method==="POST")return repayLoan(request,env,user,Number(repayMatch[1]));
  return respond({error:"ไม่พบ endpoint"},404);
}
