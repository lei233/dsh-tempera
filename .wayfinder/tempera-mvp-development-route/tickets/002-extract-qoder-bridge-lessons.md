---
title: Extract durable-task lessons from qoder-agent-bridge
labels:
  - wayfinder:research
status: closed
assignee: audit_qoder_bridge
resolution: ../research/002-qoder-agent-bridge-archaeology.md
parent: ../map.md
blocked_by: []
---

## Question

Which concrete invariants, transition patterns, failure cases, and test techniques from `qoder-agent-bridge` should Tempera preserve for Candidate identity, retry versus repair, exact apply, fail-closed behavior, and Task Core concurrency, and which Qoder/Codex/worktree-specific interfaces must explicitly not be carried forward?

## Resolution

[The source archaeology](../research/002-qoder-agent-bridge-archaeology.md) preserves exact-Candidate identity, immutable history, explicit retry/repair separation, preconditioned exact apply, and evidence-backed fail-closed behavior while rejecting Qoder/Codex/worktree plumbing and the prototype's file-lock concurrency model. Tempera must add caller request idempotency, Task CAS, Invocation fencing, write-ahead Operation state, and reconciliation rather than treating the bridge's Embedded Host as the durable target.
