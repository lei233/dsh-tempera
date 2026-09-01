# DSH Capability Seams

Tempera defines durable Task semantics. It should not hard-code concrete Harness machinery such as LLM providers, subagent implementations, sandboxes, subprocesses, Git/worktrees, or specific coding agents.

> **Tempera specifies what realization is required; DSH composition resolves how it is provided.**

If a required Harness capability is missing, the preferred extension point is a DSH-native plugin, service, or provider rather than Task Core.

## Realizer resolution

A Stage freezes semantic requirements. At Invocation creation time, DSH composition resolves those requirements to a concrete binding.

Conceptually:

```text
ctx.temperaRealizers.resolve(requirement)
  -> RealizerBinding
```

Exact Cordis service names and TypeScript interfaces remain open implementation details.

A Realizer binding should capture enough provenance and capability information to explain how an Invocation was executed without making provider implementation details part of the Stage's durable semantics.

The runtime needs only a narrow contract around:

- resolve;
- start;
- optional reconnect/reattach;
- proposal delivery;
- best-effort cancel;
- execution provenance.

Providers may support different capability levels such as basic start, reconnectable execution, or idempotent launch. Correctness relies on fencing, not on every provider supporting reconnect or exactly-once launch.

## Artifact integrity capability

Task Core treats `ArtifactRef` as opaque. A DSH-native artifact capability should provide immutable bindings and verification for artifacts that enter the authority chain.

Conceptually:

```text
ArtifactBinding
  ref
  integrityIdentity
  optional media/schema kind

verify(ref, integrityIdentity)
```

Candidate artifacts, Review evidence, durable proposals, and Operation confirmation evidence all need trustworthy immutable identity when policy relies on them.

Storage location and implementation remain provider concerns.

## Authoritative effect capability

Effects require a stronger provider contract than ordinary Stage realization because external mutation may become ambiguous across crashes.

An effect provider needs semantics for at least:

- stable effect identity;
- write-ahead-compatible dispatch;
- reconciliation;
- immutable confirmation evidence;
- retry-safety semantics.

Conceptually:

```text
effect Stage
  -> Operation prepared by Tempera
  -> EffectProvider dispatch
  -> confirmation or indeterminate
  -> EffectProvider reconcile when required
```

The provider does not decide whether an Operation is legally authorized. Tempera validates effective Approval, exact Candidate identity, scope, and preconditions before granting dispatch authority.

## Workspace / Candidate provider seam

Coding workflows need a provider capable of preparing immutable Candidate artifacts and applying an exact approved Candidate against a frozen base/precondition.

This capability may internally use Git, worktrees, filesystem snapshots, remote workspaces, patches, or another mechanism. Those choices must not leak into Task Core contracts.

The semantic requirements are:

- produce a Candidate with immutable integrity identity;
- bind any base/precondition needed to preserve proposal meaning;
- verify the target still satisfies apply preconditions;
- fail closed on drift;
- expose effect confirmation suitable for Operation resolution.

## Ownership matrix

| Concern | Tempera domain | Tempera runtime | DSH / plugin / provider |
| --- | --- | --- | --- |
| Task identity and lifecycle | owns semantics | coordinates commands | no authority |
| Stage semantics | owns roles/invariants | materializes under policy | realizes requirement |
| continuation policy | frozen domain semantics | evaluates/materializes | may report capability only |
| Invocation fencing | invariant | persists/enforces | supplies execution result |
| Candidate identity | domain entity | validates/commits | prepares artifact/proposal |
| Review semantics | domain entity | validates authority/evidence | may perform evaluation |
| Approval | authority entity | creates under policy/command | no implicit acceptance power |
| artifact storage | opaque ref only | coordinates verification | owns storage/verification mechanism |
| LLM / subagent execution | none | resolver client | owns implementation |
| Git / worktree / workspace | none | coordinates semantic provider | owns implementation |
| Operation intent | domain authority | write-ahead + reconciliation | dispatches/reconciles effect |
| Task authority scope | owns invariant | validates | may interpret concrete ScopeRef |

## Reusing DSH versus adding a plugin

Existing DSH primitives should be reused when they already satisfy the semantic contract. Likely reusable capability areas include LLM access, subagents, agent loops, tools, jobs, storage domains, sandboxing, subprocesses, sessions, and plugin composition.

A new DSH-native extension is appropriate when Tempera needs semantics that existing primitives do not guarantee, particularly:

- realization requirement resolution with frozen provenance;
- immutable artifact integrity verification;
- crash-safe authoritative effect dispatch and reconciliation;
- exact Candidate/workspace preparation and application.

These extensions do not automatically belong in DSH core. They may remain out-of-tree Tempera-oriented plugins or services unless later evidence shows that the abstraction is broadly useful to DSH consumers.

> **DSH-native does not mean DSH-core.**

## What must not enter Task Core

Task Core must not acquire dependencies on or assumptions about:

- `ctx.subagents` or a particular subagent implementation;
- `ctx.llm` or model/provider APIs;
- DSH jobs telemetry;
- sandbox/process implementation;
- Claude Code, Qoder, Codex, Pi, or other concrete agents;
- Git repositories, patches, branches, or worktree APIs;
- SQLite or another persistence backend;
- host session identity as durable authority identity.

The public domain interfaces should be shaped by Task semantics, not by whichever provider is implemented first.