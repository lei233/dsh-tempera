---
title: Audit current DSH capabilities against Tempera's MVP seams
labels:
  - wayfinder:research
status: closed
assignee: audit_dsh_capabilities
parent: ../map.md
blocked_by: []
resolution: ../research/001-dsh-capability-audit.md
---

## Question

Which current DeepSeek Harness APIs and guarantees can Tempera reuse for Cordis composition, durable storage, jobs/execution, subagents, artifacts, sandbox/workspace handling, and provider lifecycle, and which required MVP semantics remain genuine gaps that must be supplied by Tempera-oriented DSH-native services or plugins?

## Resolution

Reuse DSH as the Cordis composition and execution kernel: its plugin lifecycle, named subagent transports, live job observation, fail-closed file sandbox, canonical workspace identity, and single-call durable KV primitives are useful foundations. They do not provide Tempera's multi-record authority transaction, frozen RealizerBinding, Invocation fencing/proposal durability, immutable artifact verification, Git Candidate exact-apply, or write-ahead effect reconciliation, so those remain Tempera-owned persistence and DSH-native service/provider seams. See [the current DSH capability audit](../research/001-dsh-capability-audit.md).
