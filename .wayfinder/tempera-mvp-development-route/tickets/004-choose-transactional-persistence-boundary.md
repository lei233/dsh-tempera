---
title: Choose the first transactional persistence boundary
labels:
  - wayfinder:grilling
status: open
assignee:
parent: ../map.md
blocked_by:
  - 001-audit-current-dsh-capabilities.md
  - 003-freeze-task-domain-v1-schema.md
---

## Question

Which concrete local transactional backend and persistence port shape should the MVP adopt so Task-level CAS, request idempotency, authoritative current state, append-only journal writes, and restart recovery share one atomic boundary without leaking backend concerns into the Domain?
