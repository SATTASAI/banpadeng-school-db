import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {ensureLeaveSubtypeSchema} from '../src/lib/leave-data.js';

function database(constrained=true){
 const raw=new DatabaseSync(':memory:');
 raw.exec(`PRAGMA foreign_keys=ON;
 CREATE TABLE leave_requests(id INTEGER PRIMARY KEY,leave_type TEXT NOT NULL,leave_subtype TEXT ${constrained?"CHECK (leave_subtype IS NULL OR leave_subtype='lenient')":''},leave_days REAL);
 CREATE TABLE leave_events(id INTEGER PRIMARY KEY,leave_id INTEGER REFERENCES leave_requests(id));
 CREATE TABLE revisions(n INTEGER);INSERT INTO revisions VALUES(0);
 CREATE TRIGGER leave_revision AFTER UPDATE ON leave_requests BEGIN UPDATE revisions SET n=n+1;END;
 INSERT INTO leave_requests VALUES(1,'other','lenient',0.5),(2,'maternity',NULL,4);
 INSERT INTO leave_events VALUES(1,1),(2,2);`);
 function prepare(sql){return{sql,async first(){return raw.prepare(sql).get()||null},async run(){return raw.prepare(sql).run()}};}
 return{raw,DB:{prepare,async batch(statements){raw.exec('BEGIN');try{const results=[];for(const s of statements)results.push(await s.run());raw.exec('COMMIT');return results;}catch(e){raw.exec('ROLLBACK');throw e;}}}};
}

test('legacy subtype upgrade keeps ids, day totals, foreign keys and triggers; repeated runs are safe',async()=>{
 const env=database(),before=env.raw.prepare('SELECT * FROM leave_requests ORDER BY id').all();
 await ensureLeaveSubtypeSchema(env);await ensureLeaveSubtypeSchema(env);
 assert.deepEqual(env.raw.prepare('SELECT id,leave_type,leave_subtype,leave_days FROM leave_requests ORDER BY id').all(),before);
 env.raw.exec("INSERT INTO leave_requests(id,leave_type,leave_subtype,leave_days) VALUES(3,'other','paternity',2)");
 assert.equal(env.raw.prepare('SELECT leave_subtype FROM leave_requests WHERE id=3').get().leave_subtype,'paternity');
 assert.equal(env.raw.prepare('SELECT COUNT(*) n FROM leave_events').get().n,2);
 assert.deepEqual(env.raw.prepare('PRAGMA foreign_key_check').all(),[]);
 const n=env.raw.prepare('SELECT n FROM revisions').get().n;
 env.raw.exec('UPDATE leave_requests SET leave_days=3 WHERE id=3');
 assert.equal(env.raw.prepare('SELECT n FROM revisions').get().n,n+1);
});

test('upgrade failures roll back the entire schema change and preserve the old records',async()=>{
 const env=database(),batch=env.DB.batch;
 env.DB.batch=stmts=>batch(stmts.map(s=>s.sql.startsWith('ALTER TABLE leave_requests ADD COLUMN')?env.DB.prepare('SELECT * FROM simulated_missing_table'):s));
 await assert.rejects(ensureLeaveSubtypeSchema(env),/simulated_missing_table/);
 const names=env.raw.prepare('PRAGMA table_info(leave_requests)').all().map(c=>c.name);
 assert(names.includes('leave_subtype'));assert(!names.includes('legacy_leave_subtype'));
 assert.equal(env.raw.prepare('SELECT leave_subtype FROM leave_requests WHERE id=1').get().leave_subtype,'lenient');
});

test('existing unconstrained subtype columns need no rename',async()=>{
 const env=database(false);await ensureLeaveSubtypeSchema(env);
 assert(!env.raw.prepare('PRAGMA table_info(leave_requests)').all().some(c=>c.name==='legacy_leave_subtype'));
});
