# Navigation audit — 3 October 2026

Sidebar submenu links reduced from **90 to 38**. All 6 department landing pages remain staff directories.

| Area | Before | After | Finding and resulting route |
| --- | ---: | ---: | --- |
| นักเรียน | 7 | 1 | Four section links opened the same student roster; one parent now opens /students.html. Analysis remains separate. |
| บุคลากร | 7 | 0 | Profile and licence section parameters were ignored. Parent opens /staff.html; leave and work records belong in Personnel. |
| ปีการศึกษา | 3 | 0 | Three section links all opened /academic-years.html; use one parent. |
| ฝ่ายวิชาการ | 9 | 9 | Keep actual timetable, substitute assignments, and the separate work-record log. Q-Info links have different external destinations. |
| ฝ่ายปฐมวัย | 7 | 6 | Short labels; templates available through the shared import centre. |
| ฝ่ายงบประมาณ | 10 | 8 | The default budget page duplicated Other Projects. Use explicit tabs: requests, disbursements, internal/other projects, income and reports. Template shortcuts go to shared import centre. |
| ฝ่ายบุคคล | 8 | 7 | Remove duplicate staff and leave entries elsewhere. Combine legacy staff/personnel duties and development records using read scopes. |
| ฝ่ายทั่วไป | 6 | 5 | Buildings and repairs share /maintenance.html; keep one entry here. Remove duplicate standalone repair branch. |
| อาคารและแจ้งซ่อม | 4 | 0 | Ignored section query links all opened the same repair/facility page. Consolidated under General. |
| ดูแลนักเรียน | 6 | 0 | All section links opened the same support form; use one parent. |
| เอกสาร | 6 | 2 | Search/upload/history are controls on /documents.html, not separate pages. Keep payment documents and import centre. |
| รายงาน | 5 | 0 | Five section links all opened /reports.html; use one parent. Budget financial report remains a distinct implemented page. |
| ผู้ใช้และสิทธิ์ | 3 | 0 | Accounts/roles/permissions sections all opened /admin-users.html; one parent. |
| สำรองและตรวจสอบ | 5 | 0 | Five section links opened /security.html; one parent for backups and audit controls. |
| สถานะระบบ | 1 | 0 | Child duplicated its parent destination; removed. |
| ตั้งค่า LINE | 3 | 0 | Three section links all opened /line-settings.html; one parent. |

## Compatibility and existing data

- /modules.html?module=… remains as an authenticated redirect to the real destination; obsolete descriptive cards are removed.
- Old work-record URLs resolve to the combined scope and retain the record id. Records keep their original area, topic, attachments, history and edit permissions.
- Duties combine personnel topics 1/3 and staff topics 3/5. Development and portfolios combine personnel topics 6/7 and staff topics 4/7/8.
- Personnel cards summarize the same combined records shown by their destination. Cancelled work does not count as overdue.
- Global search uses canonical destinations and preserves old names as searchable aliases.
- All direct sidebar destinations are unique, point to existing files, and use supported query parameters. No unsupported section links remain.
- Desktop layout CSS is unchanged; mobile drawer behaviour and admin visibility are retained.

## Validation

94 Node tests pass, including actual SQLite reads across legacy areas, status/search/year filters, totals, authentication and permissions. Dashboard UI fixture verifies immediate financial/leave updates; navigation fixture verifies desktop/mobile links, active menu state and deep links.
