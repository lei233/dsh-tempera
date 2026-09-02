---
title: Chart the executable route to the Tempera coding MVP
labels:
  - wayfinder:map
status: open
---

## Destination

Produce an execution-ready, dependency-ordered development route from the current engineering skeleton to the real end-to-end Tempera coding MVP, with milestone acceptance gates and every implementation-blocking decision given an explicit owner.

The map plans the work; it does not implement the product.

## Notes

- Domain: a DSH-native durable Task Manager for delegated coding work.
- Standing architecture: Task Domain is the product core; DSH is the Harness kernel; execution authority is separate from acceptance authority.
- Delivery choices fixed while charting: thin vertical slices; real transactional persistence from the first authority-changing command; TypeScript command/query API plus a thin DSH adapter; real DSH composition and real Git/workspace providers are part of the MVP; minimal DSH-native providers/plugins may live in this repository behind independent package boundaries.
- Every slice must preserve fail-closed semantics and add its failure/race acceptance tests before the next authority layer is introduced.
- Consult `grilling` and `domain-modeling` for HITL decisions, `prototype` when a concrete contract draft is needed, and `research` for source-driven capability or archaeology questions.
- Ticket-type preference: resolve decisions through `grilling` or `research` whenever possible. Do not create a `prototype` ticket unless the decision genuinely depends on an interactive or concrete artifact; before creating one, pause and obtain the user's explicit approval.
- Primary local context: `docs/architecture.md`, `docs/domain.md`, `docs/lifecycle.md`, `docs/durability.md`, `docs/capability-seams.md`, `docs/mvp.md`, and `.handoff/handoff-dsh-tempera-architecture.md`.
- High-level architecture is settled. Do not reopen it merely to choose field names, package names, or adapter mechanics.

## Decisions so far

<!-- Closed ticket decisions are indexed here by name. -->

- [Audit current DSH capabilities against Tempera's MVP seams](tickets/001-audit-current-dsh-capabilities.md): reuse DSH for Cordis composition and execution, while Tempera owns the authority transaction and adds narrow realizer, artifact, Git/workspace, and effect-reconciliation seams.
- [Extract durable-task lessons from qoder-agent-bridge](tickets/002-extract-qoder-bridge-lessons.md): preserve exact-Candidate identity, immutable history, retry/repair separation, exact apply, and fail-closed tests, but replace provider-specific APIs and file-lock coordination with idempotency, Task CAS, fencing, write-ahead Operations, and reconciliation.
- [Freeze the implementable Task Domain v1 schema](tickets/003-freeze-task-domain-v1-schema.md): freeze seven provider-neutral immutable entities, a four-value Task lifecycle and Review disposition, five-state Operation coordination, scoped pure Domain commands, generation fencing, and exact-Candidate authority invariants.
- [Choose the first transactional persistence boundary](tickets/004-choose-transactional-persistence-boundary.md): use an exclusively owned `better-sqlite3` authority store whose pure decision transaction atomically binds versioned Task snapshots, ordered authority commits, and durable idempotency receipts behind a runtime port.
- [Fix the MVP host command and query contract](tickets/005-fix-host-command-query-contract.md): expose four named Host commands over manager-wide idempotency and Task CAS, keep runtime authority transitions internal, and provide three read-only version-reporting queries without a generic Domain-command escape hatch.
- [Freeze the coding-default policy snapshot and continuation rules](tickets/006-freeze-coding-default-policy.md): use one closed versioned interpreter with fixed retry/repair/effect budgets, order-independent exact-Candidate two-Review eligibility, stable continuations, fail-closed apply authority, and completion only from a confirmed Operation.
- [Specify the authoritative transaction and recovery protocol](tickets/009-specify-transaction-recovery-protocol.md): separate authority and snapshot clocks, persist provider grants before calls, recover from current snapshots through stable receipts and fencing, and reconcile crossed Operations without speculative redispatch or terminal Task reopening.
- [Freeze the DSH compatibility baseline](tickets/012-freeze-dsh-compatibility-baseline.md): pin DSH `0.1.2-alpha.3` to its reviewed release commit, enforce aligned exact packages and scoped compile/behavior profiles, and require evidence plus human approval for every developer-preview upgrade.

## Not yet specified

- The concrete first realizer/provider composition used by the golden path. This becomes specifiable after current DSH capabilities and DSH-native service boundaries are known.
- The exact repository/package layout for adapters, plugins, fixtures, and conformance tests. This becomes specifiable after their contracts and reuse boundaries are decided.

## Out of scope

- Autonomous DSH planning, Web Task Board, broad multi-project UX, remote/distributed multi-manager operation, runtime-competing implementation branches, and a generic deploy/publish effect ecosystem are beyond the coding MVP.
- A generic workflow DSL, arbitrary DAG scheduling, a generic agent runtime, full IAM, and full Event Sourcing are architectural non-goals.
- Full amendment taxonomy, general policy migration, successor-Task APIs, and a persisted `suspended` lifecycle are not MVP deliverables unless a golden-path invariant proves one is required; the implementation must only avoid foreclosing their later addition.
- Publication, deployment, and a stable public package release are not part of this planning destination.
