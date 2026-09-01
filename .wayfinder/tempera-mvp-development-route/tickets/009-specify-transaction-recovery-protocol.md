---
title: Specify the authoritative transaction and recovery protocol
labels:
  - wayfinder:prototype
status: closed
assignee: codex
resolution: ../decisions/009-transaction-recovery-protocol.md
parent: ../map.md
blocked_by:
  - 003-freeze-task-domain-v1-schema.md
  - 004-choose-transactional-persistence-boundary.md
  - 005-fix-host-command-query-contract.md
  - 006-freeze-coding-default-policy.md
---

## Question

What exact runtime protocol, transaction boundaries, durable records, state scans, and legal recovery actions implement request idempotency, Task CAS, Invocation preparation and fencing, unresolved proposal replay, write-ahead Operation intent, Approval invalidation, cancellation, and reconciliation across every MVP crash window?

## Resolution comment

Freeze the [authoritative transaction and recovery protocol](../decisions/009-transaction-recovery-protocol.md): separate authority and snapshot revisions, coordinate every mutation through durable receipts, persist provider grants before calls, consume effect budget at the dispatch grant, derive restart work from current snapshots, and reconcile crossed Operations even after authority revocation or cancellation without reopening terminal Tasks.

The user validated the linked choices without changes using the throwaway logic prototype on branch `codex/prototype-transaction-recovery-protocol` at commit `e05169c` in `packages/runtime/prototypes/transaction-recovery-protocol.html`.
