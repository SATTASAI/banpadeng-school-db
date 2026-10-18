// Owned by the evaluation module; never migrates unrelated school modules.
export const EVALUATION_SCHEMA = [
`CREATE TABLE IF NOT EXISTS evaluation_templates (
 id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('pa','assistant')),
 reference TEXT NOT NULL, rubric_json TEXT NOT NULL, verified INTEGER NOT NULL DEFAULT 0,
 created_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)`,
`CREATE TABLE IF NOT EXISTS evaluation_cases (
 id INTEGER PRIMARY KEY AUTOINCREMENT, personnel_id INTEGER NOT NULL REFERENCES personnel_records(id),
 template_id INTEGER NOT NULL REFERENCES evaluation_templates(id), title TEXT NOT NULL, fiscal_year INTEGER NOT NULL,
 cycle INTEGER NOT NULL DEFAULT 1 CHECK(cycle BETWEEN 1 AND 4), start_date TEXT NOT NULL, end_date TEXT NOT NULL,
 rank TEXT NOT NULL DEFAULT '', challenge TEXT NOT NULL DEFAULT '', evidence_url TEXT NOT NULL DEFAULT '',
 rubric_json TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'draft' CHECK(state IN ('draft','open','published')),
 result_json TEXT, published_by INTEGER REFERENCES users(id), published_at TEXT,
 created_by INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)`,
`CREATE TABLE IF NOT EXISTS evaluation_assignments (
 id INTEGER PRIMARY KEY AUTOINCREMENT, case_id INTEGER NOT NULL REFERENCES evaluation_cases(id),
 user_id INTEGER REFERENCES users(id), guest_name TEXT, guest_org TEXT, invite_hash TEXT UNIQUE, session_hash TEXT UNIQUE,
 expires_at INTEGER, redeemed_at INTEGER, revoked_at INTEGER, created_by INTEGER NOT NULL REFERENCES users(id),
 CHECK ((user_id IS NOT NULL AND guest_name IS NULL) OR (user_id IS NULL AND guest_name IS NOT NULL)),
 UNIQUE(case_id,user_id)
)`,
`CREATE TABLE IF NOT EXISTS evaluation_ballots (
 assignment_id INTEGER PRIMARY KEY REFERENCES evaluation_assignments(id), scores_json TEXT NOT NULL DEFAULT '{}',
 comment TEXT NOT NULL DEFAULT '', revision INTEGER NOT NULL DEFAULT 0, submitted_at TEXT,
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)`,
`CREATE TABLE IF NOT EXISTS evaluation_events (
 id INTEGER PRIMARY KEY AUTOINCREMENT, case_id INTEGER REFERENCES evaluation_cases(id),
 actor_user_id INTEGER REFERENCES users(id), actor_assignment_id INTEGER REFERENCES evaluation_assignments(id),
 action TEXT NOT NULL, detail_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)`,
`CREATE INDEX IF NOT EXISTS idx_evaluation_personnel ON evaluation_cases(personnel_id,state,fiscal_year)`,
`CREATE INDEX IF NOT EXISTS idx_evaluation_assignee ON evaluation_assignments(user_id,case_id)`
];
const ready = new WeakMap();
export function ensureEvaluationSchema(env) {
 let promise=ready.get(env.DB);
 if(!promise){promise=env.DB.batch(EVALUATION_SCHEMA.map(sql=>env.DB.prepare(sql)));ready.set(env.DB,promise);promise.catch(()=>ready.delete(env.DB));}
 return promise;
}
