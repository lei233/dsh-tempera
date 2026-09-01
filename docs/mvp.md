# MVP Scope

The MVP exists to prove one complete durable coding trust loop. It is intentionally narrower than a general delegated-work platform.

## Golden path

```text
1. Host creates Task
   + immutable creationSpec
   + policySnapshot
   + AuthorityScope

2. proposal Stage
   + DSH realizer resolution
   + durable Invocation
   + fencing / retry / restart

3. immutable Candidate
   + artifact integrity
   + frozen base / precondition

4. DSH preliminary evaluation
   -> Review R1

5. external host evaluation
   -> Review R2
   host session replacement must work

6. policy eligibility
   -> immutable Approval

7. effect Stage
   -> write-ahead Operation
   -> exact Candidate apply
   -> confirmation / reconciliation

8. completion contract satisfied
   -> Task completed

9. crash / restart tests around critical windows
```

## MVP success criteria

The MVP is successful only if the system remains correct across replacement, retry, and crash ambiguity.

It must demonstrate that:

- Task semantics survive Tempera restart;
- host review authority survives session replacement;
- stale or duplicate Invocation completion cannot alter authoritative state;
- proposal delivery can be retried after a crash without duplicate authority;
- command retries are idempotent through `requestId`;
- concurrent authority changes are serialized through Task-level version/CAS;
- an apply crash cannot cause speculative duplicate authoritative effect;
- `Operation.indeterminate` is reconciled to trustworthy evidence or remains explicitly unresolved;
- Approval invalidation is handled correctly on both sides of the dispatch boundary;
- Candidate digest/integrity/base/precondition mismatches fail closed.

## Required implementation slice

The first implementation should include only enough domain and runtime surface to execute the golden path:

- Task creation with frozen durable intent, policy, and authority scope;
- Stage materialization under frozen continuation policy;
- realizer resolution and durable Invocation creation;
- generation fencing and retry;
- durable proposal delivery and authoritative acceptance;
- immutable Candidate creation;
- preliminary DSH evaluation and external host review;
- Approval creation from policy eligibility;
- effect Stage and write-ahead Operation;
- exact Candidate application through a provider seam;
- confirmation evidence and reconciliation;
- Task completion;
- restart/crash tests covering the required windows.

## Runtime restrictions

MVP policy should prefer correctness and explainability over broad concurrency.

In particular:

- allow only one active implementation/proposal branch;
- allow evaluation Stages to run concurrently when policy permits;
- do not add arbitrary workflow DAG scheduling;
- do not require every realizer to support reconnect or exactly-once launch;
- use Invocation fencing as the correctness mechanism;
- do not guess-retry indeterminate Operations.

## Explicit non-goals

The MVP does not include:

- autonomous DSH planning;
- a Web Task Board;
- distributed multi-manager semantics;
- broad multi-project UX;
- runtime competition between multiple implementation branches;
- a generic deploy/publish effect ecosystem;
- a generic agent runtime;
- arbitrary workflow scripting;
- provider-specific APIs in Task Core.

## Architecture archaeology

Implementation may inspect `qoder-agent-bridge` selectively for proven semantics around:

- Task Core transition/invariant style;
- Invocation lineage;
- Candidate identity and immutability;
- retry versus repair;
- exact Candidate apply;
- fail-closed behavior;
- known durability gaps such as request idempotency, fencing, write-ahead effects, reconciliation, and project/security boundaries.

The goal is to reuse semantics, not to port Qoder/Codex/worktree interfaces into Tempera.

## Definition of done

The MVP is not done when a happy-path agent can produce a patch. It is done when the complete chain from delegated execution to trusted acceptance and authoritative application remains explainable and fail-closed under the required failure scenarios.

The strongest acceptance test is:

> **Executor/realizer can produce a proposal; only Task Manager can make it authoritative.**

The strongest effect test is:

> **Unknown external state is not permission to repeat an authoritative effect.**