# Durability and Recovery

Tempera is durable only if crashes, retries, duplicate delivery, session replacement, provider changes, and ambiguous external effects cannot accidentally acquire authority.

This document defines the correctness mechanisms behind that property.

## Command idempotency

Every authority-changing command carries:

```text
requestId
expectedVersion
```

`requestId` is caller-supplied immutable command identity.

Rules:

- same `requestId` + same payload returns the original durable result;
- same `requestId` + different payload is a hard error;
- a different `requestId` is a new command whose legality is determined by domain invariants.

Tempera never guesses command identity from business fields.

## Task-level serialization

`Task.version` is the logical clock and serialization point for authoritative decision history.

Commands that change the authority graph validate `expectedVersion`, including:

- cancelling a Task;
- materializing continuation Stages;
- accepting an Invocation outcome;
- creating or invalidating Approval;
- beginning an authoritative Operation;
- completing a Task.

Stage- or Operation-local revision counters may exist, but they do not replace Task-level CAS for authority-changing decisions.

## Authoritative transaction

Tempera stores authoritative current state plus an append-only authority journal. It does not require event replay to reconstruct current state.

Every authority-changing commit is atomic:

```text
validate Task.version
validate domain invariants
mutate authoritative state
append authority journal entry
advance Task.version
record request result/idempotency outcome
```

The journal supports audit, reconciliation, authority-history projection, debugging, and Approval-effectiveness reasoning.

## Invocation preparation and fencing

An Invocation must exist durably before launch and receives a stable `launchKey`.

Creating a new executable Invocation advances the Stage execution generation. Only the current generation may commit an outcome.

```text
Stage.currentExecutionGeneration++

commit allowed iff
invocation.generation == stage.currentExecutionGeneration
```

Reattachment or reconnect support may improve continuity, but correctness does not depend on reconnect. If an Invocation becomes indeterminate, the runtime may fence it and create a new Invocation when policy permits.

Provider replacement is therefore safe because the old provider cannot later regain authority through delayed completion.

## Durable proposal boundary

An executor does not directly mutate Task state. It produces a constrained proposed outcome backed by a durable immutable `proposalRef`.

Conceptually:

```text
DSH realizer
  -> durable proposalRef
  -> Task Manager validation
  -> authoritative transaction
```

Invocation also records proposal disposition, for example:

```text
accepted(...)
rejected(stale-generation)
rejected(integrity)
rejected(task-state)
unresolved
```

Exact field names remain open.

Proposal acceptance atomically creates the authoritative object, completes the Stage, records proposal disposition, appends authority history, and advances Task version. If that transaction does not commit, the proposal stays unresolved and may be safely revalidated after restart.

> **Execution can succeed without obtaining authority.**

## Artifact preparation versus authority

Blob or artifact preparation may occur outside the authoritative transaction.

Once an artifact enters the trust chain, the authoritative commit verifies its immutable integrity binding. If upload succeeds but the database transaction fails, only an unreferenced artifact remains; no half-created Candidate or Review exists.

```text
prepare immutable artifact
  -> proposed outcome
  -> single authoritative commit
       verify generation/version/integrity
       create Candidate/Review/...
       complete Stage
       record disposition
       append journal
       advance Task.version
```

Unreferenced prepared artifacts may later be garbage-collected.

## Operation write-ahead intent

Authoritative external effects require a stronger protocol than ordinary Invocation execution.

Before external machinery receives permission to cause the effect, Tempera durably creates the Operation with the exact authoritative intent:

```text
Operation
  exact Candidate / Approval refs
  target and frozen preconditions
  stable effectKey
  state = prepared
```

All retries, dispatch attempts, and reconciliation for unchanged intent keep the same `OperationId` and `effectKey`.

A new Operation is valid only when authoritative intent itself changes.

> **The Task Manager must durably know which authoritative effect it intends to cause before external machinery gets permission to cause it.**

## Reconciliation

An Operation may become indeterminate when the provider could have caused the effect but Tempera did not durably observe a trustworthy terminal result.

The legal responses are:

```text
confirmed applied
  -> record immutable confirmation evidence
  -> Operation confirmed

confirmed not applied
  -> policy may permit safe redispatch of same Operation

still unknown
  -> remain indeterminate
  -> continue reconciliation
```

Unknown external state never authorizes speculative repetition.

Normal dispatch completion and recovery-time reconciliation must converge on the same confirmation-evidence path.

## Critical crash windows

| Crash / race window | Durable fact available | Recovery behavior | Forbidden behavior |
| --- | --- | --- | --- |
| after Invocation record, before launch | prepared Invocation + launchKey | resume launch or safely supersede according to provider capability/policy | creating an unrelated authoritative result |
| executor finishes, proposal delivery crashes | immutable proposal may exist; disposition unresolved | redeliver/revalidate proposal | assuming executor success was committed |
| stale/duplicate Invocation completion | generation and prior disposition | reject or return durable prior result | allowing stale generation to change Stage |
| authority transaction conflicts | Task version + requestId | retry command with fresh state or return conflict | silently overwriting concurrent authority |
| artifact upload succeeds, authority commit fails | unreferenced immutable artifact | revalidate proposal or GC artifact | exposing half-authoritative Candidate |
| Operation prepared, before dispatch | write-ahead intent | validate current Approval/preconditions, then dispatch or abort | dispatch after authority was revoked |
| dispatch occurs, process crashes before recording outcome | same Operation + effectKey, state unresolved/indeterminate | reconcile provider/external target | create a new Operation and guess-retry |
| Approval revoked after dispatch | dispatched Operation + authority history | continue reconciliation | claiming effect did not occur |
| target/base changed before exact apply | frozen Candidate integrity/base + current target state | fail closed / conflict | reinterpret or apply against a different base |
| host session replaced during review | durable evaluation Stage + authority requirement | accept submission from a newly authorized session/actor | binding authority to the vanished session |

## Restart rules

Restart must not require replaying the complete journal to regain correctness. Current authoritative state contains enough information to continue, while the journal explains how that state was reached.

After restart the runtime should identify, at minimum:

- active Stages needing realization or external authority;
- prepared/launched/indeterminate Invocations requiring reconnect, fencing, or retry decisions;
- unresolved proposals eligible for deterministic revalidation;
- prepared/dispatched/indeterminate Operations requiring validation or reconciliation;
- pending materialization decisions protected by stable keys and Task versioning.

## Durability invariant

> **Durable semantics must not silently drift with session replacement, process restart, plugin upgrade, provider change, or policy configuration change.**