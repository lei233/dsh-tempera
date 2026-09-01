---
title: Specify the authoritative transaction and recovery protocol
labels:
  - wayfinder:prototype
status: open
assignee:
parent: ../map.md
blocked_by:
  - 003-freeze-task-domain-v1-schema.md
  - 004-choose-transactional-persistence-boundary.md
  - 005-fix-host-command-query-contract.md
  - 006-freeze-coding-default-policy.md
---

## Question

What exact runtime protocol, transaction boundaries, durable records, state scans, and legal recovery actions implement request idempotency, Task CAS, Invocation preparation and fencing, unresolved proposal replay, write-ahead Operation intent, Approval invalidation, cancellation, and reconciliation across every MVP crash window?
