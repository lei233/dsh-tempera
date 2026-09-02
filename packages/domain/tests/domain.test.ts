import { describe, expect, it } from "vitest";
import { applyDomainCommand, createTask } from "../src/index";
import type { DomainResult } from "../src/result";
import type {
  ActiveTask,
  Approval,
  ApprovalId,
  ArtifactBinding,
  ArtifactRef,
  AuthorityAction,
  AuthorityScope,
  Candidate,
  CandidateId,
  DomainCommand,
  EffectKey,
  FrozenDescriptor,
  IntegrityIdentity,
  Invocation,
  InvocationId,
  JsonObject,
  LaunchKey,
  MaterializationKey,
  Operation,
  OperationId,
  Review,
  ReviewId,
  ScopeRef,
  Stage,
  StageId,
  TaskAggregate,
  TaskId,
} from "../src/types";

const taskId = "T1" as TaskId;
const stageId = (n: number): StageId => `S${n}` as StageId;
const invocationId = (n: number): InvocationId => `I${n}` as InvocationId;
const candidateId = (n: number): CandidateId => `C${n}` as CandidateId;
const reviewId = (n: number): ReviewId => `R${n}` as ReviewId;
const approvalId = (n: number): ApprovalId => `A${n}` as ApprovalId;
const operationId = (n: number): OperationId => `O${n}` as OperationId;
const artifactRef = (s: string): ArtifactRef => s as ArtifactRef;
const integrity = (s: string): IntegrityIdentity => s as IntegrityIdentity;
const scopeRef = (s: string): ScopeRef => s as ScopeRef;
const action = (s: string): AuthorityAction => s as AuthorityAction;
const launchKey = (s: string): LaunchKey => s as LaunchKey;
const materializationKey = (s: string): MaterializationKey => s as MaterializationKey;
const effectKey = (s: string): EffectKey => s as EffectKey;

const descriptor = <K extends string>(
  kind: K,
  identity: string,
  value: JsonObject = {},
): FrozenDescriptor<K> => ({
  kind,
  contractVersion: "1",
  identity: identity as FrozenDescriptor<K>["identity"],
  value,
});

const artifact = (ref: string): ArtifactBinding => ({
  ref: artifactRef(ref),
  integrity: integrity(`sha256:${ref}`),
});

const scope = (entries: ReadonlyArray<readonly [string, readonly string[]]>): AuthorityScope => ({
  grants: entries.map(([ref, actions]) => ({
    scopeRef: scopeRef(ref),
    actions: actions.map((item) => action(item)),
  })),
});

const taskScope = scope([
  ["repo:demo/read", ["read"]],
  ["repo:demo/propose", ["propose"]],
  ["repo:demo/apply", ["apply"]],
]);

const activeTask = (): ActiveTask => ({
  id: taskId,
  version: 1,
  status: "active",
  creationSpec: descriptor("task-creation", "task-creation:1", {
    intent: "implement change",
  }),
  policySnapshot: descriptor("task-policy", "policy:default:1", {
    mode: "demo",
  }),
  authorityScope: taskScope,
});

const proposalStage = (): Stage => ({
  id: stageId(1),
  taskId,
  role: "proposal",
  kind: "coding.implementation",
  contractVersion: "1",
  materializationKey: materializationKey("proposal:initial"),
  semanticInputs: [{ name: "creation", value: { type: "task", id: taskId } }],
  realizationRequirement: descriptor("realization-requirement", "req:proposal:1"),
  allowedScope: scope([
    ["repo:demo/read", ["read"]],
    ["repo:demo/propose", ["propose"]],
  ]),
  currentExecutionGeneration: 0,
  status: "pending",
});

const evaluationStage = (id: StageId, candidate: CandidateId, kind: string): Stage => ({
  id,
  taskId,
  role: "evaluation",
  kind,
  contractVersion: "1",
  materializationKey: materializationKey(`review:${kind}:${candidate}`),
  semanticInputs: [
    { name: "candidate", value: { type: "candidate", id: candidate } },
    {
      name: "authority-requirement",
      value: descriptor("authority-requirement", "req:review:1"),
    },
  ],
  realizationRequirement: descriptor("realization-requirement", `req:${kind}:1`),
  allowedScope: scope([["repo:demo/read", ["read"]]]),
  currentExecutionGeneration: 0,
  status: "active",
});

const effectStage = (candidate: CandidateId, approval: ApprovalId): Stage => ({
  id: stageId(4),
  taskId,
  role: "effect",
  kind: "candidate.apply",
  contractVersion: "1",
  materializationKey: materializationKey(`apply:${candidate}`),
  semanticInputs: [
    { name: "candidate", value: { type: "candidate", id: candidate } },
    { name: "approval", value: { type: "approval", id: approval } },
  ],
  realizationRequirement: descriptor("realization-requirement", "req:apply:1"),
  allowedScope: scope([["repo:demo/apply", ["apply"]]]),
  currentExecutionGeneration: 0,
  status: "pending",
});

const preparedInvocation = (id: InvocationId, stage: StageId, generation: number): Invocation => ({
  id,
  taskId,
  stageId: stage,
  generation,
  launchKey: launchKey(`launch:${id}`),
  realizerBinding: descriptor("realizer-binding", `binding:${id}`),
  status: "prepared",
  proposalDisposition: { kind: "unresolved" },
});

const succeededInvocation = (
  id: InvocationId,
  stage: StageId,
  generation: number,
  proposal: ArtifactBinding | undefined,
): Invocation => ({
  ...preparedInvocation(id, stage, generation),
  status: "succeeded",
  ...(proposal ? { proposal } : {}),
});

const candidate = (
  id: CandidateId,
  producedBy: InvocationId,
  artifactValue: ArtifactBinding,
): Candidate => ({
  id,
  taskId,
  producedByInvocationId: producedBy,
  artifact: artifactValue,
  scopeRef: scopeRef("repo:demo/propose"),
});

const review = (
  id: ReviewId,
  stage: StageId,
  candidateValue: CandidateId,
  disposition: Review["disposition"] = "pass",
  invocationEvidence?: ArtifactBinding,
  provenance: Review["decisionProvenance"] = {
    kind: "actor",
    actorRef: "actor:host" as Review["decisionProvenance"] extends { kind: "actor" }
      ? "actor:host"
      : never,
  },
): Review => ({
  id,
  taskId,
  stageId: stage,
  candidateId: candidateValue,
  authorityRequirement: descriptor("authority-requirement", "req:review:1"),
  disposition,
  evidence: [invocationEvidence ?? artifact(`evidence:${id}`)],
  decisionProvenance: provenance,
});

const approval = (
  id: ApprovalId,
  candidateValue: CandidateId,
  reviewIds: readonly [ReviewId, ...ReviewId[]],
): Approval => ({
  id,
  taskId,
  candidateId: candidateValue,
  policyIdentity: "policy:default:1" as Approval["policyIdentity"],
  evidenceReviewIds: reviewIds,
  decisionProvenance: {
    kind: "policy",
    policyIdentity: "policy:default:1" as Approval["policyIdentity"],
  },
});

const operation = (
  id: OperationId,
  stage: StageId,
  candidateValue: CandidateId,
  approvalValue: ApprovalId,
): Operation => ({
  id,
  taskId,
  stageId: stage,
  candidateId: candidateValue,
  approvalId: approvalValue,
  targetScopeRef: scopeRef("repo:demo/apply"),
  precondition: descriptor("effect-precondition", "pre:apply:1"),
  effectKey: effectKey(`apply:${candidateValue}`),
  status: "prepared",
});

const unwrap = <T>(result: DomainResult<T>): T => {
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.value;
};

const fail = <T>(result: DomainResult<T>): DomainResult<T> & { ok: false } => {
  if (result.ok) {
    throw new Error("Expected command to fail");
  }
  return result;
};

const command = (input: DomainCommand): DomainCommand => input;

const apply = (aggregate: TaskAggregate, input: DomainCommand): DomainResult<TaskAggregate> =>
  applyDomainCommand(aggregate, input);

const snapshot = (aggregate: TaskAggregate): string => JSON.stringify(aggregate);

const buildEffectStageAggregate = (): TaskAggregate => {
  let aggregate = createTask(activeTask());
  aggregate = unwrap(
    apply(aggregate, command({ type: "materialize-stage", stage: proposalStage() })),
  );
  const i1 = preparedInvocation(invocationId(1), stageId(1), 1);
  aggregate = unwrap(apply(aggregate, command({ type: "prepare-invocation", invocation: i1 })));
  aggregate = unwrap(
    apply(
      aggregate,
      command({
        type: "record-invocation-result",
        invocationId: i1.id,
        result: { kind: "succeeded", proposal: artifact("proposal:1") },
      }),
    ),
  );
  const c1 = candidate(candidateId(1), i1.id, artifact("proposal:1"));
  aggregate = unwrap(
    apply(
      aggregate,
      command({
        type: "accept-invocation-proposal",
        invocationId: i1.id,
        outcome: { kind: "candidate", candidate: c1 },
      }),
    ),
  );
  const s2 = evaluationStage(stageId(2), c1.id, "host");
  aggregate = unwrap(apply(aggregate, command({ type: "materialize-stage", stage: s2 })));
  const r1 = review(reviewId(1), s2.id, c1.id);
  aggregate = unwrap(apply(aggregate, command({ type: "submit-external-review", review: r1 })));
  const a1 = approval(approvalId(1), c1.id, [r1.id]);
  aggregate = unwrap(apply(aggregate, command({ type: "create-approval", approval: a1 })));
  const s4 = effectStage(c1.id, a1.id);
  aggregate = unwrap(apply(aggregate, command({ type: "materialize-stage", stage: s4 })));
  return aggregate;
};

const buildPreparedOperationAggregate = (): TaskAggregate => {
  const aggregate = buildEffectStageAggregate();
  const o1 = operation(operationId(1), stageId(4), candidateId(1), approvalId(1));
  return unwrap(apply(aggregate, command({ type: "prepare-operation", operation: o1 })));
};

const addSecondCandidateAndApproval = (aggregate: TaskAggregate): TaskAggregate => {
  const s5: Stage = {
    ...proposalStage(),
    id: stageId(5),
    materializationKey: materializationKey("proposal:second"),
  };
  let next = unwrap(apply(aggregate, command({ type: "materialize-stage", stage: s5 })));
  const i10 = preparedInvocation(invocationId(10), stageId(5), 1);
  next = unwrap(apply(next, command({ type: "prepare-invocation", invocation: i10 })));
  next = unwrap(
    apply(
      next,
      command({
        type: "record-invocation-result",
        invocationId: i10.id,
        result: { kind: "succeeded", proposal: artifact("proposal:2") },
      }),
    ),
  );
  const c2 = candidate(candidateId(2), i10.id, artifact("proposal:2"));
  next = unwrap(
    apply(
      next,
      command({
        type: "accept-invocation-proposal",
        invocationId: i10.id,
        outcome: { kind: "candidate", candidate: c2 },
      }),
    ),
  );
  const s6 = evaluationStage(stageId(6), c2.id, "host2");
  next = unwrap(apply(next, command({ type: "materialize-stage", stage: s6 })));
  const r2 = review(reviewId(2), s6.id, c2.id);
  next = unwrap(apply(next, command({ type: "submit-external-review", review: r2 })));
  const a2 = approval(approvalId(2), c2.id, [r2.id]);
  next = unwrap(apply(next, command({ type: "create-approval", approval: a2 })));
  return next;
};

describe("task domain v1", () => {
  it("walks the full golden path from task to completed task", () => {
    let aggregate = createTask(activeTask());
    expect(aggregate.task.version).toBe(1);

    aggregate = unwrap(
      apply(aggregate, command({ type: "materialize-stage", stage: proposalStage() })),
    );
    expect(aggregate.task.version).toBe(2);
    expect(aggregate.stages[stageId(1)]).toBeDefined();

    const i1 = preparedInvocation(invocationId(1), stageId(1), 1);
    aggregate = unwrap(apply(aggregate, command({ type: "prepare-invocation", invocation: i1 })));
    expect(aggregate.task.version).toBe(3);
    expect(aggregate.stages[stageId(1)].currentExecutionGeneration).toBe(1);

    aggregate = unwrap(
      apply(aggregate, command({ type: "mark-invocation-launched", invocationId: i1.id })),
    );
    expect(aggregate.task.version).toBe(3);
    expect(aggregate.invocations[i1.id].status).toBe("launched");

    const proposalArtifact = artifact("proposal:1");
    aggregate = unwrap(
      apply(
        aggregate,
        command({
          type: "record-invocation-result",
          invocationId: i1.id,
          result: { kind: "succeeded", proposal: proposalArtifact },
        }),
      ),
    );
    expect(aggregate.task.version).toBe(3);
    expect(aggregate.invocations[i1.id].status).toBe("succeeded");

    const c1 = candidate(candidateId(1), i1.id, proposalArtifact);
    aggregate = unwrap(
      apply(
        aggregate,
        command({
          type: "accept-invocation-proposal",
          invocationId: i1.id,
          outcome: { kind: "candidate", candidate: c1 },
        }),
      ),
    );
    expect(aggregate.task.version).toBe(4);
    expect(aggregate.stages[stageId(1)].status).toBe("completed");
    expect(aggregate.candidates[c1.id]).toBeDefined();

    const s2 = evaluationStage(stageId(2), c1.id, "preliminary");
    const s3 = evaluationStage(stageId(3), c1.id, "host");
    aggregate = unwrap(apply(aggregate, command({ type: "materialize-stage", stage: s2 })));
    aggregate = unwrap(apply(aggregate, command({ type: "materialize-stage", stage: s3 })));
    expect(aggregate.task.version).toBe(6);

    const r1 = review(reviewId(1), s2.id, c1.id, "pass", artifact("review-evidence:1"), {
      kind: "invocation",
      invocationId: invocationId(2),
    });
    // An invocation-produced review must come from a succeeded invocation for that stage.
    const i2 = succeededInvocation(invocationId(2), s2.id, 1, artifact("review-evidence:1"));
    aggregate = unwrap(
      apply(
        aggregate,
        command({
          type: "prepare-invocation",
          invocation: preparedInvocation(i2.id, s2.id, 1),
        }),
      ),
    );
    aggregate = unwrap(
      apply(
        aggregate,
        command({
          type: "record-invocation-result",
          invocationId: i2.id,
          result: { kind: "succeeded", proposal: artifact("review-evidence:1") },
        }),
      ),
    );
    aggregate = unwrap(
      apply(
        aggregate,
        command({
          type: "accept-invocation-proposal",
          invocationId: i2.id,
          outcome: { kind: "review", review: r1 },
        }),
      ),
    );

    const r2 = review(reviewId(2), s3.id, c1.id);
    aggregate = unwrap(apply(aggregate, command({ type: "submit-external-review", review: r2 })));
    expect(aggregate.task.version).toBe(9);

    const a1 = approval(approvalId(1), c1.id, [r1.id, r2.id]);
    aggregate = unwrap(apply(aggregate, command({ type: "create-approval", approval: a1 })));
    expect(aggregate.task.version).toBe(10);

    const s4 = effectStage(c1.id, a1.id);
    aggregate = unwrap(apply(aggregate, command({ type: "materialize-stage", stage: s4 })));
    expect(aggregate.task.version).toBe(11);

    const o1 = operation(operationId(1), s4.id, c1.id, a1.id);
    aggregate = unwrap(apply(aggregate, command({ type: "prepare-operation", operation: o1 })));
    expect(aggregate.task.version).toBe(12);
    expect(aggregate.operations[o1.id].status).toBe("prepared");

    aggregate = unwrap(
      apply(aggregate, command({ type: "dispatch-operation", operationId: o1.id })),
    );
    expect(aggregate.task.version).toBe(13);
    expect(aggregate.operations[o1.id].status).toBe("dispatched");

    aggregate = unwrap(
      apply(
        aggregate,
        command({
          type: "reconcile-operation",
          operationId: o1.id,
          resolution: { kind: "confirmed", evidence: artifact("confirmation:1") },
        }),
      ),
    );
    expect(aggregate.task.version).toBe(14);
    expect(aggregate.operations[o1.id].status).toBe("confirmed");
    expect(aggregate.stages[s4.id].status).toBe("completed");

    aggregate = unwrap(
      apply(
        aggregate,
        command({
          type: "complete-task",
          completion: descriptor("task-completion", "completion:1"),
        }),
      ),
    );
    expect(aggregate.task.version).toBe(15);
    expect(aggregate.task.status).toBe("completed");
  });

  it("increments version only for authority commands and not observations", () => {
    let aggregate = createTask(activeTask());
    aggregate = unwrap(
      apply(aggregate, command({ type: "materialize-stage", stage: proposalStage() })),
    );
    const i1 = preparedInvocation(invocationId(1), stageId(1), 1);
    aggregate = unwrap(apply(aggregate, command({ type: "prepare-invocation", invocation: i1 })));

    const before = aggregate.task.version;
    aggregate = unwrap(
      apply(aggregate, command({ type: "mark-invocation-launched", invocationId: i1.id })),
    );
    expect(aggregate.task.version).toBe(before);
    aggregate = unwrap(
      apply(
        aggregate,
        command({
          type: "record-invocation-result",
          invocationId: i1.id,
          result: { kind: "indeterminate" },
        }),
      ),
    );
    expect(aggregate.task.version).toBe(before);
  });

  it("rejects duplicate ids, duplicate materialization keys, and cross-task references", () => {
    let aggregate = createTask(activeTask());
    aggregate = unwrap(
      apply(aggregate, command({ type: "materialize-stage", stage: proposalStage() })),
    );

    expect(
      fail(apply(aggregate, command({ type: "materialize-stage", stage: proposalStage() }))).error
        .code,
    ).toBe("STAGE_ALREADY_EXISTS");

    const duplicateKeyStage: Stage = {
      ...proposalStage(),
      id: stageId(99),
    };
    expect(
      fail(apply(aggregate, command({ type: "materialize-stage", stage: duplicateKeyStage }))).error
        .code,
    ).toBe("STAGE_MATERIALIZATION_KEY_DUPLICATE");

    const foreignStage: Stage = {
      ...proposalStage(),
      id: stageId(100),
      taskId: "OTHER" as TaskId,
    };
    expect(
      fail(apply(aggregate, command({ type: "materialize-stage", stage: foreignStage }))).error
        .code,
    ).toBe("ENTITY_TASK_MISMATCH");

    const firstInvocation = preparedInvocation(invocationId(1), stageId(1), 1);
    aggregate = unwrap(
      apply(aggregate, command({ type: "prepare-invocation", invocation: firstInvocation })),
    );
    const duplicateInvocation = preparedInvocation(invocationId(1), stageId(1), 1);
    expect(
      fail(
        apply(aggregate, command({ type: "prepare-invocation", invocation: duplicateInvocation })),
      ).error.code,
    ).toBe("INVOCATION_ALREADY_EXISTS");
  });

  it("rejects scope widening and wrong role completion", () => {
    let aggregate = createTask(activeTask());
    const widenedStage: Stage = {
      ...proposalStage(),
      allowedScope: scope([
        ["repo:demo/read", ["read"]],
        ["repo:demo/other", ["write"]],
      ]),
    };
    expect(
      fail(apply(aggregate, command({ type: "materialize-stage", stage: widenedStage }))).error
        .code,
    ).toBe("SCOPE_NOT_AUTHORIZED");

    aggregate = unwrap(
      apply(aggregate, command({ type: "materialize-stage", stage: proposalStage() })),
    );
    const i1 = preparedInvocation(invocationId(1), stageId(1), 1);
    aggregate = unwrap(apply(aggregate, command({ type: "prepare-invocation", invocation: i1 })));
    aggregate = unwrap(
      apply(
        aggregate,
        command({
          type: "record-invocation-result",
          invocationId: i1.id,
          result: { kind: "succeeded", proposal: artifact("proposal:1") },
        }),
      ),
    );
    const wrongOutcome = fail(
      apply(
        aggregate,
        command({
          type: "accept-invocation-proposal",
          invocationId: i1.id,
          outcome: { kind: "succeeded" },
        }),
      ),
    );
    expect(wrongOutcome.error.code).toBe("STAGE_ROLE_MISMATCH");
  });

  it("fences stale invocations and retains late success as evidence", () => {
    let aggregate = createTask(activeTask());
    aggregate = unwrap(
      apply(aggregate, command({ type: "materialize-stage", stage: proposalStage() })),
    );
    const i1 = preparedInvocation(invocationId(1), stageId(1), 1);
    aggregate = unwrap(apply(aggregate, command({ type: "prepare-invocation", invocation: i1 })));
    aggregate = unwrap(
      apply(aggregate, command({ type: "mark-invocation-launched", invocationId: i1.id })),
    );
    aggregate = unwrap(
      apply(
        aggregate,
        command({
          type: "record-invocation-result",
          invocationId: i1.id,
          result: { kind: "indeterminate" },
        }),
      ),
    );

    const i2 = preparedInvocation(invocationId(2), stageId(1), 2);
    aggregate = unwrap(apply(aggregate, command({ type: "prepare-invocation", invocation: i2 })));
    expect(aggregate.stages[stageId(1)].currentExecutionGeneration).toBe(2);

    // Late I1 success is recorded as evidence, not as authority.
    aggregate = unwrap(
      apply(
        aggregate,
        command({
          type: "record-invocation-result",
          invocationId: i1.id,
          result: { kind: "succeeded", proposal: artifact("late:1") },
        }),
      ),
    );
    expect(aggregate.invocations[i1.id].status).toBe("succeeded");
    expect(aggregate.invocations[i1.id].proposal?.ref).toBe(artifactRef("late:1"));

    const staleAcceptance = fail(
      apply(
        aggregate,
        command({
          type: "accept-invocation-proposal",
          invocationId: i1.id,
          outcome: {
            kind: "candidate",
            candidate: candidate(candidateId(1), i1.id, artifact("late:1")),
          },
        }),
      ),
    );
    expect(staleAcceptance.error.code).toBe("INVOCATION_GENERATION_STALE");
  });

  it("rejects duplicate proposal acceptance and invalid review bindings", () => {
    let aggregate = createTask(activeTask());
    aggregate = unwrap(
      apply(aggregate, command({ type: "materialize-stage", stage: proposalStage() })),
    );
    const i1 = preparedInvocation(invocationId(1), stageId(1), 1);
    aggregate = unwrap(apply(aggregate, command({ type: "prepare-invocation", invocation: i1 })));
    aggregate = unwrap(
      apply(
        aggregate,
        command({
          type: "record-invocation-result",
          invocationId: i1.id,
          result: { kind: "succeeded", proposal: artifact("proposal:1") },
        }),
      ),
    );
    const c1 = candidate(candidateId(1), i1.id, artifact("proposal:1"));
    const accept = () =>
      apply(
        aggregate,
        command({
          type: "accept-invocation-proposal",
          invocationId: i1.id,
          outcome: { kind: "candidate", candidate: c1 },
        }),
      );
    aggregate = unwrap(accept());
    expect(fail(accept()).error.code).toBe("INVOCATION_PROPOSAL_ALREADY_RESOLVED");

    const s2 = evaluationStage(stageId(2), c1.id, "host");
    aggregate = unwrap(apply(aggregate, command({ type: "materialize-stage", stage: s2 })));

    const wrongCandidateReview = review(
      reviewId(1),
      s2.id,
      candidateId(999),
      "pass",
      artifact("bad"),
    );
    expect(
      fail(
        apply(aggregate, command({ type: "submit-external-review", review: wrongCandidateReview })),
      ).error.code,
    ).toBe("REVIEW_CANDIDATE_MISMATCH");
  });

  it("rejects approval with wrong policy, wrong review evidence, and invalidates before dispatch", () => {
    let aggregate = createTask(activeTask());
    aggregate = unwrap(
      apply(aggregate, command({ type: "materialize-stage", stage: proposalStage() })),
    );
    const i1 = preparedInvocation(invocationId(1), stageId(1), 1);
    aggregate = unwrap(apply(aggregate, command({ type: "prepare-invocation", invocation: i1 })));
    aggregate = unwrap(
      apply(
        aggregate,
        command({
          type: "record-invocation-result",
          invocationId: i1.id,
          result: { kind: "succeeded", proposal: artifact("proposal:1") },
        }),
      ),
    );
    const c1 = candidate(candidateId(1), i1.id, artifact("proposal:1"));
    aggregate = unwrap(
      apply(
        aggregate,
        command({
          type: "accept-invocation-proposal",
          invocationId: i1.id,
          outcome: { kind: "candidate", candidate: c1 },
        }),
      ),
    );

    const s2 = evaluationStage(stageId(2), c1.id, "host");
    aggregate = unwrap(apply(aggregate, command({ type: "materialize-stage", stage: s2 })));
    const r1 = review(reviewId(1), s2.id, c1.id);
    aggregate = unwrap(apply(aggregate, command({ type: "submit-external-review", review: r1 })));

    const wrongPolicy = approval(approvalId(1), c1.id, [r1.id]);
    const badApproval = fail(
      apply(
        aggregate,
        command({
          type: "create-approval",
          approval: {
            ...wrongPolicy,
            policyIdentity: "policy:other" as Approval["policyIdentity"],
          },
        }),
      ),
    );
    expect(badApproval.error.code).toBe("APPROVAL_POLICY_MISMATCH");

    const a1 = approval(approvalId(1), c1.id, [r1.id]);
    aggregate = unwrap(apply(aggregate, command({ type: "create-approval", approval: a1 })));

    const s4 = effectStage(c1.id, a1.id);
    aggregate = unwrap(apply(aggregate, command({ type: "materialize-stage", stage: s4 })));
    const o1 = operation(operationId(1), s4.id, c1.id, a1.id);
    aggregate = unwrap(apply(aggregate, command({ type: "prepare-operation", operation: o1 })));

    aggregate = unwrap(
      apply(
        aggregate,
        command({
          type: "invalidate-approval",
          approvalId: a1.id,
          reason: descriptor("approval-invalidation", "invalidate:1"),
        }),
      ),
    );
    expect(aggregate.authority.ineffectiveApprovalIds).toContain(a1.id);

    const dispatchAfterInvalidation = fail(
      apply(aggregate, command({ type: "dispatch-operation", operationId: o1.id })),
    );
    expect(dispatchAfterInvalidation.error.code).toBe("APPROVAL_NOT_EFFECTIVE");
  });

  it("enforces operation state machine and reconcile paths", () => {
    let aggregate = createTask(activeTask());
    aggregate = unwrap(
      apply(aggregate, command({ type: "materialize-stage", stage: proposalStage() })),
    );
    const i1 = preparedInvocation(invocationId(1), stageId(1), 1);
    aggregate = unwrap(apply(aggregate, command({ type: "prepare-invocation", invocation: i1 })));
    aggregate = unwrap(
      apply(
        aggregate,
        command({
          type: "record-invocation-result",
          invocationId: i1.id,
          result: { kind: "succeeded", proposal: artifact("proposal:1") },
        }),
      ),
    );
    const c1 = candidate(candidateId(1), i1.id, artifact("proposal:1"));
    aggregate = unwrap(
      apply(
        aggregate,
        command({
          type: "accept-invocation-proposal",
          invocationId: i1.id,
          outcome: { kind: "candidate", candidate: c1 },
        }),
      ),
    );
    const s2 = evaluationStage(stageId(2), c1.id, "host");
    aggregate = unwrap(apply(aggregate, command({ type: "materialize-stage", stage: s2 })));
    const r1 = review(reviewId(1), s2.id, c1.id);
    aggregate = unwrap(apply(aggregate, command({ type: "submit-external-review", review: r1 })));
    const a1 = approval(approvalId(1), c1.id, [r1.id]);
    aggregate = unwrap(apply(aggregate, command({ type: "create-approval", approval: a1 })));
    const s4 = effectStage(c1.id, a1.id);
    aggregate = unwrap(apply(aggregate, command({ type: "materialize-stage", stage: s4 })));
    const o1 = operation(operationId(1), s4.id, c1.id, a1.id);
    aggregate = unwrap(apply(aggregate, command({ type: "prepare-operation", operation: o1 })));

    aggregate = unwrap(
      apply(aggregate, command({ type: "dispatch-operation", operationId: o1.id })),
    );
    expect(
      fail(
        apply(
          aggregate,
          command({
            type: "abort-operation",
            operationId: o1.id,
            reason: descriptor("operation-abort", "abort:1"),
          }),
        ),
      ).error.code,
    ).toBe("OPERATION_ABORT_FORBIDDEN");

    aggregate = unwrap(
      apply(
        aggregate,
        command({
          type: "reconcile-operation",
          operationId: o1.id,
          resolution: { kind: "unknown" },
        }),
      ),
    );
    expect(aggregate.operations[o1.id].status).toBe("indeterminate");
    expect(
      fail(apply(aggregate, command({ type: "dispatch-operation", operationId: o1.id }))).error
        .code,
    ).toBe("OPERATION_DISPATCH_FORBIDDEN");

    aggregate = unwrap(
      apply(
        aggregate,
        command({
          type: "reconcile-operation",
          operationId: o1.id,
          resolution: { kind: "not-applied", evidence: artifact("not-applied:1") },
        }),
      ),
    );
    expect(aggregate.operations[o1.id].status).toBe("prepared");

    aggregate = unwrap(
      apply(aggregate, command({ type: "dispatch-operation", operationId: o1.id })),
    );
    aggregate = unwrap(
      apply(
        aggregate,
        command({
          type: "reconcile-operation",
          operationId: o1.id,
          resolution: { kind: "confirmed", evidence: artifact("confirmation:1") },
        }),
      ),
    );
    expect(aggregate.operations[o1.id].status).toBe("confirmed");
  });

  it("keeps failed commands non-mutating and succeeds without mutating the old aggregate", () => {
    let aggregate = createTask(activeTask());
    const before = snapshot(aggregate);
    const failedResult = fail(
      apply(aggregate, command({ type: "dispatch-operation", operationId: operationId(999) })),
    );
    expect(failedResult.error.code).toBe("OPERATION_NOT_FOUND");
    expect(snapshot(aggregate)).toBe(before);

    aggregate = unwrap(
      apply(aggregate, command({ type: "materialize-stage", stage: proposalStage() })),
    );
    const beforeMaterialize = snapshot(aggregate);
    const next = unwrap(
      apply(
        aggregate,
        command({
          type: "prepare-invocation",
          invocation: preparedInvocation(invocationId(1), stageId(1), 1),
        }),
      ),
    );
    expect(snapshot(aggregate)).toBe(beforeMaterialize);
    expect(next.task.version).toBe(aggregate.task.version + 1);
  });

  it("cancels task, fences open stages, and still allows late result observation", () => {
    let aggregate = createTask(activeTask());
    aggregate = unwrap(
      apply(aggregate, command({ type: "materialize-stage", stage: proposalStage() })),
    );
    aggregate = unwrap(
      apply(
        aggregate,
        command({
          type: "prepare-invocation",
          invocation: preparedInvocation(invocationId(1), stageId(1), 1),
        }),
      ),
    );
    const genBeforeCancel = aggregate.stages[stageId(1)].currentExecutionGeneration;

    aggregate = unwrap(
      apply(
        aggregate,
        command({
          type: "cancel-task",
          cancellation: descriptor("task-cancellation", "cancel:1"),
          stageCancellations: [
            {
              kind: "stage-cancellation",
              contractVersion: "1",
              identity: "stage-cancel:1" as DescriptorIdentity,
              value: {
                taskCancellationIdentity: "cancel:1",
                taskId,
                stageId: stageId(1),
              },
            },
          ],
          operationAborts: [],
        }),
      ),
    );
    expect(aggregate.task.status).toBe("cancelled");
    expect(aggregate.stages[stageId(1)].currentExecutionGeneration).toBe(genBeforeCancel + 1);

    const late = unwrap(
      apply(
        aggregate,
        command({
          type: "record-invocation-result",
          invocationId: invocationId(1),
          result: { kind: "succeeded", proposal: artifact("late:cancel") },
        }),
      ),
    );
    expect(late.invocations[invocationId(1)].status).toBe("succeeded");
  });

  it("fails closed on missing, duplicate, or ambiguous stage semantic bindings", () => {
    const aggregate = buildEffectStageAggregate();
    const c1 = candidateId(1);
    const a1 = approvalId(1);

    const missingEvaluationCandidate: Stage = {
      ...evaluationStage(stageId(7), c1, "host"),
      materializationKey: materializationKey("review:missing:c1"),
      semanticInputs: [],
    };
    expect(
      fail(
        apply(aggregate, command({ type: "materialize-stage", stage: missingEvaluationCandidate })),
      ).error.code,
    ).toBe("SEMANTIC_REF_INVALID");

    const duplicateEvaluationCandidate: Stage = {
      ...evaluationStage(stageId(8), c1, "host"),
      materializationKey: materializationKey("review:duplicate:c1"),
      semanticInputs: [
        { name: "candidate", value: { type: "candidate", id: c1 } },
        { name: "candidate", value: { type: "candidate", id: c1 } },
      ],
    };
    expect(
      fail(
        apply(
          aggregate,
          command({ type: "materialize-stage", stage: duplicateEvaluationCandidate }),
        ),
      ).error.code,
    ).toBe("SEMANTIC_REF_INVALID");

    const missingEffectApproval: Stage = {
      ...effectStage(c1, a1),
      id: stageId(9),
      materializationKey: materializationKey("apply:missing-approval"),
      semanticInputs: [{ name: "candidate", value: { type: "candidate", id: c1 } }],
    };
    expect(
      fail(apply(aggregate, command({ type: "materialize-stage", stage: missingEffectApproval })))
        .error.code,
    ).toBe("SEMANTIC_REF_INVALID");

    const ambiguousEffectApproval: Stage = {
      ...effectStage(c1, a1),
      id: stageId(10),
      materializationKey: materializationKey("apply:ambiguous-approval"),
      semanticInputs: [
        { name: "candidate", value: { type: "candidate", id: c1 } },
        { name: "approval", value: { type: "approval", id: a1 } },
        { name: "approval", value: { type: "approval", id: a1 } },
      ],
    };
    expect(
      fail(apply(aggregate, command({ type: "materialize-stage", stage: ambiguousEffectApproval })))
        .error.code,
    ).toBe("SEMANTIC_REF_INVALID");
  });

  it("rejects an operation whose candidate/approval do not match the effect stage frozen intent", () => {
    let aggregate = buildEffectStageAggregate();
    aggregate = addSecondCandidateAndApproval(aggregate);

    const mismatched = operation(operationId(2), stageId(4), candidateId(2), approvalId(2));
    const result = fail(
      apply(aggregate, command({ type: "prepare-operation", operation: mismatched })),
    );
    expect(result.error.code).toBe("OPERATION_STAGE_BINDING_MISMATCH");
    expect(aggregate.operations[operationId(2)]).toBeUndefined();
  });

  it("allows only one operation per effect stage and preserves the original aggregate on rejection", () => {
    const aggregate = buildPreparedOperationAggregate();
    const before = snapshot(aggregate);

    const second = operation(operationId(2), stageId(4), candidateId(1), approvalId(1));
    const result = fail(
      apply(aggregate, command({ type: "prepare-operation", operation: second })),
    );
    expect(result.error.code).toBe("OPERATION_INTENT_ALREADY_PREPARED");
    expect(snapshot(aggregate)).toBe(before);
  });

  it("reuses the original operation after not-applied and forbids a replacement operation", () => {
    let aggregate = buildPreparedOperationAggregate();
    const o1 = operationId(1);

    aggregate = unwrap(apply(aggregate, command({ type: "dispatch-operation", operationId: o1 })));
    aggregate = unwrap(
      apply(
        aggregate,
        command({
          type: "reconcile-operation",
          operationId: o1,
          resolution: { kind: "not-applied", evidence: artifact("not-applied:1") },
        }),
      ),
    );
    expect(aggregate.operations[o1].status).toBe("prepared");

    aggregate = unwrap(apply(aggregate, command({ type: "dispatch-operation", operationId: o1 })));
    expect(aggregate.operations[o1].status).toBe("dispatched");

    const replacement = operation(operationId(2), stageId(4), candidateId(1), approvalId(1));
    expect(
      fail(apply(aggregate, command({ type: "prepare-operation", operation: replacement }))).error
        .code,
    ).toBe("OPERATION_INTENT_ALREADY_PREPARED");
  });

  it("allows final invocation results from prepared, launched, and indeterminate", () => {
    let aggregate = createTask(activeTask());
    aggregate = unwrap(
      apply(aggregate, command({ type: "materialize-stage", stage: proposalStage() })),
    );
    const i1 = preparedInvocation(invocationId(1), stageId(1), 1);
    aggregate = unwrap(apply(aggregate, command({ type: "prepare-invocation", invocation: i1 })));

    let next = unwrap(
      apply(
        aggregate,
        command({
          type: "record-invocation-result",
          invocationId: i1.id,
          result: { kind: "failed", failure: descriptor("invocation-failure", "failure:1") },
        }),
      ),
    );
    expect(next.invocations[i1.id].status).toBe("failed");

    aggregate = createTask(activeTask());
    aggregate = unwrap(
      apply(aggregate, command({ type: "materialize-stage", stage: proposalStage() })),
    );
    const i2 = preparedInvocation(invocationId(2), stageId(1), 1);
    aggregate = unwrap(apply(aggregate, command({ type: "prepare-invocation", invocation: i2 })));
    aggregate = unwrap(
      apply(aggregate, command({ type: "mark-invocation-launched", invocationId: i2.id })),
    );
    next = unwrap(
      apply(
        aggregate,
        command({
          type: "record-invocation-result",
          invocationId: i2.id,
          result: { kind: "cancelled" },
        }),
      ),
    );
    expect(next.invocations[i2.id].status).toBe("cancelled");

    aggregate = createTask(activeTask());
    aggregate = unwrap(
      apply(aggregate, command({ type: "materialize-stage", stage: proposalStage() })),
    );
    const i3 = preparedInvocation(invocationId(3), stageId(1), 1);
    aggregate = unwrap(apply(aggregate, command({ type: "prepare-invocation", invocation: i3 })));
    aggregate = unwrap(
      apply(
        aggregate,
        command({
          type: "record-invocation-result",
          invocationId: i3.id,
          result: { kind: "indeterminate" },
        }),
      ),
    );
    next = unwrap(
      apply(
        aggregate,
        command({
          type: "record-invocation-result",
          invocationId: i3.id,
          result: { kind: "succeeded", proposal: artifact("late:3") },
        }),
      ),
    );
    expect(next.invocations[i3.id].status).toBe("succeeded");
  });

  it("does not overwrite terminal invocation observations", () => {
    let aggregate = createTask(activeTask());
    aggregate = unwrap(
      apply(aggregate, command({ type: "materialize-stage", stage: proposalStage() })),
    );
    const i1 = preparedInvocation(invocationId(1), stageId(1), 1);
    aggregate = unwrap(apply(aggregate, command({ type: "prepare-invocation", invocation: i1 })));
    aggregate = unwrap(
      apply(
        aggregate,
        command({
          type: "record-invocation-result",
          invocationId: i1.id,
          result: { kind: "failed", failure: descriptor("invocation-failure", "failure:1") },
        }),
      ),
    );
    const failedBefore = snapshot(aggregate);
    expect(
      fail(
        apply(
          aggregate,
          command({
            type: "record-invocation-result",
            invocationId: i1.id,
            result: { kind: "succeeded", proposal: artifact("late:1") },
          }),
        ),
      ).error.code,
    ).toBe("INVOCATION_STATE_INVALID");
    expect(snapshot(aggregate)).toBe(failedBefore);

    aggregate = createTask(activeTask());
    aggregate = unwrap(
      apply(aggregate, command({ type: "materialize-stage", stage: proposalStage() })),
    );
    const i2 = preparedInvocation(invocationId(2), stageId(1), 1);
    aggregate = unwrap(apply(aggregate, command({ type: "prepare-invocation", invocation: i2 })));
    aggregate = unwrap(
      apply(
        aggregate,
        command({
          type: "record-invocation-result",
          invocationId: i2.id,
          result: { kind: "cancelled" },
        }),
      ),
    );
    const cancelledBefore = snapshot(aggregate);
    expect(
      fail(
        apply(
          aggregate,
          command({
            type: "record-invocation-result",
            invocationId: i2.id,
            result: { kind: "failed", failure: descriptor("invocation-failure", "failure:2") },
          }),
        ),
      ).error.code,
    ).toBe("INVOCATION_STATE_INVALID");
    expect(snapshot(aggregate)).toBe(cancelledBefore);

    aggregate = createTask(activeTask());
    aggregate = unwrap(
      apply(aggregate, command({ type: "materialize-stage", stage: proposalStage() })),
    );
    const i3 = preparedInvocation(invocationId(3), stageId(1), 1);
    aggregate = unwrap(apply(aggregate, command({ type: "prepare-invocation", invocation: i3 })));
    aggregate = unwrap(
      apply(
        aggregate,
        command({
          type: "record-invocation-result",
          invocationId: i3.id,
          result: { kind: "succeeded", proposal: artifact("proposal:3") },
        }),
      ),
    );
    const succeededBefore = snapshot(aggregate);
    expect(
      fail(
        apply(
          aggregate,
          command({
            type: "record-invocation-result",
            invocationId: i3.id,
            result: { kind: "cancelled" },
          }),
        ),
      ).error.code,
    ).toBe("INVOCATION_STATE_INVALID");
    expect(snapshot(aggregate)).toBe(succeededBefore);
  });

  it("rejects preparing an Invocation for an effect stage", () => {
    const aggregate = buildEffectStageAggregate();
    const before = snapshot(aggregate);
    const versionBefore = aggregate.task.version;

    const result = fail(
      apply(
        aggregate,
        command({
          type: "prepare-invocation",
          invocation: preparedInvocation(invocationId(99), stageId(4), 1),
        }),
      ),
    );
    expect(result.error.code).toBe("STAGE_ROLE_MISMATCH");
    expect(snapshot(aggregate)).toBe(before);
    expect(aggregate.task.version).toBe(versionBefore);
  });

  it("rejects prepared Invocations that already carry proposal or failure fields", () => {
    let aggregate = createTask(activeTask());
    aggregate = unwrap(
      apply(aggregate, command({ type: "materialize-stage", stage: proposalStage() })),
    );
    const before = snapshot(aggregate);

    const withProposal: Invocation = {
      ...preparedInvocation(invocationId(1), stageId(1), 1),
      proposal: artifact("preloaded:proposal"),
    };
    expect(
      fail(apply(aggregate, command({ type: "prepare-invocation", invocation: withProposal })))
        .error.code,
    ).toBe("INVOCATION_STATE_INVALID");
    expect(snapshot(aggregate)).toBe(before);

    const withFailure: Invocation = {
      ...preparedInvocation(invocationId(2), stageId(1), 1),
      failure: descriptor("invocation-failure", "preloaded:failure"),
    };
    expect(
      fail(apply(aggregate, command({ type: "prepare-invocation", invocation: withFailure }))).error
        .code,
    ).toBe("INVOCATION_STATE_INVALID");
    expect(snapshot(aggregate)).toBe(before);

    const withBoth: Invocation = {
      ...preparedInvocation(invocationId(3), stageId(1), 1),
      proposal: artifact("preloaded:proposal"),
      failure: descriptor("invocation-failure", "preloaded:failure"),
    };
    expect(
      fail(apply(aggregate, command({ type: "prepare-invocation", invocation: withBoth }))).error
        .code,
    ).toBe("INVOCATION_STATE_INVALID");
    expect(snapshot(aggregate)).toBe(before);
  });
});
