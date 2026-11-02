export function seedLeaveCalendar(env){
 if(env.raw.prepare('SELECT 1 FROM academic_years WHERE year_be=2569').get())return;
 env.raw.exec(`INSERT INTO academic_years(id,year_be,label,start_date,end_date) VALUES(900,2569,'ปีการศึกษา 2569','2026-05-01','2027-03-31');
 INSERT INTO academic_terms(id,academic_year_id,term_number,name,start_date,end_date) VALUES
 (900,900,1,'ภาคเรียนที่ 1','2026-05-01','2026-10-31'),
 (901,900,2,'ภาคเรียนที่ 2','2026-11-01','2027-03-31');`);
}
