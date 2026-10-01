# Project finance reconciliation, allocation charts and global notifications

Project amounts are calculated from one ledger with integer satang arithmetic.

- Allocated: the project's allocation, rounded to two decimal places.
- Paid: paid entries, including the historical opening balance, each counted once.
- Reserved: pending and approved entries. Draft, returned-to-draft, rejected and canceled entries reserve nothing.
- Remaining: allocated minus paid.
- Available for a new request: allocated minus paid minus reserved.
- Tax withholding belongs to the approved expenditure: deduct the gross paid amount from the project, display net payment separately.

Project summaries filter by the project's fiscal year and include its entire ledger, including payments crossing fiscal years. Cash movement and transaction reports filter by the transaction fiscal year. Historical canceled projects remain in project summaries so their allocation and spending history are not lost. Project owner joins and shared project names never multiply or merge amounts.

Dashboard, department, project document, budget and legacy project expense views use the same project finance calculations. Financial reports and stored paid-total triggers also add integer satang. Funding summaries reuse the same rows as the displayed project totals. Existing historical expense rows are not rewritten.

The dashboard pie chart shows allocations for the selected project fiscal year (all years by default). Department charts use every project in that department; the budget department chart follows its year selector. Each project remains a separate slice and table row, with year and project identifier. Percentages use the project's allocation divided by total allocations. The displayed two-decimal percentages are apportioned to total 100%. Zero allocations show an explicit empty-budget state.

The upper-right notification bar uses only the signed-in user's messages. Orange indicates unread messages and the badge counts every unread message, even when only the newest 50 are displayed. Sources: project workflow events and supplemental attachments, historical balance correction requests/results, pending leave approvals for administrators and leave results for the requester, assigned tasks, and assigned budget signatures. Clicking a message opens its relevant page; individual and all-message read receipts persist. Project and correction badges stay in sync. An embedded module uses the outer dashboard's notification bar. The bar refreshes after local changes, changes from embedded modules/tabs, on focus, and every five seconds while visible.

Validation includes cross-year expenditures, multiple owners, shared names, historical balances, withheld tax, all expense statuses, 120 fractional payments, scoped notification access, read receipts, badge counts over 50, and browser DOM checks for pie percentages, zero budgets and live orange notification counts.
