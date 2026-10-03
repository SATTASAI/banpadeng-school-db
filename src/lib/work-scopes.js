// Read legacy staff/personnel records together without changing their ownership or stored topics.
export const WORK_SCOPES = {
  'personnel-duties': {personnel:['1','3'],staff:['3','5']},
  'personnel-development': {personnel:['6','7'],staff:['4','7','8']},
};
export function workScopeCondition(scope, alias='w') {
 const contexts=WORK_SCOPES[scope];if(!contexts)return null;
 const binds=[],parts=Object.entries(contexts).map(([area,topics])=>{binds.push(area,...topics);return `(${alias}.area=? AND ${alias}.topic_key IN (${topics.map(()=>'?').join(',')}))`;});
 return {sql:'('+parts.join(' OR ')+')',binds};
}
export function workScopeSummary(rows) {
 return Object.fromEntries(Object.entries(WORK_SCOPES).map(([key,contexts])=>[key,rows.filter(r=>contexts[r.area]?.includes(String(r.topic_key))).reduce((s,r)=>({total:s.total+Number(r.total_count||0),completed:s.completed+Number(r.completed_count||0),overdue:s.overdue+Number(r.overdue_count||0)}),{total:0,completed:0,overdue:0})]));
}
