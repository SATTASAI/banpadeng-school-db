# Automatic timetable scheduling

Academic sidebar → จัดตารางอัตโนมัติ (`/timetable-auto.html`). Managers: active academic department personnel, executives, superadmins. Other teachers can read the ordinary timetable.

Select a term and classrooms, enter one row per teacher/subject/classroom with weekly load, daily maximum and optional specialist room. Default subject capacity is [6,5,5,5,5]; later periods are reserved for learner development. Assign development activities and responsible teachers in the ordinary timetable. Existing development lessons remain preserved when regenerating subjects.

Preview checks classroom, teacher and specialist-room occupancy across selected classes and existing other-class lessons. Locked selected subject lessons must match the entered loads. Teachers' unavailable periods are hard constraints. Search spreads subjects across days, respects daily limits and is bounded at 2,000,000 nodes / 7 s per preview (see 2026-10-15 update). Timeout means inconclusive, not proven impossible. Infeasible runs do not write draft entries. Underfilled loads explicitly show remaining slots; no lessons or teachers are invented.

Apply recomputes the preview server-side, verifies the plan revision, preserves unselected classrooms and writes selected entries in one D1 batch with constraint guards. Draft publication remains the existing separate action. Concurrency mismatches and constraint failures roll back replacements. Preview/apply never publish. Settings persist per academic term; JSON import/export allows transfer within the same registry (personnel IDs are local).

Runtime migration adds `timetable_auto_config`, a `revision` column on `timetable_plans`, three entry revision triggers, and `timetable_auto_guard` used only during atomic applies. Existing timetable and substitute tables are reused. No production records are seeded. The P1 sample fills 23 subject periods per classroom; confirm personnel matches and add the remaining 3 periods and development teachers before actual use.

Validation: `node --test tests/timetable-auto.test.mjs tests/timetable-auto-api.test.mjs tests/timetable-sync.test.mjs tests/navigation-catalog.test.mjs tests/substitutes-leave.test.mjs`.

Loading fix: startup uses `/api/timetable/periods` for calendar metadata only. Existing timetable GETs take a read path before global unrelated schema initialization; table-existence checks allow migration fallback on first installation. No registration, merge/backfill or fiscal writes run on the read path. Each frontend request has a 25-second abort boundary, a stage-specific status, a retry action and a sign-in link on 401. The shared API helper forwards AbortSignal. Changed script references carry a version query for revalidation.


## 2026-10-15 update — whole-school scheduling

- **Speed.** Occupancy is held in numeric 5×6 grids instead of string keys; search uses most-constrained-first with short, growing restarts (seeded, so repeatable) that move subjects that keep failing to the front. 20 classrooms with shared English/computer/music teachers and rooms solve in under a second; 24 near-full classrooms in a few seconds. Budget: 7 s CPU per preview (`SEARCH_MS` in `src/routes/timetable-auto.js`).
- **Why it failed.** Before searching, the solver proves obvious impossibilities and names them: a subject that cannot fit (teacher busy in other rooms, teacher unavailable, specialist room busy, class already full, per-day limit), a teacher whose remaining load exceeds free slots, or a specialist room that is overbooked. If the search itself runs out, it lists the subjects that dead-ended most often. Teacher names come from the registry. Structured `diagnostics` are returned with the 422.
- **Place what fits (`allow_partial`).** Checkbox in step 3. The best partial search state is completed greedily, then repaired by moving single lessons inside a classroom to open a slot for a missing one. The result has `partial: true` and `unplaced[]` (subject, teacher, missing periods, reason) shown under each classroom; it can be saved as a draft and finished by hand in the ordinary timetable.
- **Better placement.** Per row "ช่วงเวลา": อัตโนมัติ (Thai/maths/science/English → morning), เช้า, บ่าย, ไม่กำหนด. Ordering also keeps a teacher's daily load even. These are preferences, never hard constraints. Excel import/export has a `ช่วงเวลา` column (blank = อัตโนมัติ).
- **Specialist room names.** Spellings that differ only by spaces, case or a trailing ฯ/. are the same room (`roomNameKey`); the first spelling already in the timetable is kept. The page offers existing names in a dropdown list and the load check warns about names that look like the same room. Manual slot saves in `/timetable.html` reuse the existing spelling too.
- **Teacher view.** Teacher tables after a preview include lessons the teacher already teaches in classrooms not selected in this run (grey cells, "ตารางเดิม") and the weekly total.
- **Apply = what you saw.** Apply sends the previewed entries; the server re-verifies them against the current draft (collisions, loads, daily limits, blocks, unavailability) instead of searching again. Requests without `entries` keep the old re-solve behaviour.
- **Save conditions** no longer requires a solvable timetable, so unfinished settings can be stored.
- UI: select-all / clear classroom buttons; mobile no longer overflows sideways (fieldset min-width).
