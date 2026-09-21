import test from "node:test";
import assert from "node:assert/strict";
import {prepareTeachingImport} from "./teaching-assignments.js";

const personnel=[
  {id:1,full_name:"นางสาววรรณมาศ จันทร์ชัง",homeroom_classroom:"ป.4/1"},
  {id:2,full_name:"นายพงศ์พล ตัวอย่าง",homeroom_classroom:""}
];

test("matches first names and infers homeroom",()=>{
  const result=prepareTeachingImport({rows:[
    {teacher:"วรรณมาศ",classroom:"ป.4/2",subject:"ภาษาไทย",periods_per_week:3},
    {teacher:"วรรณมาศ",classroom:null,subject:"การป้องกันการทุจริต",periods_per_week:1,infer_homeroom:true}
  ]},personnel);
  assert.equal(result.rows.length,2);
  assert.equal(result.rows.find(x=>x.subject_name==="การป้องกันการทุจริต").classroom,"ป.4/1");
  assert.equal(result.unmatched_teachers.length,0);
});

test("keeps the actual day and period schedule",()=>{
  const result=prepareTeachingImport({rows:[
    {teacher:"วรรณมาศ",classroom:"ป.4/1",subject:"ภาษาไทย",periods_per_week:1}
  ],slots:[
    {teacher:"วรรณมาศ",day:1,period:4,classroom:"ป.4/1",subject:"ภาษาไทย"}
  ]},personnel);
  assert.deepEqual(result.slots.map(x=>[x.day_number,x.period_number,x.classroom]),[[1,4,"ป.4/1"]]);
});

test("requires a preference when both duplicate teachers exist",()=>{
  const people=[...personnel,{id:3,full_name:"นางสาวปณัฏฐา ตัวอย่าง",homeroom_classroom:""}];
  const payload={rows:[
    {teacher:"พงศ์พล",classroom:"ป.6/4",subject:"วิทยาการคำนวณ",periods_per_week:1,duplicate_group:"d1"},
    {teacher:"ปณัฏฐา",classroom:"ป.6/4",subject:"วิทยาการคำนวณ",periods_per_week:1,duplicate_group:"d1"}
  ]};
  const blocked=prepareTeachingImport(payload,people);
  assert.equal(blocked.unresolved_duplicates.length,1);
  const chosen=prepareTeachingImport({...payload,duplicate_preferences:{d1:"ปณัฏฐา"}},people);
  assert.equal(chosen.unresolved_duplicates.length,0);
  assert.equal(chosen.rows[0].teacher,"นางสาวปณัฏฐา ตัวอย่าง");
});
