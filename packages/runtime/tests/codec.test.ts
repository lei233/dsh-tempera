import { describe, expect, it } from "vitest";
import type {
  ActiveTask,
  Approval,
  ApprovalId,
  ArtifactBinding,
  AuthorityAction,
  AuthorityScope,
  Candidate,
  CandidateId,
  DescriptorIdentity,
  FrozenDescriptor,
  Invocation,
  InvocationId,
  JsonObject,
  Operation,
  OperationId,
  Review,
  ReviewId,
  ScopeRef,
  Stage,
  StageId,
  Task,
  TaskAggregate,
  TaskId,
} from "@dsh-tempera/domain";
import { AuthorityStoreError, decodeTaskAggregate, decodeStoredTaskSnapshot } from "../src/index";

const taskId = "T1" as TaskId;
const stageId = "S1" as StageId;
const invocationId = "I1" as InvocationId;
const candidateId = "C1" as CandidateId;
const reviewId = "R1" as ReviewId;
const approvalId = "A1" as ApprovalId;
const operationId = "O1" as OperationId;

const descriptor = <K extends string>(
  kind: K,
  identity: string,
  value: JsonObject = {},
): FrozenDescriptor<K> => ({
  kind,
  contractVersion: "1",
  identity: identity as DescriptorIdentity,
  value,
});

const artifact = (ref: string): ArtifactBinding => ({
  ref: ref as ArtifactBinding["ref"],
  integrity: `sha256:${ref}` as ArtifactBinding["integrity"],
});

const scope: AuthorityScope = {
  grants: [
    {
      scopeRef: "repo:demo/read" as ScopeRef,
      actions: ["read" as AuthorityAction],
    },
  ],
};

const activeTask = (): ActiveTask => ({
  id: taskId,
  version: 1,
  status: "active",
  creationSpec: descriptor("task-creation", "task-creation:1"),
  policySnapshot: descriptor("task-policy", "policy:default:1"),
  authorityScope: scope,
});

const completedTask = (): Task => ({
  ...activeTask(),
  status: "completed",
  completion: descriptor("task-completion", "task-completion:1"),
});

const failedTask = (): Task => ({
  ...activeTask(),
  status: "failed",
  failure: descriptor("task-failure", "task-failure:1"),
});

const cancelledTask = (): Task => ({
  ...activeTask(),
  status: "cancelled",
  cancellation: descriptor("task-cancellation", "task-cancellation:1"),
});

const stage = (): Stage => ({
  id: stageId,
  taskId,
  role: "proposal",
  kind: "coding.implementation",
  contractVersion: "1",
  materializationKey: "proposal:initial" as Stage["materializationKey"],
  semanticInputs: [],
  realizationRequirement: descriptor("realization-requirement", "req:proposal:1"),
  allowedScope: scope,
  currentExecutionGeneration: 0,
  status: "pending",
});

const failedStage = (): Stage => ({
  ...stage(),
  status: "failed",
  failure: descriptor("stage-failure", "stage-failure:1"),
});

const cancelledStage = (): Stage => ({
  ...stage(),
  status: "cancelled",
  cancellation: descriptor("stage-cancellation", "stage-cancellation:1"),
});

const invocation = (): Invocation => ({
  id: invocationId,
  taskId,
  stageId,
  generation: 1,
  launchKey: "launch:1" as Invocation["launchKey"],
  realizerBinding: descriptor("realizer-binding", "binding:1"),
  status: "prepared",
  proposalDisposition: { kind: "unresolved" },
});

const failedInvocation = (): Invocation => ({
  ...invocation(),
  status: "failed",
  failure: descriptor("invocation-failure", "invocation-failure:1"),
});

const candidate = (): Candidate => ({
  id: candidateId,
  taskId,
  producedByInvocationId: invocationId,
  artifact: artifact("artifact:1"),
  scopeRef: "repo:demo/read" as Candidate["scopeRef"],
  precondition: descriptor("candidate-precondition", "pre:1"),
});

const review = (): Review => ({
  id: reviewId,
  taskId,
  stageId,
  candidateId,
  authorityRequirement: descriptor("authority-requirement", "auth:1"),
  disposition: "pass",
  evidence: [artifact("evidence:1")],
  decisionProvenance: {
    kind: "actor",
    actorRef: "actor:host" as Review["decisionProvenance"] extends { kind: "actor" }
      ? "actor:host"
      : never,
  },
});

const approval = (): Approval => ({
  id: approvalId,
  taskId,
  candidateId,
  policyIdentity: "policy:default:1" as Approval["policyIdentity"],
  evidenceReviewIds: [reviewId],
  decisionProvenance: {
    kind: "policy",
    policyIdentity: "policy:default:1" as Approval["decisionProvenance"] extends { kind: "policy" }
      ? "policy:default:1"
      : never,
  },
});

const actorApproval = (): Approval => ({
  ...approval(),
  decisionProvenance: {
    kind: "actor",
    actorRef: "actor:approval" as Approval["decisionProvenance"] extends { kind: "actor" }
      ? "actor:approval"
      : never,
    authorityRequirement: descriptor("authority-requirement", "approval-auth:1"),
  },
});

const operation = (): Operation => ({
  id: operationId,
  taskId,
  stageId,
  candidateId,
  approvalId,
  targetScopeRef: "repo:demo/read" as Operation["targetScopeRef"],
  precondition: descriptor("effect-precondition", "effect:1"),
  effectKey: "effect:1" as Operation["effectKey"],
  status: "prepared",
});

const abortedOperation = (): Operation => ({
  ...operation(),
  status: "aborted",
  abortReason: descriptor("operation-abort", "abort:1"),
});

const aggregateWith = (
  overrides: {
    task?: Task;
    stages?: Record<StageId, Stage>;
    invocations?: Record<InvocationId, Invocation>;
    candidates?: Record<CandidateId, Candidate>;
    reviews?: Record<ReviewId, Review>;
    approvals?: Record<ApprovalId, Approval>;
    operations?: Record<OperationId, Operation>;
  } = {},
): TaskAggregate => ({
  task: overrides.task ?? activeTask(),
  stages: overrides.stages ?? { [stageId]: stage() },
  invocations: overrides.invocations ?? { [invocationId]: invocation() },
  candidates: overrides.candidates ?? { [candidateId]: candidate() },
  reviews: overrides.reviews ?? { [reviewId]: review() },
  approvals: overrides.approvals ?? { [approvalId]: approval() },
  operations: overrides.operations ?? { [operationId]: operation() },
  authority: { ineffectiveApprovalIds: [] },
});

const cloneAs = <T>(value: TaskAggregate): T => JSON.parse(JSON.stringify(value)) as T;

const wrongKind = <T>(value: TaskAggregate, mutate: (clone: T) => void): unknown => {
  const clone = cloneAs<T>(value);
  mutate(clone);
  return clone;
};

describe("TaskAggregate v1 codec", () => {
  it("round-trips a full aggregate with actor Review provenance", () => {
    const value = aggregateWith();
    const decoded = decodeTaskAggregate(1, value);
    expect(decoded.reviews[reviewId].decisionProvenance).toEqual({
      kind: "actor",
      actorRef: "actor:host",
    });
    expect(Object.isFrozen(decoded)).toBe(true);
  });

  it("rejects actor Review provenance missing actorRef", () => {
    const value = cloneAs<{ reviews: Record<string, { decisionProvenance: unknown }> }>(
      aggregateWith(),
    );
    value.reviews[reviewId].decisionProvenance = { kind: "actor" };
    expect(() => decodeTaskAggregate(1, value as unknown)).toThrowError(AuthorityStoreError);
  });

  it("accepts actor Review provenance without authorityRequirement", () => {
    const decoded = decodeTaskAggregate(1, aggregateWith());
    expect("authorityRequirement" in decoded.reviews[reviewId].decisionProvenance).toBe(false);
  });

  const descriptorMatrix: Array<{
    name: string;
    valid: () => TaskAggregate;
    invalid: () => unknown;
  }> = [
    {
      name: "Task creation descriptor",
      valid: () => aggregateWith({ task: activeTask() }),
      invalid: () =>
        wrongKind<{ task: { creationSpec: { kind: string } } }>(aggregateWith(), (value) => {
          value.task.creationSpec.kind = "task-policy";
        }),
    },
    {
      name: "Task policy descriptor",
      valid: () => aggregateWith({ task: activeTask() }),
      invalid: () =>
        wrongKind<{ task: { policySnapshot: { kind: string } } }>(aggregateWith(), (value) => {
          value.task.policySnapshot.kind = "task-creation";
        }),
    },
    {
      name: "Task completion descriptor",
      valid: () => aggregateWith({ task: completedTask() }),
      invalid: () =>
        wrongKind<{ task: { completion: { kind: string } } }>(
          aggregateWith({ task: completedTask() }),
          (value) => {
            value.task.completion.kind = "task-failure";
          },
        ),
    },
    {
      name: "Task failure descriptor",
      valid: () => aggregateWith({ task: failedTask() }),
      invalid: () =>
        wrongKind<{ task: { failure: { kind: string } } }>(
          aggregateWith({ task: failedTask() }),
          (value) => {
            value.task.failure.kind = "task-cancellation";
          },
        ),
    },
    {
      name: "Task cancellation descriptor",
      valid: () => aggregateWith({ task: cancelledTask() }),
      invalid: () =>
        wrongKind<{ task: { cancellation: { kind: string } } }>(
          aggregateWith({ task: cancelledTask() }),
          (value) => {
            value.task.cancellation.kind = "task-completion";
          },
        ),
    },
    {
      name: "Stage realization requirement descriptor",
      valid: () => aggregateWith(),
      invalid: () =>
        wrongKind<{ stages: Record<string, { realizationRequirement: { kind: string } }> }>(
          aggregateWith(),
          (value) => {
            value.stages[stageId].realizationRequirement.kind = "stage-failure";
          },
        ),
    },
    {
      name: "Stage failure descriptor",
      valid: () => aggregateWith({ stages: { [stageId]: failedStage() } }),
      invalid: () =>
        wrongKind<{ stages: Record<string, { failure: { kind: string } }> }>(
          aggregateWith({ stages: { [stageId]: failedStage() } }),
          (value) => {
            value.stages[stageId].failure.kind = "stage-cancellation";
          },
        ),
    },
    {
      name: "Stage cancellation descriptor",
      valid: () => aggregateWith({ stages: { [stageId]: cancelledStage() } }),
      invalid: () =>
        wrongKind<{ stages: Record<string, { cancellation: { kind: string } }> }>(
          aggregateWith({ stages: { [stageId]: cancelledStage() } }),
          (value) => {
            value.stages[stageId].cancellation.kind = "stage-failure";
          },
        ),
    },
    {
      name: "Invocation realizer binding descriptor",
      valid: () => aggregateWith(),
      invalid: () =>
        wrongKind<{ invocations: Record<string, { realizerBinding: { kind: string } }> }>(
          aggregateWith(),
          (value) => {
            value.invocations[invocationId].realizerBinding.kind = "invocation-failure";
          },
        ),
    },
    {
      name: "Invocation failure descriptor",
      valid: () => aggregateWith({ invocations: { [invocationId]: failedInvocation() } }),
      invalid: () =>
        wrongKind<{ invocations: Record<string, { failure: { kind: string } }> }>(
          aggregateWith({ invocations: { [invocationId]: failedInvocation() } }),
          (value) => {
            value.invocations[invocationId].failure.kind = "realizer-binding";
          },
        ),
    },
    {
      name: "Candidate precondition descriptor",
      valid: () => aggregateWith(),
      invalid: () =>
        wrongKind<{ candidates: Record<string, { precondition: { kind: string } }> }>(
          aggregateWith(),
          (value) => {
            value.candidates[candidateId].precondition.kind = "authority-requirement";
          },
        ),
    },
    {
      name: "Review authority requirement descriptor",
      valid: () => aggregateWith(),
      invalid: () =>
        wrongKind<{ reviews: Record<string, { authorityRequirement: { kind: string } }> }>(
          aggregateWith(),
          (value) => {
            value.reviews[reviewId].authorityRequirement.kind = "candidate-precondition";
          },
        ),
    },
    {
      name: "Approval actor authority requirement descriptor",
      valid: () => aggregateWith({ approvals: { [approvalId]: actorApproval() } }),
      invalid: () =>
        wrongKind<{
          approvals: Record<
            string,
            { decisionProvenance: { authorityRequirement: { kind: string } } }
          >;
        }>(aggregateWith({ approvals: { [approvalId]: actorApproval() } }), (value) => {
          value.approvals[approvalId].decisionProvenance.authorityRequirement.kind =
            "effect-precondition";
        }),
    },
    {
      name: "Operation effect precondition descriptor",
      valid: () => aggregateWith(),
      invalid: () =>
        wrongKind<{ operations: Record<string, { precondition: { kind: string } }> }>(
          aggregateWith(),
          (value) => {
            value.operations[operationId].precondition.kind = "operation-abort";
          },
        ),
    },
    {
      name: "Operation abort reason descriptor",
      valid: () => aggregateWith({ operations: { [operationId]: abortedOperation() } }),
      invalid: () =>
        wrongKind<{ operations: Record<string, { abortReason: { kind: string } }> }>(
          aggregateWith({ operations: { [operationId]: abortedOperation() } }),
          (value) => {
            value.operations[operationId].abortReason.kind = "effect-precondition";
          },
        ),
    },
  ];

  for (const entry of descriptorMatrix) {
    it(`accepts ${entry.name} with the correct kind`, () => {
      expect(() => decodeTaskAggregate(1, entry.valid())).not.toThrow();
    });

    it(`rejects ${entry.name} with the wrong kind`, () => {
      expect(() => decodeTaskAggregate(1, entry.invalid())).toThrowError(AuthorityStoreError);
    });
  }

  it("rejects metadata mismatch, entity key mismatch, ownership mismatch, and malformed JSON", () => {
    const value = aggregateWith();

    expect(() =>
      decodeStoredTaskSnapshot({
        task_id: taskId,
        version: 2,
        status: "active",
        aggregate_schema_version: 1,
        aggregate_json: JSON.stringify(value),
      }),
    ).toThrowError(AuthorityStoreError);

    const keyMismatch = cloneAs<{ stages: Record<string, Stage> }>(value);
    const stageValue = keyMismatch.stages[stageId];
    keyMismatch.stages = { WRONG: stageValue };
    expect(() => decodeTaskAggregate(1, keyMismatch as unknown)).toThrowError(AuthorityStoreError);

    const ownershipMismatch = cloneAs<{ stages: Record<string, { taskId: TaskId }> }>(value);
    ownershipMismatch.stages[stageId].taskId = "OTHER" as TaskId;
    expect(() => decodeTaskAggregate(1, ownershipMismatch as unknown)).toThrowError(
      AuthorityStoreError,
    );

    expect(() =>
      decodeStoredTaskSnapshot({
        task_id: taskId,
        version: 1,
        status: "active",
        aggregate_schema_version: 1,
        aggregate_json: "{not-json",
      }),
    ).toThrowError(AuthorityStoreError);

    expect(() =>
      decodeStoredTaskSnapshot({
        task_id: taskId,
        version: 1,
        status: "active",
        aggregate_schema_version: 99,
        aggregate_json: JSON.stringify(value),
      }),
    ).toThrowError(AuthorityStoreError);
  });
});
