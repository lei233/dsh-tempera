# Architecture

Tempera is a durable Task Manager for delegated work. DeepSeek Harness (DSH) is its pluggable Harness kernel.

> **Task Domain is the product core; DSH is the Harness kernel.**
>
> **Tempera owns the lifecycle of work, not the machinery that performs it.**
>
> **Execution authority does not imply acceptance authority.**

This document is the architectural map. The detailed contracts live in:

- [Domain model](./domain.md)
- [Lifecycle and continuation](./lifecycle.md)
- [Durability and recovery](./durability.md)
- [DSH capability seams](./capability-seams.md)
- [MVP scope](./mvp.md)

## System boundary

```text
Host / external authority
        |
        v
+---------------------------+
| Tempera Task Manager      |
|---------------------------|
| Domain semantics          |
| authority transitions     |
| policy / continuation     |
| durability / reconciliation|
+---------------------------+
        |
        | realization requirements
        v
+---------------------------+
| DSH-native seams          |
|---------------------------|
| realizer resolution       |
| artifact verification     |
| effect providers          |
| workspace providers       |
+---------------------------+
        |
        v
DSH primitives / concrete providers
```

Tempera decides what work is legal, what evidence is acceptable, and when an authoritative transition may occur. DSH and its plugins decide how a semantic requirement is realized.

The classification test for new functionality is:

> **Is this Task semantics, or is it a Harness capability?**

Task semantics belong in Tempera. Harness capabilities should reuse DSH or be supplied by a DSH-native plugin, service, or provider.

## Package direction

The intended dependency direction is:

```text
@dsh-tempera/runtime -> @dsh-tempera/domain
```

The domain package must remain independent of DSH, concrete providers, persistence backends, Git/worktree APIs, subprocesses, LLM APIs, and Node.js globals.

The runtime coordinates persistence, commands, policy evaluation, realization, recovery, and effect execution around the domain model. It must not turn provider behavior into authority.

## Core domain entities

Tempera uses seven top-level durable domain entities:

```text
Task
Stage
Invocation
Candidate
Review
Approval
Operation
```

Other useful durable records may exist as descriptors, snapshots, amendments, proposal references, or journal facts, but are not promoted to top-level domain entities merely because they are persisted.

## Durable trust loop

The coding MVP proves one complete trust loop:

```text
Task
  |
  v
proposal Stage
  |
  v
Invocation -- produces --> proposed outcome
  |                          |
  +--------------------------+
              |
              v
          Candidate
              |
              v
       evaluation Stages
          /       \
         v         v
     Review R1  Review R2
          \       /
           v     v
           Approval
              |
              v
          effect Stage
              |
              v
          Operation
              |
       confirmation/reconcile
              |
              v
        Task completion
```

The executor can produce a proposal. Only the Task Manager can make it authoritative.

## Authority layers

Tempera deliberately separates three kinds of authority:

1. **Execution authority** — permission to attempt realization of a Stage.
2. **Acceptance authority** — permission to accept an exact Candidate under policy.
3. **Effect authority** — permission to cause an authoritative external effect.

A successful executor run is therefore not equivalent to an accepted proposal, and accepted evidence is not automatically equivalent to Approval.

## Stage roles

Core understands only a small stable role taxonomy:

```text
work
proposal
evaluation
effect
```

`Stage.kind` remains an open namespace and is bound to a frozen semantic contract version. Core reasons about stable roles and frozen semantics, not arbitrary workflow-node types.

Stages model semantic work units and semantic prerequisites. Tempera is not a generic DAG engine.

## Policy authority

Profiles and plugin configuration are compiled at Task creation into a durable `TaskPolicySnapshot`. It captures semantics that affect authority and lifecycle, such as continuation rules, review requirements, retry budgets, completion requirements, and concurrency constraints.

Active Tasks must not silently change meaning because a profile, plugin, provider, or process changed. A policy change that affects existing work requires explicit migration or revalidation.

## Persistence model

Tempera uses:

```text
authoritative current state
+
transactional append-only authority journal
```

It does not require full Event Sourcing. Every authority-changing commit validates Task-level concurrency, mutates authoritative state, appends authority history, and advances the Task version in one transaction.

## Fail-closed principles

The architecture is designed so ambiguous or stale execution cannot accidentally acquire authority.

Key invariants include:

- only the current Invocation execution generation may commit an outcome for a Stage;
- Approval is bound to an exact Candidate;
- Candidate integrity and frozen base/preconditions are verified before authoritative application;
- a Task or Stage cannot silently expand its authority scope;
- unknown external effect state is not permission to repeat an effect;
- cancellation revokes authority but does not prove an executor stopped;
- terminal Task states are immutable.

## Non-goals

Tempera is not intended to be:

- a generic agent runtime;
- an Airflow-style workflow scripting or arbitrary DAG engine;
- a home for provider-specific LLM, Git, worktree, sandbox, subprocess, or session APIs;
- an exactly-once execution framework;
- a system where executor completion directly completes a Task.

The MVP also excludes autonomous planning, a Web Task Board, distributed multi-manager coordination, broad multi-project UX, competing implementation branches, and a generic deploy/publish effect ecosystem.

## Architecture status

These documents establish the implementation baseline. Exact TypeScript field names, database layout, serialized policy shape, final review disposition enum, Cordis service names, capability-level schemas, and package/file naming remain implementation decisions unless and until they become durable semantic contracts.