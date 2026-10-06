# Automatic timetable scheduling

Academic sidebar → จัดตารางอัตโนมัติ (`/timetable-auto.html`). Managers: active academic department personnel, executives, superadmins. Other teachers can read the ordinary timetable.

Select a term and classrooms, enter one row per teacher/subject/classroom with weekly load, daily maximum and optional specialist room. Default subject capacity is [6,5,5,5,5]; later periods are reserved for learner development. Assign development activities and responsible teachers in the ordinary timetable. Existing development lessons remain preserved when regenerating subjects.

Preview checks classroom, teacher and specialist-room occupancy across selected classes and existing other-class lessons. Locked selected subject lessons must match the entered loads. Teachers' unavailable periods are hard constraints. Search spreads subjects across days, respects daily limits and is bounded at 40,000 nodes/150 ms. Timeout means inconclusive, not proven impossible. Infeasible runs do not write draft entries. Underfilled loads explicitly show remaining slots; no lessons or teachers are invented.

Apply recomputes the preview server-side, verifies the plan revision, preserves unselected classrooms and writes selected entries in one D1 batch with constraint guards. Draft publication remains the existing separate action. Concurrency mismatches and constraint failures roll back replacements. Preview/apply never publish. Settings persist per academic term; JSON import/export allows transfer within the same registry (personnel IDs are local).

Runtime migration adds `timetable_auto_config`, a `revision` column on `timetable_plans`, three entry revision triggers, and `timetable_auto_guard` used only during atomic applies. Existing timetable and substitute tables are reused. No production records are seeded. The P1 sample fills 23 subject periods per classroom; confirm personnel matches and add the remaining 3 periods and development teachers before actual use.

Validation: `node --test tests/timetable-auto.test.mjs tests/timetable-auto-api.test.mjs tests/timetable-sync.test.mjs tests/navigation-catalog.test.mjs tests/substitutes-leave.test.mjs`.

Loading fix: startup uses `/api/timetable/periods` for calendar metadata only. Existing timetable GETs take a read path before global unrelated schema initialization; table-existence checks allow migration fallback on first installation. No registration, merge/backfill or fiscal writes run on the read path. Each frontend request has a 25-second abort boundary, a stage-specific status, a retry action and a sign-in link on 401. The shared API helper forwards AbortSignal. Changed script references carry a version query for revalidation.
