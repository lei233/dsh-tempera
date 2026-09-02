import {
  candidateExists,
  clone,
  getFrozenCandidateId,
  getFrozenSemanticEntityIds,
  getSemanticRefsByType,
  hasOpenStages,
  isApprovalEffective,
  isObject,
  isScopeRefAuthorized,
  isScopeWithin,
  reviewExists,
  approvalExists,
  deepEqual,
} from "./internal";
import { reject, type DomainResult, type DomainRejectionCode } from "./result";
import type {
  ActiveTask,
  Approval,
  AuthorityCommand,
  Candidate,
  DomainCommand,
  FrozenDescriptor,
  Invocation,
  Operation,
  Review,
  Stage,
  TaskAggregate,
} from "./types";

const authorityError = (code: DomainRejectionCode, message: string): DomainResult<TaskAggregate> =>
  reject(code, message);

const requireActiveTask = (aggregate: TaskAggregate): DomainResult<TaskAggregate> | undefined => {
  if (aggregate.task.status !== "active") {
    return authorityError(
      "TASK_NOT_ACTIVE",
      `Task ${aggregate.task.id} is not active; authority commands are rejected.`,
    );
  }
  return undefined;
};

const requireValidSemanticRefs = (
  aggregate: TaskAggregate,
  stage: Stage,
): DomainResult<TaskAggregate> | undefined => {
  for (const ref of getFrozenSemanticEntityIds(stage.semanticInputs)) {
    if (ref.type === "task") {
      if (ref.id !== aggregate.task.id) {
        return authorityError(
          "SEMANTIC_REF_INVALID",
          `Stage ${stage.id} references a different task ${ref.id}.`,
        );
      }
      continue;
    }

    const entityExists =
      ref.type === "stage"
        ? aggregate.stages[ref.id as keyof TaskAggregate["stages"]] !== undefined
        : ref.type === "candidate"
          ? candidateExists(aggregate, ref.id as Candidate["id"], aggregate.task.id)
          : ref.type === "review"
            ? reviewExists(aggregate, ref.id, aggregate.task.id)
            : ref.type === "approval"
              ? approvalExists(aggregate, ref.id, aggregate.task.id)
              : ref.type === "operation"
                ? aggregate.operations[ref.id as keyof TaskAggregate["operations"]] !== undefined
                : false;

    if (!entityExists) {
      return authorityError(
        "SEMANTIC_REF_INVALID",
        `Stage ${stage.id} references unknown or foreign ${ref.type} ${ref.id}.`,
      );
    }
  }
  return undefined;
};

export const createTask = (task: ActiveTask): TaskAggregate => ({
  task: clone(task) as ActiveTask,
  stages: {},
  invocations: {},
  candidates: {},
  reviews: {},
  approvals: {},
  operations: {},
  authority: { ineffectiveApprovalIds: [] },
});

const getUniqueAuthorityRequirement = (
  stage: Stage,
): FrozenDescriptor<"authority-requirement"> | undefined => {
  const requirements = stage.semanticInputs.filter((input) => {
    if (!isObject(input.value)) {
      return false;
    }
    return (input.value as { readonly kind?: unknown }).kind === "authority-requirement";
  });
  return requirements.length === 1
    ? (requirements[0].value as FrozenDescriptor<"authority-requirement">)
    : undefined;
};

const materializeStage = (
  aggregate: TaskAggregate,
  command: Extract<AuthorityCommand, { readonly type: "materialize-stage" }>,
): DomainResult<TaskAggregate> => {
  const activeError = requireActiveTask(aggregate);
  if (activeError) return activeError;

  const stage = command.stage;
  if (aggregate.stages[stage.id]) {
    return authorityError("STAGE_ALREADY_EXISTS", `Stage ${stage.id} already exists.`);
  }
  if (stage.taskId !== aggregate.task.id) {
    return authorityError(
      "ENTITY_TASK_MISMATCH",
      `Stage ${stage.id} does not belong to task ${aggregate.task.id}.`,
    );
  }
  if (
    Object.values(aggregate.stages).some(
      (existing) =>
        existing.taskId === stage.taskId &&
        existing.materializationKey === stage.materializationKey,
    )
  ) {
    return authorityError(
      "STAGE_MATERIALIZATION_KEY_DUPLICATE",
      `Stage materializationKey ${stage.materializationKey} already exists for task ${stage.taskId}.`,
    );
  }
  if (stage.status !== "pending" && stage.status !== "active") {
    return authorityError(
      "STAGE_NOT_MATERIALIZABLE",
      `Stage ${stage.id} must be materialized as pending or active.`,
    );
  }
  if (!isScopeWithin(stage.allowedScope, aggregate.task.authorityScope)) {
    return authorityError(
      "SCOPE_NOT_AUTHORIZED",
      `Stage ${stage.id} allowedScope exceeds task authorityScope.`,
    );
  }

  const refError = requireValidSemanticRefs(aggregate, stage);
  if (refError) return refError;

  const candidateRefs = getSemanticRefsByType(stage, "candidate");
  const approvalRefs = getSemanticRefsByType(stage, "approval");

  if (stage.role === "evaluation") {
    if (candidateRefs.length !== 1) {
      return authorityError(
        "SEMANTIC_REF_INVALID",
        `Evaluation stage ${stage.id} must freeze exactly one candidate reference.`,
      );
    }
  }

  if (stage.role === "effect") {
    if (candidateRefs.length !== 1 || approvalRefs.length !== 1) {
      return authorityError(
        "SEMANTIC_REF_INVALID",
        `Effect stage ${stage.id} must freeze exactly one candidate and one approval reference.`,
      );
    }

    const frozenCandidateId = candidateRefs[0] as Candidate["id"];
    const frozenApprovalId = approvalRefs[0] as Approval["id"];
    const boundApproval = aggregate.approvals[frozenApprovalId];
    if (!boundApproval || boundApproval.candidateId !== frozenCandidateId) {
      return authorityError(
        "APPROVAL_CANDIDATE_MISMATCH",
        `Stage ${stage.id} must bind an approval for the same candidate as its frozen candidate reference.`,
      );
    }
  }

  const next = clone(aggregate);
  next.stages = {
    ...next.stages,
    [stage.id]: clone(stage) as Stage,
  } as TaskAggregate["stages"];
  next.task = {
    ...next.task,
    version: next.task.version + 1,
  };
  return { ok: true, value: next };
};

const prepareInvocation = (
  aggregate: TaskAggregate,
  command: Extract<AuthorityCommand, { readonly type: "prepare-invocation" }>,
): DomainResult<TaskAggregate> => {
  const activeError = requireActiveTask(aggregate);
  if (activeError) return activeError;

  const invocation = command.invocation;
  if (aggregate.invocations[invocation.id]) {
    return authorityError(
      "INVOCATION_ALREADY_EXISTS",
      `Invocation ${invocation.id} already exists.`,
    );
  }
  if (invocation.taskId !== aggregate.task.id) {
    return authorityError(
      "ENTITY_TASK_MISMATCH",
      `Invocation ${invocation.id} does not belong to task ${aggregate.task.id}.`,
    );
  }

  const stage = aggregate.stages[invocation.stageId];
  if (!stage) {
    return authorityError(
      "STAGE_NOT_FOUND",
      `Invocation ${invocation.id} references unknown stage ${invocation.stageId}.`,
    );
  }
  if (stage.taskId !== aggregate.task.id) {
    return authorityError(
      "ENTITY_TASK_MISMATCH",
      `Invocation ${invocation.id} references a stage from another task.`,
    );
  }
  if (stage.role === "effect") {
    return authorityError(
      "STAGE_ROLE_MISMATCH",
      `Effect stage ${stage.id} cannot prepare Invocations; it uses write-ahead Operations.`,
    );
  }
  if (stage.status === "completed" || stage.status === "failed" || stage.status === "cancelled") {
    return authorityError(
      "STAGE_NOT_ACTIVE",
      `Stage ${stage.id} is closed and cannot prepare new invocations.`,
    );
  }
  if (invocation.status !== "prepared") {
    return authorityError(
      "INVOCATION_STATE_INVALID",
      `Invocation ${invocation.id} must be created in prepared status.`,
    );
  }
  if (invocation.generation !== stage.currentExecutionGeneration + 1) {
    return authorityError(
      "INVOCATION_STATE_INVALID",
      `Invocation ${invocation.id} generation must be ${
        stage.currentExecutionGeneration + 1
      }, the next stage generation.`,
    );
  }
  if (invocation.proposalDisposition.kind !== "unresolved") {
    return authorityError(
      "INVOCATION_STATE_INVALID",
      `Invocation ${invocation.id} must start with unresolved proposal disposition.`,
    );
  }
  if (invocation.proposal !== undefined || invocation.failure !== undefined) {
    return authorityError(
      "INVOCATION_STATE_INVALID",
      `Invocation ${invocation.id} must be prepared without proposal or failure fields.`,
    );
  }

  const existingForStage = Object.values(aggregate.invocations).filter(
    (candidate) => candidate.stageId === invocation.stageId,
  );
  if (existingForStage.length > 0) {
    const latest = existingForStage.reduce((left, right) =>
      right.generation > left.generation ? right : left,
    );
    if (!["failed", "indeterminate", "cancelled"].includes(latest.status)) {
      return authorityError(
        "INVOCATION_STATE_INVALID",
        `Stage ${stage.id} already has a live invocation ${latest.id}; retry is only allowed after failed, indeterminate, or cancelled.`,
      );
    }
  }

  const next = clone(aggregate);
  next.invocations = {
    ...next.invocations,
    [invocation.id]: clone(invocation) as Invocation,
  } as TaskAggregate["invocations"];
  next.stages = {
    ...next.stages,
    [stage.id]: {
      ...(next.stages[stage.id] as Stage),
      status: stage.status === "pending" ? "active" : stage.status,
      currentExecutionGeneration: invocation.generation,
    },
  } as TaskAggregate["stages"];
  next.task = {
    ...next.task,
    version: next.task.version + 1,
  };
  return { ok: true, value: next };
};

const markInvocationLaunched = (
  aggregate: TaskAggregate,
  command: Extract<DomainCommand, { readonly type: "mark-invocation-launched" }>,
): DomainResult<TaskAggregate> => {
  const invocation = aggregate.invocations[command.invocationId];
  if (!invocation) {
    return authorityError("INVOCATION_NOT_FOUND", `Invocation ${command.invocationId} not found.`);
  }
  if (invocation.status !== "prepared") {
    return authorityError(
      "INVOCATION_STATE_INVALID",
      `Invocation ${invocation.id} cannot be launched from ${invocation.status}.`,
    );
  }

  const next = clone(aggregate);
  next.invocations = {
    ...next.invocations,
    [invocation.id]: { ...(next.invocations[invocation.id] as Invocation), status: "launched" },
  } as TaskAggregate["invocations"];
  return { ok: true, value: next };
};

const recordInvocationResult = (
  aggregate: TaskAggregate,
  command: Extract<DomainCommand, { readonly type: "record-invocation-result" }>,
): DomainResult<TaskAggregate> => {
  const invocation = aggregate.invocations[command.invocationId];
  if (!invocation) {
    return authorityError("INVOCATION_NOT_FOUND", `Invocation ${command.invocationId} not found.`);
  }
  if (
    invocation.status !== "prepared" &&
    invocation.status !== "launched" &&
    invocation.status !== "indeterminate"
  ) {
    return authorityError(
      "INVOCATION_STATE_INVALID",
      `Invocation ${invocation.id} is in terminal status ${invocation.status} and cannot record another result.`,
    );
  }
  if (invocation.status === "indeterminate" && command.result.kind === "indeterminate") {
    return authorityError(
      "INVOCATION_STATE_INVALID",
      `Invocation ${invocation.id} is already indeterminate; it can only resolve to a final result.`,
    );
  }

  const next = clone(aggregate);
  const result = command.result;
  if (result.kind === "succeeded") {
    next.invocations = {
      ...next.invocations,
      [invocation.id]: {
        ...(next.invocations[invocation.id] as Invocation),
        status: "succeeded",
        proposal: result.proposal,
      },
    } as TaskAggregate["invocations"];
  } else if (result.kind === "failed") {
    next.invocations = {
      ...next.invocations,
      [invocation.id]: {
        ...(next.invocations[invocation.id] as Invocation),
        status: "failed",
        failure: result.failure,
      },
    } as TaskAggregate["invocations"];
  } else if (result.kind === "indeterminate") {
    next.invocations = {
      ...next.invocations,
      [invocation.id]: {
        ...(next.invocations[invocation.id] as Invocation),
        status: "indeterminate",
      },
    } as TaskAggregate["invocations"];
  } else {
    next.invocations = {
      ...next.invocations,
      [invocation.id]: { ...(next.invocations[invocation.id] as Invocation), status: "cancelled" },
    } as TaskAggregate["invocations"];
  }
  return { ok: true, value: next };
};

const acceptInvocationProposal = (
  aggregate: TaskAggregate,
  command: Extract<AuthorityCommand, { readonly type: "accept-invocation-proposal" }>,
): DomainResult<TaskAggregate> => {
  const activeError = requireActiveTask(aggregate);
  if (activeError) return activeError;

  const invocation = aggregate.invocations[command.invocationId];
  if (!invocation) {
    return authorityError("INVOCATION_NOT_FOUND", `Invocation ${command.invocationId} not found.`);
  }
  const stage = aggregate.stages[invocation.stageId];
  if (!stage) {
    return authorityError(
      "STAGE_NOT_FOUND",
      `Invocation ${invocation.id} references unknown stage ${invocation.stageId}.`,
    );
  }
  if (invocation.taskId !== aggregate.task.id || stage.taskId !== aggregate.task.id) {
    return authorityError(
      "ENTITY_TASK_MISMATCH",
      "Invocation or stage does not belong to the aggregate task.",
    );
  }
  if (invocation.proposalDisposition.kind !== "unresolved") {
    return authorityError(
      "INVOCATION_PROPOSAL_ALREADY_RESOLVED",
      `Invocation ${invocation.id} proposal disposition is already terminal.`,
    );
  }
  if (stage.status !== "active") {
    return authorityError(
      "STAGE_NOT_ACTIVE",
      `Stage ${stage.id} must be active before accepting an invocation proposal.`,
    );
  }
  if (invocation.status !== "succeeded") {
    return authorityError(
      "INVOCATION_STATE_INVALID",
      `Invocation ${invocation.id} must be succeeded before its proposal can be accepted.`,
    );
  }
  if (invocation.generation !== stage.currentExecutionGeneration) {
    return authorityError(
      "INVOCATION_GENERATION_STALE",
      `Invocation ${invocation.id} generation ${invocation.generation} is stale; current stage generation is ${stage.currentExecutionGeneration}.`,
    );
  }

  const outcome = command.outcome;
  const next = clone(aggregate);

  if (outcome.kind === "succeeded") {
    if (stage.role !== "work") {
      return authorityError(
        "STAGE_ROLE_MISMATCH",
        `A succeeded completion is only valid for a work stage, not ${stage.role}.`,
      );
    }
    const completion = { kind: "succeeded" } as const;
    next.invocations = {
      ...next.invocations,
      [invocation.id]: {
        ...(next.invocations[invocation.id] as Invocation),
        proposalDisposition: { kind: "accepted", completion },
      },
    } as TaskAggregate["invocations"];
    next.stages = {
      ...next.stages,
      [stage.id]: {
        ...(next.stages[stage.id] as Stage),
        status: "completed",
        completion,
      },
    } as TaskAggregate["stages"];
  } else if (outcome.kind === "candidate") {
    if (stage.role !== "proposal") {
      return authorityError(
        "STAGE_ROLE_MISMATCH",
        `A candidate completion is only valid for a proposal stage, not ${stage.role}.`,
      );
    }
    const candidate = outcome.candidate;
    const candidateError = validateCandidateProposal(aggregate, invocation, stage, candidate);
    if (candidateError) return candidateError;

    const completion = {
      kind: "candidate",
      ref: candidate.id,
    } as const;
    next.candidates = {
      ...next.candidates,
      [candidate.id]: clone(candidate) as Candidate,
    } as TaskAggregate["candidates"];
    next.invocations = {
      ...next.invocations,
      [invocation.id]: {
        ...(next.invocations[invocation.id] as Invocation),
        proposalDisposition: { kind: "accepted", completion },
      },
    } as TaskAggregate["invocations"];
    next.stages = {
      ...next.stages,
      [stage.id]: {
        ...(next.stages[stage.id] as Stage),
        status: "completed",
        completion,
      },
    } as TaskAggregate["stages"];
  } else {
    if (stage.role !== "evaluation") {
      return authorityError(
        "STAGE_ROLE_MISMATCH",
        `A review completion is only valid for an evaluation stage, not ${stage.role}.`,
      );
    }
    const review = outcome.review;
    const reviewError = validateInvocationReview(aggregate, invocation, stage, review);
    if (reviewError) return reviewError;

    const completion = {
      kind: "review",
      ref: review.id,
    } as const;
    next.reviews = {
      ...next.reviews,
      [review.id]: clone(review) as Review,
    } as TaskAggregate["reviews"];
    next.invocations = {
      ...next.invocations,
      [invocation.id]: {
        ...(next.invocations[invocation.id] as Invocation),
        proposalDisposition: { kind: "accepted", completion },
      },
    } as TaskAggregate["invocations"];
    next.stages = {
      ...next.stages,
      [stage.id]: {
        ...(next.stages[stage.id] as Stage),
        status: "completed",
        completion,
      },
    } as TaskAggregate["stages"];
  }

  next.task = {
    ...next.task,
    version: next.task.version + 1,
  };
  return { ok: true, value: next };
};

const validateCandidateProposal = (
  aggregate: TaskAggregate,
  invocation: Invocation,
  stage: Stage,
  candidate: Candidate,
): DomainResult<TaskAggregate> | undefined => {
  if (aggregate.candidates[candidate.id]) {
    return authorityError("CANDIDATE_ALREADY_EXISTS", `Candidate ${candidate.id} already exists.`);
  }
  if (candidate.taskId !== aggregate.task.id) {
    return authorityError(
      "CANDIDATE_TASK_MISMATCH",
      `Candidate ${candidate.id} does not belong to task ${aggregate.task.id}.`,
    );
  }
  if (candidate.producedByInvocationId !== invocation.id) {
    return authorityError(
      "INVOCATION_PROPOSAL_MISMATCH",
      `Candidate ${candidate.id} must be produced by invocation ${invocation.id}.`,
    );
  }
  if (
    candidate.derivedFromCandidateId &&
    !candidateExists(aggregate, candidate.derivedFromCandidateId, aggregate.task.id)
  ) {
    return authorityError(
      "CANDIDATE_NOT_FOUND",
      `Candidate ${candidate.id} references unknown derivedFromCandidate ${candidate.derivedFromCandidateId}.`,
    );
  }
  if (!isScopeRefAuthorized(candidate.scopeRef, aggregate.task.authorityScope)) {
    return authorityError(
      "CANDIDATE_SCOPE_NOT_AUTHORIZED",
      `Candidate ${candidate.id} scope ${candidate.scopeRef} exceeds task authorityScope.`,
    );
  }
  if (!isScopeRefAuthorized(candidate.scopeRef, stage.allowedScope)) {
    return authorityError(
      "CANDIDATE_SCOPE_NOT_AUTHORIZED",
      `Candidate ${candidate.id} scope ${candidate.scopeRef} exceeds the producing stage allowedScope.`,
    );
  }
  return undefined;
};

const validateInvocationReview = (
  aggregate: TaskAggregate,
  invocation: Invocation,
  stage: Stage,
  review: Review,
): DomainResult<TaskAggregate> | undefined => {
  if (aggregate.reviews[review.id]) {
    return authorityError("REVIEW_ALREADY_EXISTS", `Review ${review.id} already exists.`);
  }
  if (review.taskId !== aggregate.task.id) {
    return authorityError(
      "REVIEW_TASK_MISMATCH",
      `Review ${review.id} does not belong to task ${aggregate.task.id}.`,
    );
  }
  if (review.stageId !== stage.id) {
    return authorityError(
      "REVIEW_STAGE_MISMATCH",
      `Review ${review.id} must be bound to stage ${stage.id}.`,
    );
  }
  const frozenCandidateId = getFrozenCandidateId(stage);
  if (!frozenCandidateId || review.candidateId !== frozenCandidateId) {
    return authorityError(
      "REVIEW_CANDIDATE_MISMATCH",
      `Review ${review.id} must bind the exact candidate frozen in stage ${stage.id}.`,
    );
  }
  if (!candidateExists(aggregate, review.candidateId, aggregate.task.id)) {
    return authorityError(
      "CANDIDATE_NOT_FOUND",
      `Review ${review.id} references unknown candidate ${review.candidateId}.`,
    );
  }
  if (review.evidence.length === 0) {
    return authorityError(
      "REVIEW_EVIDENCE_INVALID",
      `Review ${review.id} must include at least one evidence artifact.`,
    );
  }
  if (
    review.decisionProvenance.kind !== "invocation" ||
    review.decisionProvenance.invocationId !== invocation.id
  ) {
    return authorityError(
      "REVIEW_PROVENANCE_INVALID",
      `Review ${review.id} must be provenance-bound to invocation ${invocation.id}.`,
    );
  }
  return undefined;
};

const submitExternalReview = (
  aggregate: TaskAggregate,
  command: Extract<AuthorityCommand, { readonly type: "submit-external-review" }>,
): DomainResult<TaskAggregate> => {
  const activeError = requireActiveTask(aggregate);
  if (activeError) return activeError;

  const review = command.review;
  if (aggregate.reviews[review.id]) {
    return authorityError("REVIEW_ALREADY_EXISTS", `Review ${review.id} already exists.`);
  }
  if (review.taskId !== aggregate.task.id) {
    return authorityError(
      "REVIEW_TASK_MISMATCH",
      `Review ${review.id} does not belong to task ${aggregate.task.id}.`,
    );
  }
  const stage = aggregate.stages[review.stageId];
  if (!stage) {
    return authorityError(
      "STAGE_NOT_FOUND",
      `Review ${review.id} references unknown stage ${review.stageId}.`,
    );
  }
  if (stage.taskId !== aggregate.task.id) {
    return authorityError(
      "ENTITY_TASK_MISMATCH",
      `Review ${review.id} references a stage from another task.`,
    );
  }
  if (stage.role !== "evaluation") {
    return authorityError(
      "STAGE_ROLE_MISMATCH",
      `External review ${review.id} can only complete an evaluation stage.`,
    );
  }
  if (stage.status !== "active") {
    return authorityError(
      "STAGE_NOT_ACTIVE",
      `Stage ${stage.id} must be active before an external review can complete it.`,
    );
  }
  if (review.decisionProvenance.kind !== "actor") {
    return authorityError(
      "REVIEW_PROVENANCE_INVALID",
      `External review ${review.id} must use actor provenance.`,
    );
  }
  const frozenCandidateId = getFrozenCandidateId(stage);
  if (!frozenCandidateId || review.candidateId !== frozenCandidateId) {
    return authorityError(
      "REVIEW_CANDIDATE_MISMATCH",
      `Review ${review.id} must bind the exact candidate frozen in stage ${stage.id}.`,
    );
  }
  if (!candidateExists(aggregate, review.candidateId, aggregate.task.id)) {
    return authorityError(
      "CANDIDATE_NOT_FOUND",
      `Review ${review.id} references unknown candidate ${review.candidateId}.`,
    );
  }
  const authorityRequirement = getUniqueAuthorityRequirement(stage);
  if (!authorityRequirement) {
    return authorityError(
      "REVIEW_TARGET_MISMATCH",
      `Review ${review.id} target stage ${stage.id} must freeze exactly one authority-requirement descriptor.`,
    );
  }
  if (!deepEqual(review.authorityRequirement, authorityRequirement)) {
    return authorityError(
      "REVIEW_AUTHORITY_REQUIREMENT_MISMATCH",
      `Review ${review.id} authority requirement does not match the unique frozen requirement on stage ${stage.id}.`,
    );
  }
  if (review.evidence.length === 0) {
    return authorityError(
      "REVIEW_EVIDENCE_INVALID",
      `Review ${review.id} must include at least one evidence artifact.`,
    );
  }

  const next = clone(aggregate);
  next.reviews = {
    ...next.reviews,
    [review.id]: clone(review) as Review,
  } as TaskAggregate["reviews"];
  next.stages = {
    ...next.stages,
    [stage.id]: {
      ...(next.stages[stage.id] as Stage),
      status: "completed",
      completion: { kind: "review", ref: review.id },
    },
  } as TaskAggregate["stages"];
  next.task = {
    ...next.task,
    version: next.task.version + 1,
  };
  return { ok: true, value: next };
};

const createApproval = (
  aggregate: TaskAggregate,
  command: Extract<AuthorityCommand, { readonly type: "create-approval" }>,
): DomainResult<TaskAggregate> => {
  const activeError = requireActiveTask(aggregate);
  if (activeError) return activeError;

  const approval = command.approval;
  if (aggregate.approvals[approval.id]) {
    return authorityError("APPROVAL_ALREADY_EXISTS", `Approval ${approval.id} already exists.`);
  }
  if (approval.taskId !== aggregate.task.id) {
    return authorityError(
      "APPROVAL_TASK_MISMATCH",
      `Approval ${approval.id} does not belong to task ${aggregate.task.id}.`,
    );
  }
  if (!candidateExists(aggregate, approval.candidateId, aggregate.task.id)) {
    return authorityError(
      "CANDIDATE_NOT_FOUND",
      `Approval ${approval.id} references unknown candidate ${approval.candidateId}.`,
    );
  }
  if (approval.policyIdentity !== aggregate.task.policySnapshot.identity) {
    return authorityError(
      "APPROVAL_POLICY_MISMATCH",
      `Approval ${approval.id} policy identity does not match the frozen task policy.`,
    );
  }
  if (approval.evidenceReviewIds.length === 0) {
    return authorityError(
      "APPROVAL_EVIDENCE_INVALID",
      `Approval ${approval.id} must reference at least one review.`,
    );
  }
  for (const reviewId of approval.evidenceReviewIds) {
    const review = aggregate.reviews[reviewId];
    if (!review || review.taskId !== aggregate.task.id) {
      return authorityError(
        "REVIEW_NOT_FOUND",
        `Approval ${approval.id} references unknown review ${reviewId}.`,
      );
    }
    if (review.candidateId !== approval.candidateId) {
      return authorityError(
        "APPROVAL_EVIDENCE_INVALID",
        `Approval ${approval.id} review ${reviewId} is not for candidate ${approval.candidateId}.`,
      );
    }
  }
  if (
    approval.decisionProvenance.kind === "policy" &&
    approval.decisionProvenance.policyIdentity !== approval.policyIdentity
  ) {
    return authorityError(
      "APPROVAL_POLICY_MISMATCH",
      `Approval ${approval.id} decision provenance policy does not match its policy identity.`,
    );
  }

  const next = clone(aggregate);
  next.approvals = {
    ...next.approvals,
    [approval.id]: clone(approval) as Approval,
  } as TaskAggregate["approvals"];
  next.task = {
    ...next.task,
    version: next.task.version + 1,
  };
  return { ok: true, value: next };
};

const invalidateApproval = (
  aggregate: TaskAggregate,
  command: Extract<AuthorityCommand, { readonly type: "invalidate-approval" }>,
): DomainResult<TaskAggregate> => {
  const activeError = requireActiveTask(aggregate);
  if (activeError) return activeError;

  const approval = aggregate.approvals[command.approvalId];
  if (!approval) {
    return authorityError("APPROVAL_NOT_FOUND", `Approval ${command.approvalId} not found.`);
  }
  if (approval.taskId !== aggregate.task.id) {
    return authorityError(
      "APPROVAL_TASK_MISMATCH",
      `Approval ${approval.id} does not belong to task ${aggregate.task.id}.`,
    );
  }
  if (command.reason.kind !== "approval-invalidation") {
    return authorityError(
      "INVALID_COMMAND",
      "Invalidation reason must use kind approval-invalidation.",
    );
  }
  if (aggregate.authority.ineffectiveApprovalIds.includes(approval.id)) {
    return authorityError(
      "APPROVAL_ALREADY_INEFFECTIVE",
      `Approval ${approval.id} is already ineffective.`,
    );
  }

  const next = clone(aggregate);
  next.authority = {
    ...next.authority,
    ineffectiveApprovalIds: [...next.authority.ineffectiveApprovalIds, approval.id],
  };
  next.task = {
    ...next.task,
    version: next.task.version + 1,
  };
  return { ok: true, value: next };
};

const prepareOperation = (
  aggregate: TaskAggregate,
  command: Extract<AuthorityCommand, { readonly type: "prepare-operation" }>,
): DomainResult<TaskAggregate> => {
  const activeError = requireActiveTask(aggregate);
  if (activeError) return activeError;

  const operation = command.operation;
  if (aggregate.operations[operation.id]) {
    return authorityError("OPERATION_ALREADY_EXISTS", `Operation ${operation.id} already exists.`);
  }
  if (operation.taskId !== aggregate.task.id) {
    return authorityError(
      "OPERATION_TASK_MISMATCH",
      `Operation ${operation.id} does not belong to task ${aggregate.task.id}.`,
    );
  }
  const stage = aggregate.stages[operation.stageId];
  if (!stage) {
    return authorityError(
      "STAGE_NOT_FOUND",
      `Operation ${operation.id} references unknown stage ${operation.stageId}.`,
    );
  }
  if (stage.taskId !== aggregate.task.id) {
    return authorityError(
      "ENTITY_TASK_MISMATCH",
      `Operation ${operation.id} references a stage from another task.`,
    );
  }
  if (stage.role !== "effect") {
    return authorityError(
      "STAGE_ROLE_MISMATCH",
      `Operation ${operation.id} can only be prepared for an effect stage.`,
    );
  }
  if (stage.status === "completed" || stage.status === "failed" || stage.status === "cancelled") {
    return authorityError(
      "STAGE_NOT_ACTIVE",
      `Stage ${stage.id} is closed and cannot host a new operation.`,
    );
  }
  if (
    Object.values(aggregate.operations).some((existing) => existing.stageId === operation.stageId)
  ) {
    return authorityError(
      "OPERATION_INTENT_ALREADY_PREPARED",
      `Effect stage ${stage.id} already has a prepared Operation; unchanged intent must reuse the original Operation.`,
    );
  }

  const candidateRefs = getSemanticRefsByType(stage, "candidate");
  const approvalRefs = getSemanticRefsByType(stage, "approval");
  if (candidateRefs.length !== 1 || approvalRefs.length !== 1) {
    return authorityError(
      "OPERATION_STAGE_BINDING_MISMATCH",
      `Effect stage ${stage.id} must freeze exactly one candidate and one approval reference.`,
    );
  }

  const frozenCandidateId = candidateRefs[0] as Candidate["id"];
  const frozenApprovalId = approvalRefs[0] as Approval["id"];
  const frozenApproval = aggregate.approvals[frozenApprovalId];
  if (!frozenApproval || frozenApproval.candidateId !== frozenCandidateId) {
    return authorityError(
      "OPERATION_STAGE_BINDING_MISMATCH",
      `Effect stage ${stage.id} does not bind an approval for its frozen candidate.`,
    );
  }
  if (operation.candidateId !== frozenCandidateId || operation.approvalId !== frozenApprovalId) {
    return authorityError(
      "OPERATION_STAGE_BINDING_MISMATCH",
      `Operation ${operation.id} does not match effect stage ${stage.id} frozen candidate/approval references.`,
    );
  }

  if (operation.status !== "prepared") {
    return authorityError(
      "OPERATION_STATE_INVALID",
      `Operation ${operation.id} must be created in prepared status.`,
    );
  }
  const candidate = aggregate.candidates[operation.candidateId];
  if (!candidate || candidate.taskId !== aggregate.task.id) {
    return authorityError(
      "CANDIDATE_NOT_FOUND",
      `Operation ${operation.id} references unknown candidate ${operation.candidateId}.`,
    );
  }
  const approval = aggregate.approvals[operation.approvalId];
  if (!approval || approval.taskId !== aggregate.task.id) {
    return authorityError(
      "APPROVAL_NOT_FOUND",
      `Operation ${operation.id} references unknown approval ${operation.approvalId}.`,
    );
  }
  if (!isApprovalEffective(aggregate, operation.approvalId)) {
    return authorityError(
      "APPROVAL_NOT_EFFECTIVE",
      `Operation ${operation.id} cannot be prepared under ineffective approval ${operation.approvalId}.`,
    );
  }
  if (approval.candidateId !== operation.candidateId) {
    return authorityError(
      "APPROVAL_CANDIDATE_MISMATCH",
      `Operation ${operation.id} approval ${operation.approvalId} is not for candidate ${operation.candidateId}.`,
    );
  }
  if (
    !isScopeRefAuthorized(operation.targetScopeRef, aggregate.task.authorityScope) ||
    !isScopeRefAuthorized(operation.targetScopeRef, stage.allowedScope)
  ) {
    return authorityError(
      "SCOPE_NOT_AUTHORIZED",
      `Operation ${operation.id} target scope ${operation.targetScopeRef} is not authorized.`,
    );
  }
  if (
    Object.values(aggregate.operations).some(
      (existing) => existing.effectKey === operation.effectKey && existing.id !== operation.id,
    )
  ) {
    return authorityError(
      "OPERATION_EFFECT_KEY_DUPLICATE",
      `Operation effectKey ${operation.effectKey} is already used by another operation; unchanged intent must reuse the original operation.`,
    );
  }

  const next = clone(aggregate);
  next.operations = {
    ...next.operations,
    [operation.id]: clone(operation) as Operation,
  } as TaskAggregate["operations"];
  next.stages = {
    ...next.stages,
    [stage.id]: {
      ...(next.stages[stage.id] as Stage),
      status: stage.status === "pending" ? "active" : stage.status,
    },
  } as TaskAggregate["stages"];
  next.task = {
    ...next.task,
    version: next.task.version + 1,
  };
  return { ok: true, value: next };
};

const dispatchOperation = (
  aggregate: TaskAggregate,
  command: Extract<AuthorityCommand, { readonly type: "dispatch-operation" }>,
): DomainResult<TaskAggregate> => {
  const activeError = requireActiveTask(aggregate);
  if (activeError) return activeError;

  const operation = aggregate.operations[command.operationId];
  if (!operation) {
    return authorityError("OPERATION_NOT_FOUND", `Operation ${command.operationId} not found.`);
  }
  if (operation.taskId !== aggregate.task.id) {
    return authorityError(
      "OPERATION_TASK_MISMATCH",
      `Operation ${operation.id} does not belong to task ${aggregate.task.id}.`,
    );
  }
  if (operation.status !== "prepared") {
    return authorityError(
      "OPERATION_DISPATCH_FORBIDDEN",
      `Operation ${operation.id} cannot be dispatched from ${operation.status}.`,
    );
  }
  const approval = aggregate.approvals[operation.approvalId];
  if (!approval || approval.taskId !== aggregate.task.id) {
    return authorityError(
      "APPROVAL_NOT_FOUND",
      `Operation ${operation.id} references unknown approval ${operation.approvalId}.`,
    );
  }
  if (!isApprovalEffective(aggregate, operation.approvalId)) {
    return authorityError(
      "APPROVAL_NOT_EFFECTIVE",
      `Operation ${operation.id} cannot dispatch because approval ${operation.approvalId} is ineffective.`,
    );
  }
  if (approval.candidateId !== operation.candidateId) {
    return authorityError(
      "APPROVAL_CANDIDATE_MISMATCH",
      `Operation ${operation.id} approval ${operation.approvalId} does not match candidate ${operation.candidateId}.`,
    );
  }
  const candidate = aggregate.candidates[operation.candidateId];
  if (!candidate || candidate.taskId !== aggregate.task.id) {
    return authorityError(
      "CANDIDATE_NOT_FOUND",
      `Operation ${operation.id} references unknown candidate ${operation.candidateId}.`,
    );
  }

  const next = clone(aggregate);
  next.operations = {
    ...next.operations,
    [operation.id]: { ...(next.operations[operation.id] as Operation), status: "dispatched" },
  } as TaskAggregate["operations"];
  next.task = {
    ...next.task,
    version: next.task.version + 1,
  };
  return { ok: true, value: next };
};

const abortOperation = (
  aggregate: TaskAggregate,
  command: Extract<AuthorityCommand, { readonly type: "abort-operation" }>,
): DomainResult<TaskAggregate> => {
  const activeError = requireActiveTask(aggregate);
  if (activeError) return activeError;

  const operation = aggregate.operations[command.operationId];
  if (!operation) {
    return authorityError("OPERATION_NOT_FOUND", `Operation ${command.operationId} not found.`);
  }
  if (operation.taskId !== aggregate.task.id) {
    return authorityError(
      "OPERATION_TASK_MISMATCH",
      `Operation ${operation.id} does not belong to task ${aggregate.task.id}.`,
    );
  }
  if (operation.status !== "prepared") {
    return authorityError(
      "OPERATION_ABORT_FORBIDDEN",
      `Operation ${operation.id} cannot be aborted from ${operation.status}.`,
    );
  }
  if (command.reason.kind !== "operation-abort") {
    return authorityError("INVALID_COMMAND", "Abort reason must use kind operation-abort.");
  }

  const next = clone(aggregate);
  next.operations = {
    ...next.operations,
    [operation.id]: {
      ...(next.operations[operation.id] as Operation),
      status: "aborted",
      abortReason: command.reason,
    },
  } as TaskAggregate["operations"];
  next.task = {
    ...next.task,
    version: next.task.version + 1,
  };
  return { ok: true, value: next };
};

const reconcileOperation = (
  aggregate: TaskAggregate,
  command: Extract<AuthorityCommand, { readonly type: "reconcile-operation" }>,
): DomainResult<TaskAggregate> => {
  const operation = aggregate.operations[command.operationId];
  if (!operation) {
    return authorityError("OPERATION_NOT_FOUND", `Operation ${command.operationId} not found.`);
  }
  if (operation.taskId !== aggregate.task.id) {
    return authorityError(
      "OPERATION_TASK_MISMATCH",
      `Operation ${operation.id} does not belong to task ${aggregate.task.id}.`,
    );
  }
  if (operation.status !== "dispatched" && operation.status !== "indeterminate") {
    return authorityError(
      "OPERATION_RECONCILE_INVALID",
      `Operation ${operation.id} cannot be reconciled from ${operation.status}.`,
    );
  }

  const stage = aggregate.stages[operation.stageId];
  const resolution = command.resolution;
  if (
    (resolution.kind === "confirmed" || resolution.kind === "not-applied") &&
    !resolution.evidence
  ) {
    return authorityError(
      "OPERATION_RECONCILE_INVALID",
      `Operation ${operation.id} ${resolution.kind} reconciliation requires immutable evidence.`,
    );
  }

  const next = clone(aggregate);

  if (resolution.kind === "confirmed") {
    next.operations = {
      ...next.operations,
      [operation.id]: {
        ...(next.operations[operation.id] as Operation),
        status: "confirmed",
        confirmation: resolution.evidence,
      },
    } as TaskAggregate["operations"];
    if (
      stage &&
      stage.role === "effect" &&
      (stage.status === "pending" || stage.status === "active")
    ) {
      next.stages = {
        ...next.stages,
        [stage.id]: {
          ...(next.stages[stage.id] as Stage),
          status: "completed",
          completion: { kind: "operation", ref: operation.id },
        },
      } as TaskAggregate["stages"];
    }
  } else if (resolution.kind === "not-applied") {
    next.operations = {
      ...next.operations,
      [operation.id]: { ...(next.operations[operation.id] as Operation), status: "prepared" },
    } as TaskAggregate["operations"];
  } else {
    next.operations = {
      ...next.operations,
      [operation.id]: { ...(next.operations[operation.id] as Operation), status: "indeterminate" },
    } as TaskAggregate["operations"];
  }

  next.task = {
    ...next.task,
    version: next.task.version + 1,
  };
  return { ok: true, value: next };
};

const completeTask = (
  aggregate: TaskAggregate,
  command: Extract<AuthorityCommand, { readonly type: "complete-task" }>,
): DomainResult<TaskAggregate> => {
  const activeError = requireActiveTask(aggregate);
  if (activeError) return activeError;
  if (hasOpenStages(aggregate)) {
    return authorityError(
      "STAGE_NOT_ACTIVE",
      "Task cannot be completed while stages are still pending or active.",
    );
  }
  if (command.completion.kind !== "task-completion") {
    return authorityError(
      "INVALID_COMMAND",
      "Task completion descriptor must use kind task-completion.",
    );
  }

  const next = clone(aggregate);
  next.task = {
    ...next.task,
    status: "completed",
    completion: command.completion,
    version: next.task.version + 1,
  };
  return { ok: true, value: next };
};

const failTask = (
  aggregate: TaskAggregate,
  command: Extract<AuthorityCommand, { readonly type: "fail-task" }>,
): DomainResult<TaskAggregate> => {
  const activeError = requireActiveTask(aggregate);
  if (activeError) return activeError;
  if (command.failure.kind !== "task-failure") {
    return authorityError("INVALID_COMMAND", "Task failure descriptor must use kind task-failure.");
  }

  const next = clone(aggregate);
  next.task = {
    ...next.task,
    status: "failed",
    failure: command.failure,
    version: next.task.version + 1,
  };
  return { ok: true, value: next };
};

const cancelTask = (
  aggregate: TaskAggregate,
  command: Extract<AuthorityCommand, { readonly type: "cancel-task" }>,
): DomainResult<TaskAggregate> => {
  const activeError = requireActiveTask(aggregate);
  if (activeError) return activeError;
  if (command.cancellation.kind !== "task-cancellation") {
    return authorityError(
      "INVALID_COMMAND",
      "Task cancellation descriptor must use kind task-cancellation.",
    );
  }

  const openStages = Object.values(aggregate.stages).filter(
    (stage) => stage.status === "pending" || stage.status === "active",
  );
  const preparedOperations = Object.values(aggregate.operations).filter(
    (operation) => operation.status === "prepared",
  );

  const stageCancellations = command.stageCancellations;
  if (stageCancellations.length !== openStages.length) {
    return authorityError(
      "INVALID_COMMAND",
      `Task cancellation requires one stage-cancellation descriptor for each open stage (${openStages.length}), got ${stageCancellations.length}.`,
    );
  }
  const stageIds = new Set(openStages.map((stage) => stage.id));
  for (const descriptor of stageCancellations) {
    const target = descriptor.value.stageId as string | undefined;
    if (
      typeof target !== "string" ||
      !stageIds.has(target as Stage["id"]) ||
      descriptor.value.taskId !== aggregate.task.id ||
      descriptor.value.taskCancellationIdentity !== command.cancellation.identity
    ) {
      return authorityError(
        "INVALID_COMMAND",
        `Task cancellation stage descriptor for ${target ?? "unknown"} does not match the current open stage set or cancellation identity.`,
      );
    }
  }
  if (
    new Set(stageCancellations.map((descriptor) => descriptor.value.stageId as string)).size !==
    stageCancellations.length
  ) {
    return authorityError(
      "INVALID_COMMAND",
      "Task cancellation stage descriptors must not contain duplicates.",
    );
  }

  const operationAborts = command.operationAborts;
  if (operationAborts.length !== preparedOperations.length) {
    return authorityError(
      "INVALID_COMMAND",
      `Task cancellation requires one operation-abort descriptor for each prepared operation (${preparedOperations.length}), got ${operationAborts.length}.`,
    );
  }
  const operationIds = new Set(preparedOperations.map((operation) => operation.id));
  for (const descriptor of operationAborts) {
    const target = descriptor.value.operationId as string | undefined;
    if (
      typeof target !== "string" ||
      !operationIds.has(target as Operation["id"]) ||
      descriptor.value.taskId !== aggregate.task.id ||
      descriptor.value.taskCancellationIdentity !== command.cancellation.identity
    ) {
      return authorityError(
        "INVALID_COMMAND",
        `Task cancellation operation descriptor for ${target ?? "unknown"} does not match the current prepared operation set or cancellation identity.`,
      );
    }
  }
  if (
    new Set(operationAborts.map((descriptor) => descriptor.value.operationId as string)).size !==
    operationAborts.length
  ) {
    return authorityError(
      "INVALID_COMMAND",
      "Task cancellation operation descriptors must not contain duplicates.",
    );
  }

  const next = clone(aggregate);
  const stages = Object.fromEntries(
    Object.values(next.stages).map((stage) => {
      if (stage.status !== "pending" && stage.status !== "active") {
        return [stage.id, stage];
      }
      const cancellation = stageCancellations.find(
        (descriptor) => descriptor.value.stageId === stage.id,
      );
      return [
        stage.id,
        {
          ...(next.stages[stage.id] as Stage),
          status: "cancelled",
          cancellation: cancellation as FrozenDescriptor<"stage-cancellation">,
          currentExecutionGeneration: stage.currentExecutionGeneration + 1,
        },
      ];
    }),
  ) as TaskAggregate["stages"];
  next.stages = stages;

  const operations = Object.fromEntries(
    Object.values(next.operations).map((operation) => {
      if (operation.status !== "prepared") {
        return [operation.id, operation];
      }
      const abortReason = operationAborts.find(
        (descriptor) => descriptor.value.operationId === operation.id,
      );
      return [
        operation.id,
        {
          ...(next.operations[operation.id] as Operation),
          status: "aborted",
          abortReason: abortReason as FrozenDescriptor<"operation-abort">,
        },
      ];
    }),
  ) as TaskAggregate["operations"];
  next.operations = operations;

  next.task = {
    ...next.task,
    status: "cancelled",
    cancellation: command.cancellation,
    version: next.task.version + 1,
  };
  return { ok: true, value: next };
};

export const applyDomainCommand = (
  aggregate: TaskAggregate,
  command: DomainCommand,
): DomainResult<TaskAggregate> => {
  switch (command.type) {
    case "materialize-stage":
      return materializeStage(aggregate, command);
    case "prepare-invocation":
      return prepareInvocation(aggregate, command);
    case "mark-invocation-launched":
      return markInvocationLaunched(aggregate, command);
    case "record-invocation-result":
      return recordInvocationResult(aggregate, command);
    case "accept-invocation-proposal":
      return acceptInvocationProposal(aggregate, command);
    case "submit-external-review":
      return submitExternalReview(aggregate, command);
    case "create-approval":
      return createApproval(aggregate, command);
    case "invalidate-approval":
      return invalidateApproval(aggregate, command);
    case "prepare-operation":
      return prepareOperation(aggregate, command);
    case "dispatch-operation":
      return dispatchOperation(aggregate, command);
    case "abort-operation":
      return abortOperation(aggregate, command);
    case "reconcile-operation":
      return reconcileOperation(aggregate, command);
    case "complete-task":
      return completeTask(aggregate, command);
    case "fail-task":
      return failTask(aggregate, command);
    case "cancel-task":
      return cancelTask(aggregate, command);
  }
};
