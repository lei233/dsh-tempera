---
title: Order and gate the MVP vertical slices
labels:
  - wayfinder:grilling
status: open
assignee:
parent: ../map.md
blocked_by:
  - 006-freeze-coding-default-policy.md
  - 007-define-dsh-service-boundaries.md
  - 008-define-candidate-workspace-effect-contract.md
  - 009-specify-transaction-recovery-protocol.md
  - 010-design-durability-conformance-harness.md
---

## Question

Once the contracts and evidence are known, what is the final dependency-ordered sequence of independently testable vertical slices, and what concrete entry criteria, outputs, invariant tests, crash tests, and exit gate must each slice satisfy before implementation advances to the next authority layer?
