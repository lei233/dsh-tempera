---
title: Fix the MVP host command and query contract
labels:
  - wayfinder:prototype
status: open
assignee:
parent: ../map.md
blocked_by:
  - 003-freeze-task-domain-v1-schema.md
---

## Question

What is the minimal semantic command/query application contract that lets a Host create and inspect Tasks, submit external review, drive permitted authority decisions, request cancellation or reconciliation, and safely retry every authority-changing command using `requestId` and `expectedVersion`?
