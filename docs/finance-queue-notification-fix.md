# Finance queue notification delivery

The finance queue in Budget → Other departments now includes projects from every fiscal year. The selected budget year still controls financial reports, funding summaries and the budget department's own projects. Pending requests remain sorted first by urgency and needed date.

Workflow actions and uploaded-attachment notifications use an event token as their transactional marker. Event insertion, expense transition, recipient notification and audit entry share a D1 batch. No action depends on SQL changes() retaining the previous statement's state. Invalid or repeated actions create no event, notification or extra payment.

When a finance reviewer, executive or administrator opens the queue or notification bar, pending requests without submission events receive a deterministic recovery event. Missing notifications for that recipient are inserted with the existing unique event/user constraint. This also supports finance staff assigned after submission. Existing read receipts stay read. Recovery does not modify amounts, request status or the current workflow step.

Finance notifications open Budget → Other departments and select the relevant project, including older fiscal years. Owner notifications continue to open project documents. Queue views refresh every five seconds when visible and immediately on local changes, tab changes, focus and cross-tab updates. Automatic refresh pauses while entering a form, editing a balance or searching; overlapping fetches reuse the active request.

Validation: 64 automated tests including connection-independent submission, receipt, completion and payment; recovery without resubmission; read receipt preservation; assignment after submission; and prior-year requests. DOM tests verify queue badges, the orange unread count, updates after another user's submission, and direct links opening the finance action panel.
