---
title: Design the durability conformance harness
labels:
  - wayfinder:prototype
status: open
assignee:
parent: ../map.md
blocked_by:
  - 008-define-candidate-workspace-effect-contract.md
  - 009-specify-transaction-recovery-protocol.md
---

## Question

How should deterministic fault injection, transaction races, process restart tests, fake provider controls, and real Git/workspace end-to-end tests be combined into an executable conformance suite that proves every failure window in `docs/mvp.md` without relying on timing luck?
