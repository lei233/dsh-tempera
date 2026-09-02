---
title: Define the DSH-native service and plugin boundaries
labels:
  - wayfinder:grilling
status: closed
assignee: codex
resolution: ../decisions/007-dsh-service-plugin-boundaries.md
parent: ../map.md
blocked_by:
  - 001-audit-current-dsh-capabilities.md
  - 003-freeze-task-domain-v1-schema.md
  - 012-freeze-dsh-compatibility-baseline.md
---

## Question

Given the capabilities DSH actually provides, which narrow services, registries, provider contracts, and package boundaries should Tempera consume or add for realization resolution, proposal delivery, artifact verification, authoritative effects, and workspace handling while keeping all workflow authority inside the Task Manager?

## Resolution

[The DSH-native service and plugin boundaries decision](../decisions/007-dsh-service-plugin-boundaries.md) freezes one narrow `ctx.tempera` Host application service, four independent provider-neutral capability registries, deterministic frozen realizer bindings, one-shot DSH subagent adaptation, immutable proposal custody and verification, exact-intent effect isolation, lifecycle and hot-reload rules, initial direct DSH dependencies, and two scoped compatibility profiles while keeping all Task authority inside the manager.
