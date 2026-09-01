---
title: Choose the first transactional persistence boundary
labels:
  - wayfinder:grilling
status: closed
assignee: codex
resolution: ../decisions/004-transactional-persistence-boundary.md
parent: ../map.md
blocked_by:
  - 001-audit-current-dsh-capabilities.md
  - 003-freeze-task-domain-v1-schema.md
---

## Question

Which concrete local transactional backend and persistence port shape should the MVP adopt so Task-level CAS, request idempotency, authoritative current state, append-only journal writes, and restart recovery share one atomic boundary without leaking backend concerns into the Domain?

## Resolution

[The transactional persistence boundary decision](../decisions/004-transactional-persistence-boundary.md) selects a Tempera-owned `better-sqlite3` authority store with exclusive single-manager ownership, a Task-snapshot plus journal/receipt hybrid layout, and an `AuthorityStore`-owned pure decision transaction. Task-version commits atomically bind the next snapshot, one ordered journal batch, and the deterministic command receipt; deterministic no-write outcomes retain receipts without advancing authority, while runtime-owned versioned codecs keep persistence concerns out of the Domain.
