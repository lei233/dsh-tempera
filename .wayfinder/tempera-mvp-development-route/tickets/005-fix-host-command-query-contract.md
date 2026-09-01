---
title: Fix the MVP host command and query contract
labels:
  - wayfinder:prototype
status: closed
assignee: codex
resolution: ../decisions/005-host-command-query-contract.md
parent: ../map.md
blocked_by:
  - 003-freeze-task-domain-v1-schema.md
---

## Question

What is the minimal semantic command/query application contract that lets a Host create and inspect Tasks, submit external review, drive permitted authority decisions, request cancellation or reconciliation, and safely retry every authority-changing command using `requestId` and `expectedVersion`?

## Prototype

The user-validated logic prototype is captured on branch `codex/prototype-host-command-query-contract` at commit `3ed90c4` in `packages/runtime/prototypes/host-command-query-contract.html`. It exercises exact request replay, request-identity mismatch, Task CAS conflict, Host session replacement, cancellation, read-only queries, and indeterminate Operation reconciliation.

## Resolution

[The MVP Host command and query contract decision](../decisions/005-host-command-query-contract.md) freezes four named Host commands—Task creation, external Review submission, cancellation, and reconciliation wake-up—over one manager-wide idempotency/CAS envelope, while keeping continuation, Approval, provider results, effects, and completion behind a separately typed internal runtime gateway. It also fixes three read-only, version-reporting queries and rejects a generic Domain-command passthrough.
