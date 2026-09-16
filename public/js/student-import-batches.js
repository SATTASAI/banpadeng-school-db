// Keep the acknowledged offset in memory so a failed batch can be retried.
// No student data is stored in localStorage.
const STUDENT_IMPORT_BATCH_SIZE = 20;

function createStudentImportSession(rows) {
  return {
    rows, offset: 0, created: 0, updated: 0,
    skipped: [], running: false,
  };
}

async function runStudentImportBatches(session, sendBatch, onProgress) {
  if (session.running) return;
  session.running = true;
  try {
    while (session.offset < session.rows.length) {
      const start = session.offset;
      const rows = session.rows.slice(start, start + STUDENT_IMPORT_BATCH_SIZE);
      onProgress(session);
      const result = await sendBatch(rows);
      // Do not advance after an invalid response or a failed request.
      if (!result || !Number.isInteger(result.created) || result.created < 0 ||
          !Number.isInteger(result.updated) || result.updated < 0 ||
          !Array.isArray(result.skipped) ||
          result.created + result.updated + result.skipped.length !== rows.length) {
        throw new Error("ผลตอบกลับจากระบบไม่ครบถ้วน กรุณาลองนำเข้าชุดนี้อีกครั้ง");
      }
      session.created += result.created;
      session.updated += result.updated;
      session.skipped.push(...result.skipped.map((item) => ({
        // Item numbers refer to parsed data rows, excluding headers and empty rows.
        row: start + item.row,
        reason: item.reason,
      })));
      session.offset += rows.length;
      onProgress(session);
    }
  } finally {
    session.running = false;
  }
}
