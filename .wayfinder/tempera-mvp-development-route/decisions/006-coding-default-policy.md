# Coding-default policy snapshot and continuation decision

## Verdict

Freeze `tempera.task-policy.coding-default.v1` as one closed, finite policy contract for the single-branch coding MVP. It is interpreted by an exhaustive pure continuation function owned by Tempera. It is not an executable workflow definition and does not contain user-authored nodes, edges, expressions, callbacks, or scripts.

The human-validated logic prototype is preserved on branch `codex/wayfinder-006-coding-default-policy` at commit `4ec93d8` in `packages/domain/prototypes/coding-default-policy.html`. The user accepted the proposed model without changes.

## Frozen snapshot shape

`create-task` accepts the existing `FrozenDescriptor<"task-policy">` with exactly this value shape when its `contractVersion` is `tempera.task-policy.coding-default.v1`:

```ts
interface CodingDefaultPolicyValueV1 extends JsonObject {
  readonly profile: "coding-default";
  readonly profileRevision: 1;
  readonly limits: {
    readonly proposalInvocationsPerStage: 2;
    readonly preliminaryReviewInvocationsPerStage: 2;
    readonly repairStagesPerTask: 1;
    readonly effectDispatchesPerOperation: 2;
  };
  readonly bindings: {
    readonly targetScopeRef: ScopeRef;
    readonly proposalRealization: FrozenDescriptor<"realization-requirement">;
    readonly repairRealization: FrozenDescriptor<"realization-requirement">;
    readonly preliminaryReviewRealization: FrozenDescriptor<"realization-requirement">;
    readonly hostReviewAuthority: FrozenDescriptor<"authority-requirement">;
    readonly effectRealization: FrozenDescriptor<"realization-requirement">;
    readonly effectAuthorityAction: AuthorityAction;
  };
}
```

For the MVP compiler, `effectAuthorityAction` is the canonical semantic action `candidate.apply`. The concrete descriptor values and `targetScopeRef` are task-specific frozen bindings produced before the normalized Host command. Their complete canonical JSON participates in the policy descriptor identity, so provider, actor-authority, target, or configuration drift cannot change an active Task.

The four numeric limits are literals in v1, not caller-tunable workflow knobs. A different default requires a new policy contract version or an explicitly defined future policy kind; it cannot silently mutate `coding-default.v1`.

## Budget semantics

- The initial Invocation counts toward its Stage's Invocation limit.
- Proposal realization means both `coding.implementation` and `coding.repair` Stages. Each such Stage receives at most two Invocations: the initial generation plus at most one fenced retry generation.
- A preliminary evaluation Stage receives at most two Invocations. Host evaluation has no Invocation and therefore no Invocation retry budget; an absent external Review is durable waiting, not failure.
- `failed`, `indeterminate`, or provider-cancelled current Invocations may consume the next Invocation budget slot. A current-generation proposal rejected for invalid outcome or integrity also consumes its attempt. A stale generation is only historical evidence and never triggers another retry by itself.
- Provider reconnect or redelivery for the same durable Invocation and `launchKey` is not a new policy attempt. The recovery protocol decides whether that exact Invocation can resume; only preparing a new generation consumes another slot.
- Repair is not retry. At most one `coding.repair` Stage may be materialized for the Task. It produces a new Candidate with `derivedFromCandidateId` pointing to the Candidate whose Reviews requested change.
- An Operation may cross the dispatch boundary at most twice. An indeterminate dispatch has consumed one dispatch slot, but cannot be repeated until reconciliation proves `not-applied`. A second proved-not-applied result exhausts the unchanged Operation's budget and fails the Task.

## Stable Stage materialization

The policy can materialize only the following named Stage purposes:

| Trigger | Stage role and kind | Frozen semantic inputs | Semantic materialization-key tuple |
| --- | --- | --- | --- |
| active Task has no coding branch | `proposal / coding.implementation` | creation spec and target binding | `(policyIdentity, proposal, 0, root)` |
| exact Candidate committed | `evaluation / review.preliminary` | Candidate and preliminary realization requirement | `(policyIdentity, preliminary-review, candidateId)` |
| exact Candidate committed | `evaluation / review.host` | Candidate and Host authority requirement | `(policyIdentity, host-review, candidateId)` |
| both Reviews resolve to change and repair budget remains | `proposal / coding.repair` | prior Candidate and both exact Review refs | `(policyIdentity, repair, 1, priorCandidateId)` |
| exact Candidate becomes approved | `effect / candidate.apply` | exact Candidate, Approval, target, action, and effect requirement | `(policyIdentity, candidate-apply, candidateId, targetScopeRef)` |

The implementation may choose a canonical byte/string encoding, but these semantic tuple members are fixed. `(taskId, materializationKey)` remains unique. Re-evaluating the same continuation must find the same Stage; finding the same key with different frozen semantics is a hard invariant failure, not permission to create another Stage.

The runtime derives stable internal command identities from these keys. A continuation evaluation may commit the Stage separately from the preceding authority transition, but restart and duplicate evaluation cannot multiply it.

## Deterministic continuation rules

The interpreter is a closed exhaustive decision function over the current `TaskAggregate`, frozen policy, and durable authority facts. It applies these rules:

### Proposal and preliminary realization

1. Materialize the initial implementation Stage once.
2. Prepare one Invocation generation when the Stage has no current attempt.
3. If the current generation supplies a valid Candidate/Review proposal, accept it through the existing proposal boundary and complete the Stage.
4. If the current generation fails, becomes indeterminate, is provider-cancelled, or has an invalid/integrity-rejected proposal, prepare the next generation only when that Stage's Invocation budget remains.
5. When the Stage's budget is exhausted, fail the Stage and then fail the Task because no legal realization continuation remains.
6. Provider absence before a prepared attempt receives a terminal observation is waiting. It does not consume speculative attempts or fail the Task.

### Two-Review aggregation

Every Candidate materializes exactly one preliminary and one Host evaluation Stage. Both bind the same exact `CandidateId`; their Review evidence is immutable and cannot be substituted across Candidates.

Policy waits until both evaluation Stages have complete Reviews before aggregating dispositions. This prevents commit-arrival order from changing whether the Candidate repairs or fails. The closed precedence is:

```text
any reject        -> Task failed
else any abstain  -> Task failed (two-pass eligibility is impossible)
else any needs_changes
                  -> materialize the one repair Stage if unused
                  -> otherwise Task failed
else pass + pass  -> Candidate is eligible for Approval
```

A timeout, transport disconnect, partial submission, or executor error creates no Review. External Review waiting has no clock-driven failure in v1. Exact Host-command replay is idempotent delivery, not a second Review or policy retry.

### Approval creation

For `pass + pass`, the runtime creates exactly one immutable Approval for `(policyIdentity, candidateId)`. Its evidence is ordered canonically as `[preliminaryReviewId, hostReviewId]`, its provenance is `policy`, and it binds the Task's exact policy descriptor identity.

Approval creation is an internal authority command with a stable identity derived from `(policyIdentity, candidateId, preliminaryReviewId, hostReviewId)`. Approval is not a Stage. Re-evaluation returns the existing exact Approval; mismatched evidence under the same semantic identity is an invariant failure.

No disposition other than two passes can create Approval. A later invalidation is append-only and makes the Approval ineffective without mutating it.

## Effect authorization and dispatch

Approval materializes one `candidate.apply` effect Stage and prepares one write-ahead Operation. Its stable effect identity is the semantic tuple:

```text
(policyIdentity, candidateId, targetScopeRef, "candidate.apply")
```

Before every first dispatch or proved-not-applied redispatch, the Task Manager must verify all of the following:

- the Task is active;
- the Operation, effect Stage, exact Candidate, and exact Approval references agree;
- the Approval is effective at that dispatch boundary;
- the Candidate scope equals the policy's frozen target and both Task and effect Stage grant `candidate.apply` for it;
- Candidate artifact identity/integrity and the Operation's frozen target precondition verify;
- no other Operation represents the same unchanged effect intent;
- the same Operation has a dispatch slot remaining.

Failure of identity, scope, integrity, or precondition checks before dispatch aborts the prepared Operation and fails the Task closed. The policy does not reinterpret the Candidate, create a replacement Operation, or silently start repair.

After dispatch:

- `confirmed` records immutable confirmation evidence and completes the effect Stage;
- `not-applied` may return the same `OperationId` and `effectKey` to `prepared` only when a dispatch slot remains and Approval is still effective;
- `indeterminate` or reconciliation `unknown` remains unresolved and forbids speculative redispatch;
- Approval invalidation after dispatch does not abort or erase the Operation; reconciliation continues;
- reconciliation `confirmed` completes the effect even if the Approval became ineffective after legal dispatch;
- reconciliation `not-applied` may redispatch only if both budget and effective Approval remain, otherwise the Operation aborts or the budget fails closed.

Approval invalidation while the Operation is only `prepared` aborts it and fails the Task because v1 has no legal re-approval or amendment continuation.

## Task completion contract

The Task completes only after the exact effect Stage completes from a `confirmed` Operation. Executor success, Candidate creation, Reviews, Approval, Operation preparation, dispatch, or an indeterminate effect never completes the Task.

The completion descriptor uses `tempera.task-completion.coding-default.v1` and binds at least:

```ts
interface CodingDefaultCompletionV1 extends JsonObject {
  readonly candidateId: CandidateId;
  readonly approvalId: ApprovalId;
  readonly operationId: OperationId;
  readonly confirmation: ArtifactBinding;
}
```

All references must be the single current branch's exact chain. The Approval must have been effective when dispatch authority was exercised; it need not remain effective after dispatch if reconciliation later confirms that the already-authorized effect occurred.

Any policy terminal failure leaves no legal new Stage materialization. Waiting for the Host Review, a provider before an attempt terminates, or an indeterminate Operation is explicitly non-terminal.

## Why this is not a workflow DSL

- The serialized snapshot has one closed discriminator, six named bindings, and four fixed literal limits.
- Stage purposes and transitions live in an exhaustive versioned interpreter, not in serialized node/edge data.
- There is no arbitrary Stage list, dependency graph, condition language, dynamic next-stage name, plugin callback, or executable expression.
- Unknown fields, kinds, contract versions, or incomplete bindings fail validation.
- Changing continuation semantics requires a new contract version and explicit migration/revalidation for active Tasks; plugin/profile reload cannot change v1 meaning.

## Consequences for downstream decisions

- “Specify the authoritative transaction and recovery protocol” must give every materialization, retry generation, Review aggregation, Approval, Operation, and completion decision a stable runtime request identity and must preserve the dispatch-count facts needed to enforce the two-dispatch budget.
- “Define the exact Candidate workspace and effect contract” owns the concrete artifact, base/precondition, target, apply, confirmation, and reconciliation descriptors behind the six policy bindings; it must preserve the authorization checks fixed here.
- “Order and gate the MVP vertical slices” can treat this closed interpreter and its failure matrix as the acceptance oracle for the policy slice.
- Operational projection remains fog until the recovery protocol establishes the complete durable waiting/reconciliation facts, but the policy now distinguishes terminal failure from non-terminal waiting exactly.

## Explicitly rejected alternatives

- A serialized Stage graph or transition table: it would create the executable workflow DSL excluded from the MVP.
- Caller-configurable numeric budgets under the same v1 contract: active Tasks with nominally identical policy versions would have materially different continuation semantics.
- Short-circuiting on the first non-pass Review: arrival order could decide between repair and failure when the other Review later rejects or abstains.
- Treating Host redelivery or replacement sessions as Review retry attempts: delivery identity is not policy continuation.
- Creating a new Operation after `indeterminate`: unknown external state is not permission to repeat an authoritative effect.
- Requiring Approval to remain effective after dispatch before a confirmed effect can complete: revocation cannot prove an already-authorized effect did not occur.
- Completing directly from Approval or executor success: neither is trustworthy confirmation of the authoritative external effect.
