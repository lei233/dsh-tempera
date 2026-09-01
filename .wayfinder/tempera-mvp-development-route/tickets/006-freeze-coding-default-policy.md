---
title: Freeze the coding-default policy snapshot and continuation rules
labels:
  - wayfinder:prototype
status: closed
assignee: codex
resolution: ../decisions/006-coding-default-policy.md
parent: ../map.md
blocked_by:
  - 003-freeze-task-domain-v1-schema.md
  - 005-fix-host-command-query-contract.md
---

## Question

What finite, versioned `coding-default` policy snapshot and deterministic continuation rules are sufficient for the single-branch MVP, including retry budgets, two-review eligibility, Approval creation, stable Stage materialization, effect authorization, and Task completion, without becoming an executable workflow DSL?

## Prototype

The user-validated logic prototype is captured on branch `codex/wayfinder-006-coding-default-policy` at commit `4ec93d8` in `packages/domain/prototypes/coding-default-policy.html`. It exercises the happy path, Invocation retry and budget exhaustion, one repair round, order-independent two-Review aggregation, exact Approval/effect binding, proved-not-applied redispatch, indeterminate reconciliation, and Approval invalidation on both sides of dispatch.

## Resolution

[The coding-default policy snapshot and continuation decision](../decisions/006-coding-default-policy.md) freezes one closed `tempera.task-policy.coding-default.v1` interpreter with literal 2/2 Invocation budgets, one repair Stage, two dispatches of the same Operation, two exact-Candidate pass Reviews for Approval, stable semantic materialization keys, fail-closed effect authorization, and completion only from confirmed exact apply. The serialized snapshot contains named frozen bindings and fixed limits rather than a workflow graph or executable rules.
