// A LINE recipient can read a limited leave summary via a random, expiring bearer link.
// Store only a hash of the token; a leave ID alone never grants access.
const TTL_DAYS = 7;
const ready = new WeakSet();

async function ensureSchema(env) {
  if (ready.has(env.DB)) return;
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS leave_line_access (
    token_hash TEXT PRIMARY KEY,
    leave_id INTEGER NOT NULL REFERENCES leave_requests(id) ON DELETE CASCADE,
    recipient_user_id INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL
  )`).run();
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_leave_line_access_expiry ON leave_line_access(expires_at)').run();
  ready.add(env.DB);
}

async function sha256(value) {
  const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value));
  return [...new Uint8Array(hash)].map(n=>n.toString(16).padStart(2,'0')).join('');
}

export async function createLeaveAccessUrl(env, messageKey, recipientId) {
  const match=String(messageKey).match(/^leave:(\d+):(pending|forwarded|reviewed|approved|rejected)$/);
  if(!match)return null;
  await ensureSchema(env);
  const token=[...crypto.getRandomValues(new Uint8Array(32))].map(n=>n.toString(16).padStart(2,'0')).join('');
  await env.DB.prepare(`INSERT INTO leave_line_access(token_hash,leave_id,recipient_user_id,expires_at)
    VALUES(?,?,?,datetime('now','+${TTL_DAYS} days'))`).bind(await sha256(token),Number(match[1]),recipientId).run();
  return `/leave-view.html?token=${token}`;
}

export async function readLeaveAccess(env, token) {
  if(typeof token!=='string'||!/^([a-f0-9]{64})$/.test(token))return null;
  await ensureSchema(env);
  return env.DB.prepare(`SELECT r.id,r.leave_type,r.leave_subtype,r.reason,r.start_date,r.end_date,r.leave_days,
    r.status,r.workflow_stage,r.created_at,u.full_name
    FROM leave_line_access a JOIN leave_requests r ON r.id=a.leave_id
    JOIN users u ON u.id=r.user_id JOIN users recipient ON recipient.id=a.recipient_user_id
    WHERE a.token_hash=? AND a.expires_at>datetime('now')
    AND recipient.status='active' AND recipient.deleted_at IS NULL
    AND (recipient.id=r.user_id OR recipient.role='superadmin'
      OR EXISTS(SELECT 1 FROM department_staff d JOIN personnel_accounts pa ON pa.personnel_id=d.personnel_id
        JOIN personnel_records p ON p.id=d.personnel_id AND p.status='active'
        WHERE d.department='personnel' AND d.is_head=1 AND pa.user_id=recipient.id)
      OR (recipient.role='executive' AND EXISTS(SELECT 1 FROM personnel_accounts pa
        JOIN personnel_records p ON p.id=pa.personnel_id AND p.status='active'
        WHERE pa.user_id=recipient.id AND p.id=r.deputy_personnel_id AND REPLACE(p.position,' ','') LIKE '%รองผู้อำนวยการ%'))
      OR (recipient.role='executive' AND EXISTS(SELECT 1 FROM leave_reviewers v WHERE v.leave_id=r.id AND v.user_id=recipient.id)))
    LIMIT 1`).bind(await sha256(token)).first();
}
