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

export type JsonValue = null | boolean | number | string | JsonObject | readonly JsonValue[];

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

export type TaskStatus = "active" | "completed" | "failed" | "cancelled";

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

export type ActiveTask = Extract<Task, { readonly status: "active" }>;

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

export type ReviewDisposition = "pass" | "needs_changes" | "reject" | "abstain";

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

export type OperationStatus = "prepared" | "dispatched" | "indeterminate" | "confirmed" | "aborted";

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

export type EntityTable<Id extends string, Entity> = Readonly<Record<Id, Entity>>;

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
        | {
            readonly kind: "failed";
            readonly failure: FrozenDescriptor<"invocation-failure">;
          }
        | { readonly kind: "indeterminate" }
        | { readonly kind: "cancelled" };
    };

export type DomainCommand = AuthorityCommand | ObservationCommand;
