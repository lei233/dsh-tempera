---
title: Freeze the implementable Task Domain v1 schema
labels:
  - wayfinder:prototype
status: closed
assignee: codex
resolution: ../decisions/003-task-domain-v1-schema.md
parent: ../map.md
blocked_by:
  - 002-extract-qoder-bridge-lessons.md
---

## Question

What is the smallest concrete TypeScript domain schema—identities, entity records, lifecycle values, immutable descriptors, authority scopes, commands' domain inputs, and transition invariants—that faithfully implements the seven agreed entities without importing runtime, storage, DSH, Git, or Node.js concerns?

## Prototype

The interactive logic prototype is captured on branch `codex/prototype-task-domain-v1-schema` at commit `4653d5a` in `packages/domain/prototypes/task-domain-v1-schema.html`. It exercises the complete trust loop, stale Invocation fencing, exact-Candidate review binding, and indeterminate Operation reconciliation.

## Resolution

[The Task Domain v1 schema decision](../decisions/003-task-domain-v1-schema.md) freezes the provider-neutral identities, immutable descriptors, seven entity records, pure command inputs, lifecycle values, authority scopes, and transition invariants validated by the prototype. Task v1 omits persisted `suspended`; Reviews use four normalized dispositions; Operations use `prepared | dispatched | indeterminate | confirmed | aborted`; and application idempotency/CAS fields remain outside pure Domain commands.
