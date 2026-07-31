---
id: intake/form-intake
package: "@elements/intake-form-intake"
plane: data
category: intake
version: 0.1.0
variationGroup: null
variationAxis: null
summary: The write-side discipline — every form submission becomes a validated, transactional write with a typed result or a visible rejection.
provides: [intakeWrite, rejectIntake]
requiresElements: [lifecycle/service-runtime, storage/sqlite-drizzle]
requiresConfig: []
claims:
  - "A submission either fully succeeds or fully fails with a visible reason — data is never half-written."
whenToUse: "Every mutation that originates from user input."
whenNotToUse: "Bulk file imports or scheduled ingestion — future intake variations."
---

## Purpose

One shape for accepting user input on the server: the procedure's zod schema validates, `intakeWrite` wraps the write in a transaction, and `rejectIntake` turns a domain rule violation into a message the submitting form displays.

## Behavior

Submitting a form either records everything the submission implies or records nothing. When a submission is refused — invalid values or a domain rule — the person submitting sees the reason, and nothing has changed. A submission never partially applies.

## Configuration

None. The zod schema and the write body are bespoke.

## Wiring

Bespoke routers compose it: `procedure.input(schema).mutation(intakeWrite(write))`. Pairs with `shell/schema-forms` on the client through the shared bespoke zod schema — neither imports the other.

## Variations & alternatives

CSV/bulk import and webhook intake would be sibling intake elements, not variations of this.

## Limits

Synchronous request-response intake only; no queuing or async acknowledgement.
