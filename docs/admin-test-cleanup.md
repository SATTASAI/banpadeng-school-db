# Avada Kedavra — administrator test cleanup

The green skull control appears only for `superadmin`. Activation creates a revocable, user-bound mode token valid for 15 minutes. An inactive/expired mode hides inline delete buttons. Executive and finance roles cannot use the API.

The manager supports requests/expenses, projects, leave requests, tasks, maintenance requests, budget income and documents. Search and pagination allow selection of up to 100 explicit IDs. Project and request panels offer direct delete controls while the mode is active.

Before deletion, the API resolves related records through foreign keys plus supporting documents and attachment associations. It previews selected roots, child counts, paid/reserved money and removed allocations. A signed five-minute preview binds the exact data. The administrator supplies a reason and types `Avada Kedavra` to confirm.

Deletion archives every removed row in `admin_cleanup_archive` and writes `test_cleanup` to the audit log. Original Drive/R2 objects are retained; attachment metadata is archived. This is a database cleanup, not physical file destruction. There is no automatic classification of test data: the administrator must select it.

The D1 batch checks row values and relationship counts, permits removal of only the targeted locked expenses via a transaction-local guard, deletes children before parents, clears the guard and commits the audit record. A stale preview, concurrent modification or FK failure refuses the entire operation. Normal confirmed-payment locks remain enabled outside this batch. Financial totals continue to derive from the canonical ledger; UI change events refresh dashboards and budget views.

Validation: 73 automated tests, including nine cleanup tests for permissions, revocation, expiry, stale/concurrent data, rollback, financial recalculation, seven supported sections and retained payment locks. Local browser DOM integration verifies activation, inline controls, preview/typed confirmation, deletion, queue refresh and mode shutdown.
