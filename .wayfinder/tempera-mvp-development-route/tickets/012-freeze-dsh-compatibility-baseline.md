---
title: Freeze the DSH compatibility baseline
labels:
  - wayfinder:grilling
status: closed
assignee: codex
resolution: ../decisions/012-dsh-compatibility-baseline.md
parent: ../map.md
blocked_by:
  - 001-audit-current-dsh-capabilities.md
---

## Question

Which exact DSH release or commit will the MVP target, how will Tempera express that dependency, what compile-time and behavioral adapter tests define compatibility, and what explicit review/revalidation procedure is required before an active development line adopts a newer developer-preview build?

## Resolution

[The DSH compatibility baseline decision](../decisions/012-dsh-compatibility-baseline.md) freezes official release `dsh-v0.1.2-alpha.3` at source commit `dd6322d604e00eec1ba5e0c8541159906a21094a`, exact aligned npm dependencies and lockfile verification, public consumer compile fixtures, deterministic real-framework tests, provider-specific conformance profiles, and a human-approved atomic revalidation gate before a newer developer-preview build becomes active.
