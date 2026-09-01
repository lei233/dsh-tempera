# Task Domain v1 schema decision

## Verdict

Freeze a provider-neutral TypeScript domain contract around exactly seven top-level durable entities:

```text
Task
Stage
Invocation
Candidate
Review
Approval
Operation
```

The contract is immutable-data-first, JSON-serializable, and independent of runtime, persistence, DSH, Git, Node.js, clocks, and identifier generation. A `TaskAggregate` is a transition boundary over those entities plus a small current authority projection; it is not an eighth entity.

The human-validated prototype is preserved on branch `codex/prototype-task-domain-v1-schema` at commit `4653d5a` in `packages/domain/prototypes/task-domain-v1-schema.html`.

## Frozen boundary choices

- Task v1 lifecycle is `active | completed | failed | cancelled`. Persisted `suspended`, `blocked`, and `waiting` are excluded.
- Review disposition is `pass | needs_changes | reject | abstain`. Execution errors, timeouts, and incomplete external submissions do not create Reviews.
- Operation lifecycle is `prepared | dispatched | indeterminate | confirmed | aborted`. Only a `prepared` Operation may be aborted because authority disappeared; a dispatched or indeterminate Operation must be reconciled.
- Pure domain command inputs do not carry `requestId` or `expectedVersion`. The application command envelope, idempotency result, payload fingerprint, and CAS protocol belong to the host command and persistence decisions.
- Domain transitions receive identifiers and immutable descriptors; generation, hashing, timestamps, serialization, and provider verification are runtime responsibilities.

## Concrete TypeScript contract

This is the v1 implementation target. Field names may be mechanically reorganized during implementation only if the serialized semantics and invariants remain identical.

```ts
export type Brand<Value, Name extends string> = Value & {
  readonly __brand: Name;
};

export type TaskId = Brand<string, "TaskId">;
export type StageId = Brand<string, "StageId">;
export type InvocationId = Brand<string, "InvocationId">;
export type CandidateId = Brand<string, "CandidateId">;
export type ReviewId = Brand<string, "ReviewId">;
export type ApprovalId = Brand<string, "ApprovalId">;
export type OperationId = Brand<string, "OperationId">;

export type DescriptorIdentity = Brand<string, "DescriptorIdentity">;
export type ArtifactRef = Brand<string, "ArtifactRef">;
export type IntegrityIdentity = Brand<string, "IntegrityIdentity">;
export type ScopeRef = Brand<string, "ScopeRef">;
export type AuthorityAction = Brand<string, "AuthorityAction">;
export type ActorRef = Brand<string, "ActorRef">;
export type LaunchKey = Brand<string, "LaunchKey">;
export type MaterializationKey = Brand<string, "MaterializationKey">;
export type EffectKey = Brand<string, "EffectKey">;

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonObject
  | readonly JsonValue[];

export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export interface FrozenDescriptor<Kind extends string = string> {
  readonly kind: Kind;
  readonly contractVersion: string;
  readonly identity: DescriptorIdentity;
  readonly value: JsonObject;
}

export interface ArtifactBinding {
  readonly ref: ArtifactRef;
  readonly integrity: IntegrityIdentity;
  readonly mediaKind?: string;
}

export interface ScopeGrant {
  readonly scopeRef: ScopeRef;
  readonly actions: readonly AuthorityAction[];
}

export interface AuthorityScope {
  readonly grants: readonly ScopeGrant[];
}

export interface TaskBase {
  readonly id: TaskId;
  readonly version: number;
  readonly creationSpec: FrozenDescriptor<"task-creation">;
  readonly policySnapshot: FrozenDescriptor<"task-policy">;
  readonly authorityScope: AuthorityScope;
}

export type Task =
  | (TaskBase & {
      readonly status: "active";
    })
  | (TaskBase & {
      readonly status: "completed";
      readonly completion: FrozenDescriptor<"task-completion">;
    })
  | (TaskBase & {
      readonly status: "failed";
      readonly failure: FrozenDescriptor<"task-failure">;
    })
  | (TaskBase & {
      readonly status: "cancelled";
      readonly cancellation: FrozenDescriptor<"task-cancellation">;
    });

export type StageRole = "work" | "proposal" | "evaluation" | "effect";

export type SemanticEntityRef =
  | { readonly type: "task"; readonly id: TaskId }
  | { readonly type: "stage"; readonly id: StageId }
  | { readonly type: "candidate"; readonly id: CandidateId }
  | { readonly type: "review"; readonly id: ReviewId }
  | { readonly type: "approval"; readonly id: ApprovalId }
  | { readonly type: "operation"; readonly id: OperationId };

export interface SemanticInput {
  readonly name: string;
  readonly value: SemanticEntityRef | FrozenDescriptor;
}

export type StageCompletion =
  | { readonly kind: "candidate"; readonly ref: CandidateId }
  | { readonly kind: "review"; readonly ref: ReviewId }
  | { readonly kind: "operation"; readonly ref: OperationId }
  | { readonly kind: "succeeded" };

export interface StageBase {
  readonly id: StageId;
  readonly taskId: TaskId;
  readonly role: StageRole;
  readonly kind: string;
  readonly contractVersion: string;
  readonly materializationKey: MaterializationKey;
  readonly semanticInputs: readonly SemanticInput[];
  readonly realizationRequirement: FrozenDescriptor<"realization-requirement">;
  readonly allowedScope: AuthorityScope;
  readonly currentExecutionGeneration: number;
}

export type Stage =
  | (StageBase & {
      readonly status: "pending" | "active";
    })
  | (StageBase & {
      readonly status: "completed";
      readonly completion: StageCompletion;
    })
  | (StageBase & {
      readonly status: "failed";
      readonly failure: FrozenDescriptor<"stage-failure">;
    })
  | (StageBase & {
      readonly status: "cancelled";
      readonly cancellation: FrozenDescriptor<"stage-cancellation">;
    });

export type InvocationStatus =
  | "prepared"
  | "launched"
  | "succeeded"
  | "failed"
  | "indeterminate"
  | "cancelled";

export type ProposalRejectionReason =
  | "stale-generation"
  | "integrity"
  | "task-state"
  | "invalid-outcome";

export type ProposalDisposition =
  | { readonly kind: "unresolved" }
  | { readonly kind: "accepted"; readonly completion: StageCompletion }
  | { readonly kind: "rejected"; readonly reason: ProposalRejectionReason };

export interface Invocation {
  readonly id: InvocationId;
  readonly taskId: TaskId;
  readonly stageId: StageId;
  readonly generation: number;
  readonly launchKey: LaunchKey;
  readonly realizerBinding: FrozenDescriptor<"realizer-binding">;
  readonly status: InvocationStatus;
  readonly proposal?: ArtifactBinding;
  readonly proposalDisposition: ProposalDisposition;
  readonly failure?: FrozenDescriptor<"invocation-failure">;
}

export interface Candidate {
  readonly id: CandidateId;
  readonly taskId: TaskId;
  readonly producedByInvocationId: InvocationId;
  readonly derivedFromCandidateId?: CandidateId;
  readonly artifact: ArtifactBinding;
  readonly scopeRef: ScopeRef;
  readonly precondition?: FrozenDescriptor<"candidate-precondition">;
}

export type ReviewDisposition =
  | "pass"
  | "needs_changes"
  | "reject"
  | "abstain";

export type ReviewProvenance =
  | { readonly kind: "invocation"; readonly invocationId: InvocationId }
  | { readonly kind: "actor"; readonly actorRef: ActorRef };

export interface Review {
  readonly id: ReviewId;
  readonly taskId: TaskId;
  readonly stageId: StageId;
  readonly candidateId: CandidateId;
  readonly authorityRequirement: FrozenDescriptor<"authority-requirement">;
  readonly disposition: ReviewDisposition;
  readonly evidence: readonly [ArtifactBinding, ...ArtifactBinding[]];
  readonly decisionProvenance: ReviewProvenance;
}

export type ApprovalProvenance =
  | {
      readonly kind: "policy";
      readonly policyIdentity: DescriptorIdentity;
    }
  | {
      readonly kind: "actor";
      readonly actorRef: ActorRef;
      readonly authorityRequirement: FrozenDescriptor<"authority-requirement">;
    };

export interface Approval {
  readonly id: ApprovalId;
  readonly taskId: TaskId;
  readonly candidateId: CandidateId;
  readonly policyIdentity: DescriptorIdentity;
  readonly evidenceReviewIds: readonly [ReviewId, ...ReviewId[]];
  readonly decisionProvenance: ApprovalProvenance;
}

export interface OperationBase {
  readonly id: OperationId;
  readonly taskId: TaskId;
  readonly stageId: StageId;
  readonly candidateId: CandidateId;
  readonly approvalId: ApprovalId;
  readonly targetScopeRef: ScopeRef;
  readonly precondition: FrozenDescriptor<"effect-precondition">;
  readonly effectKey: EffectKey;
}

export type Operation =
  | (OperationBase & {
      readonly status: "prepared" | "dispatched" | "indeterminate";
    })
  | (OperationBase & {
      readonly status: "confirmed";
      readonly confirmation: ArtifactBinding;
    })
  | (OperationBase & {
      readonly status: "aborted";
      readonly abortReason: FrozenDescriptor<"operation-abort">;
    });

export interface AuthorityProjection {
  readonly ineffectiveApprovalIds: readonly ApprovalId[];
}

export type EntityTable<Id extends string, Entity> = Readonly<
  Record<Id, Entity>
>;

export interface TaskAggregate {
  readonly task: Task;
  readonly stages: EntityTable<StageId, Stage>;
  readonly invocations: EntityTable<InvocationId, Invocation>;
  readonly candidates: EntityTable<CandidateId, Candidate>;
  readonly reviews: EntityTable<ReviewId, Review>;
  readonly approvals: EntityTable<ApprovalId, Approval>;
  readonly operations: EntityTable<OperationId, Operation>;
  readonly authority: AuthorityProjection;
}
```

## Pure domain command inputs

Commands are split into authority decisions and durable execution observations. The application layer will later wrap authority-changing commands in the idempotency/CAS envelope.

```ts
export type ProposedStageOutcome =
  | {
      readonly kind: "candidate";
      readonly candidate: Candidate;
    }
  | {
      readonly kind: "review";
      readonly review: Review;
    }
  | {
      readonly kind: "succeeded";
    };

export type AuthorityCommand =
  | {
      readonly type: "materialize-stage";
      readonly stage: Stage;
    }
  | {
      readonly type: "prepare-invocation";
      readonly invocation: Invocation;
    }
  | {
      readonly type: "accept-invocation-proposal";
      readonly invocationId: InvocationId;
      readonly outcome: ProposedStageOutcome;
    }
  | {
      readonly type: "submit-external-review";
      readonly review: Review;
    }
  | {
      readonly type: "create-approval";
      readonly approval: Approval;
    }
  | {
      readonly type: "invalidate-approval";
      readonly approvalId: ApprovalId;
      readonly reason: FrozenDescriptor<"approval-invalidation">;
    }
  | {
      readonly type: "prepare-operation";
      readonly operation: Operation;
    }
  | {
      readonly type: "dispatch-operation";
      readonly operationId: OperationId;
    }
  | {
      readonly type: "abort-operation";
      readonly operationId: OperationId;
      readonly reason: FrozenDescriptor<"operation-abort">;
    }
  | {
      readonly type: "reconcile-operation";
      readonly operationId: OperationId;
      readonly resolution:
        | { readonly kind: "confirmed"; readonly evidence: ArtifactBinding }
        | { readonly kind: "not-applied"; readonly evidence: ArtifactBinding }
        | { readonly kind: "unknown"; readonly evidence?: ArtifactBinding };
    }
  | {
      readonly type: "complete-task";
      readonly completion: FrozenDescriptor<"task-completion">;
    }
  | {
      readonly type: "fail-task";
      readonly failure: FrozenDescriptor<"task-failure">;
    }
  | {
      readonly type: "cancel-task";
      readonly cancellation: FrozenDescriptor<"task-cancellation">;
    };

export type ObservationCommand =
  | {
      readonly type: "mark-invocation-launched";
      readonly invocationId: InvocationId;
    }
  | {
      readonly type: "record-invocation-result";
      readonly invocationId: InvocationId;
      readonly result:
        | { readonly kind: "succeeded"; readonly proposal: ArtifactBinding }
        | { readonly kind: "failed"; readonly failure: FrozenDescriptor<"invocation-failure"> }
        | { readonly kind: "indeterminate" }
        | { readonly kind: "cancelled" };
    };

export type DomainCommand = AuthorityCommand | ObservationCommand;
```

`createTask(input)` is a factory rather than an aggregate command because no Task serialization point exists before creation. Its input is the complete initial `Task` in `active` status with a frozen creation spec, policy snapshot, and AuthorityScope.

## Transition invariants

1. Entity IDs and `taskId` ownership never change. All records created as Candidate, Review, or Approval evidence are immutable.
2. A terminal Task never reopens. No new Stage, authoritative outcome, Approval, or Operation may be committed after terminal transition.
3. Every authority-changing transition advances `Task.version` exactly once; execution observations do not silently obtain authority.
4. `creationSpec`, `policySnapshot`, and historical descriptors never change. New intent is append-only authority history outside these entity records.
5. A Stage's `(taskId, materializationKey)` is unique. Its semantic inputs are frozen and do not form an arbitrary scheduling DAG.
6. Every Stage grant is a subset of Task authority. Candidate and Operation scope references must be authorized by both Task and the producing/effect Stage.
7. A completed Stage has exactly one completion descriptor legal for its role. An effect Stage cannot complete until its Operation has trustworthy terminal resolution; the MVP completes it only from `confirmed`.
8. Preparing a new Invocation for a Stage advances `currentExecutionGeneration`. Only an Invocation whose generation equals the current Stage generation may commit a proposed outcome.
9. Retry is the same Stage with a new Invocation and generation. Repair is a new Stage and, if successful, a new Candidate with optional single-parent revision lineage.
10. Invocation success and proposal acceptance are separate. Acceptance atomically creates the authoritative entity, completes the Stage, makes proposal disposition terminal, appends authority history, and advances Task version.
11. Candidate identity is not its artifact integrity identity. A Candidate binds one producing Invocation, immutable artifact integrity, scope, and any precondition needed to preserve proposal meaning.
12. A Review binds exactly one Candidate and one frozen authority requirement. Provider failure, timeout, or incomplete external submission creates no Review.
13. Approval binds exactly one Candidate, the frozen policy identity, and exact Review evidence. Invalidation never mutates Approval; it appends authority history and updates the current effectiveness projection.
14. Operation is durably `prepared` before dispatch authority exists. Unchanged intent always reuses the same `OperationId` and `effectKey`.
15. A prepared Operation cannot dispatch with an ineffective Approval, mismatched Candidate, scope violation, integrity failure, or failed precondition.
16. A dispatched or indeterminate Operation cannot be aborted or speculatively retried. Reconciliation may confirm it, keep it unknown, or prove not-applied and return the same Operation to a redispatchable prepared state under policy.
17. Cancellation revokes new authority and fences live Invocation generations, but any already-dispatched Operation remains subject to reconciliation.

## Deliberate exclusions and downstream ownership

- No runtime services, storage ports, transactions, journal schema, clocks, ID generators, hashes, or provider verification APIs are part of this contract.
- No DSH, Cordis, model, subagent, Git, workspace, filesystem, URL, or Node.js types enter the domain.
- No persisted `blocked`, `waiting`, provider telemetry, arbitrary Stage DAG, `StageOutcome` entity, `ProposedOutcome` entity, `ApprovalInvalidation` entity, or `OperationAttempt` entity is introduced.
- The host command contract owns `requestId`, payload fingerprinting, `expectedVersion`, durable result replay, and queries.
- The coding-default policy decision owns the supported `task-policy` descriptor value and deterministic continuation rules.
- The persistence and recovery decisions own transaction boundaries, append-only facts, local revisions, crash scans, and exact reconciliation protocol.
- The Candidate/workspace/effect decision owns concrete artifact, precondition, target, and confirmation descriptor schemas.

## Prototype evidence

The prototype demonstrated, with visible full state after every transition:

- the complete Task → Stage → Invocation → Candidate → Review → Approval → Operation → Task completion chain;
- a late succeeded Invocation being retained as evidence but rejected by generation fencing;
- an attempted Review for a Candidate other than the one frozen into its evaluation Stage being rejected without creating Review evidence;
- an indeterminate Operation rejecting speculative redispatch and completing only after reconciliation supplies immutable confirmation evidence.
