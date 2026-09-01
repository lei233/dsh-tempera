# Domain Model

This document defines the durable domain concepts and invariants that implementation must preserve.

## Task

`Task` is the durable authority owner. It owns the coarse-grained authoritative lifecycle; detailed implementation, review, repair, and effect progress belongs to Stages and projections.

A small lifecycle is preferred:

```text
active
completed
failed
cancelled
```

`completed`, `failed`, and `cancelled` are terminal and immutable. Continuing work after a terminal Task requires a new Task, optionally linked through successor lineage.

Task creation freezes enough intent for the Task to outlive the creating host session:

```text
creationSpec
policySnapshot
authorityScope
```

`creationSpec` is the immutable creation snapshot. Later changes are append-only amendments; they may supersede future authority but never rewrite the meaning of historical work.

A Task is failed only when no legal continuation remains. Temporary provider unavailability, waiting for external review, or an indeterminate external effect are not by themselves Task failure.

## Stage

`Stage` is a durable semantic work unit, not a generic workflow node.

Each Stage has stable identity and frozen semantic inputs, realization requirements, role, kind, contract version, and policy-relevant materialization identity.

Core understands these stable roles:

```text
work
proposal
evaluation
effect
```

Examples of open kinds include `coding.implementation`, `coding.repair`, `review.preliminary`, `review.host`, and `candidate.apply`.

A persisted Stage lifecycle is intentionally small:

```text
pending
active
completed
failed
cancelled
```

`blocked` and `waiting` are projections, not persisted semantic lifecycle states.

Stages do not expose an arbitrary `dependsOn: StageId[]` DAG. Dependencies are expressed through frozen semantic inputs and real prerequisites.

A Task may have multiple active Stages when frozen policy permits it. MVP restricts proposal/mutation flow to one active implementation branch while allowing evaluation work to run concurrently when policy permits.

## Invocation

`Invocation` represents one non-authoritative realization attempt for a Stage.

Before launch, the runtime durably creates the Invocation, assigns a stable `launchKey`, resolves and freezes a concrete `RealizerBinding`, and advances the Stage execution generation.

Only an Invocation whose generation equals the Stage's current execution generation may commit an outcome:

```text
invocation.generation == stage.currentExecutionGeneration
```

A replaced, delayed, duplicated, or stale executor may retain historical artifacts and completion telemetry but cannot alter authoritative state.

Suggested durable lifecycle:

```text
prepared
launched
succeeded
failed
indeterminate
cancelled
```

Provider telemetry such as queued, running, tool calls, or model streaming belongs outside the domain lifecycle.

One Invocation does not silently switch providers. A provider change requires a new Invocation.

## Candidate

A Candidate is:

> **An immutable proposed Task outcome whose identity matters to acceptance.**

Not every Stage output is a Candidate. Candidate identity is introduced where the system must answer exactly which proposal was reviewed or approved.

Conceptually a Candidate binds:

```text
CandidateId
artifactRef
integrityIdentity
producedByInvocationId
derivedFromCandidateId?
scopeRef
base/preconditionRef?
```

`CandidateId` is domain identity, not a content hash. Integrity identity answers whether the artifact is still the exact proposal.

Revision lineage uses `derivedFromCandidateId`; execution provenance uses `producedByInvocationId`. Multi-input synthesis belongs to the producing Stage's frozen inputs rather than turning Candidate into a generic provenance DAG.

## Review

A Review is immutable acceptance evidence bound to an exact Candidate.

Each complete judgment creates a new Review. Historical Reviews are never overwritten.

Core normalizes the frozen v1 disposition vocabulary:

```text
pass
needs_changes
reject
abstain
```

Detailed findings live in evidence artifacts.

DSH-based preliminary review is normally realized through an `evaluation` Stage and Invocation. Host or human review is also an `evaluation` Stage but is completed through an authorized external command rather than a fake Invocation.

The Stage freezes an authority requirement. The eventual reviewer is recorded as actor provenance. Sessions are transport context and are not authority identity.

## Approval

Approval is an immutable domain entity representing the acceptance-authority decision for an exact Candidate.

Conceptually it binds:

```text
candidateId
policySnapshot/ref
evidenceRefs
decisionProvenance
```

Review is evidence; Approval is the authority decision. Policy may allow automatic approval or require a specific external authority, but both paths produce the same durable Approval concept.

Approval itself is not a Stage. Task Manager authority transitions are not modeled as pretend work.

An Approval may later cease to be effective without mutating the Approval object. Revocation or invalidation is recorded as append-only authority history and effectiveness is projected from the original Approval plus later facts.

## Operation

`Operation` represents an authoritative external effect that requires crash-safe coordination.

It is not an Invocation and not a generic command log entry.

Before any provider is allowed to cause the effect, Tempera durably records write-ahead intent containing the exact Candidate/Approval references, target, preconditions, stable effect identity, and a prepared state.

All dispatch, retry, and reconciliation activity for one unchanged authoritative intent uses the same `OperationId` and stable `effectKey`. A new Operation is created only when the authoritative intent changes.

An indeterminate Operation must be reconciled. Unknown external state is never treated as permission to repeat the effect.

A confirmed Operation must bind immutable confirmation evidence. Normal execution and reconciliation converge on the same confirmation path.

## Artifact bindings

`ArtifactRef` is opaque to Task Core. Paths, object-store URLs, Git object details, or provider-specific locations do not become domain semantics.

Artifacts that enter the trust chain must have immutable integrity descriptors. Providers must be able to verify a locator and integrity identity before the artifact is accepted into authority.

> **ArtifactRef is a locator, not trust.**

## Authority scope

Task creation freezes a finite `AuthorityScope` or capability grant set. Stages may narrow it but never widen it:

```text
Stage.allowedScopes ⊆ Task.authorityScope
```

Candidate and Operation targets must remain inside this boundary. Core does not implement full IAM and does not need to know whether a scope denotes a repository, workspace, remote environment, API resource, or other provider-specific target.

Expanding authority requires an explicit, auditable authority change.

## Completion descriptors

There is no separate top-level `StageOutcome` entity. A terminal Stage keeps a small immutable typed completion descriptor, for example:

```text
{ kind: candidate, ref: C1 }
{ kind: review, ref: R1 }
{ kind: operation, ref: O1 }
{ kind: succeeded }
```

Candidate, Review, and Operation remain first-class entities.

An effect Stage cannot complete while its Operation remains indeterminate.

## Core invariants

Implementation must preserve at least these invariants:

- terminal Tasks never reopen;
- new intent never rewrites historical meaning;
- plugins propose outcomes but do not directly mutate Task authority;
- only the current Invocation generation may commit a Stage outcome;
- Invocation success is distinct from authoritative proposal acceptance;
- Candidate identity and Candidate integrity are separate concerns;
- Reviews are immutable evidence for exact Candidates;
- Approval is distinct from Review evidence and binds an exact Candidate;
- authoritative effects require write-ahead Operation intent;
- unknown effect state requires reconciliation, not speculative retry;
- downstream authority may be narrowed but not silently widened;
- every authority-changing command serializes through Task-level versioning.