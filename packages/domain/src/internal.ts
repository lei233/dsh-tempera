import type {
  Approval,
  AuthorityScope,
  CandidateId,
  ScopeRef,
  SemanticInput,
  Stage,
  TaskAggregate,
} from "./types";

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

export const clone = <T>(value: T): Mutable<T> => JSON.parse(JSON.stringify(value)) as Mutable<T>;

export const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const deepEqual = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

export const isScopeWithin = (child: AuthorityScope, parent: AuthorityScope): boolean =>
  child.grants.every((childGrant) => {
    const parentGrant = parent.grants.find((grant) => grant.scopeRef === childGrant.scopeRef);
    if (!parentGrant) {
      return false;
    }
    return childGrant.actions.every((action) => parentGrant.actions.includes(action));
  });

export const isScopeRefAuthorized = (scopeRef: ScopeRef, authority: AuthorityScope): boolean =>
  authority.grants.some((grant) => grant.scopeRef === scopeRef && grant.actions.length > 0);

export const getFrozenCandidateId = (stage: Stage): CandidateId | undefined => {
  for (const input of stage.semanticInputs) {
    const value = input.value;
    if (isObject(value) && value.type === "candidate") {
      return value.id as CandidateId;
    }
  }
  return undefined;
};

export const getFrozenSemanticEntityIds = (
  inputs: readonly SemanticInput[],
): ReadonlyArray<{ readonly type: string; readonly id: string }> => {
  const ids: Array<{ readonly type: string; readonly id: string }> = [];
  for (const input of inputs) {
    const value = input.value;
    if (isObject(value) && typeof value.type === "string" && typeof value.id === "string") {
      ids.push({ type: value.type, id: value.id });
    }
  }
  return ids;
};

export const getSemanticRefsByType = (stage: Stage, type: string): readonly string[] =>
  getFrozenSemanticEntityIds(stage.semanticInputs)
    .filter((ref) => ref.type === type)
    .map((ref) => ref.id);

export const candidateExists = (
  aggregate: TaskAggregate,
  candidateId: CandidateId,
  taskId: string,
): boolean => {
  const candidate = aggregate.candidates[candidateId];
  return candidate !== undefined && candidate.taskId === taskId;
};

export const reviewExists = (
  aggregate: TaskAggregate,
  reviewId: string,
  taskId: string,
): boolean => {
  const review = aggregate.reviews[reviewId as keyof TaskAggregate["reviews"]];
  return review !== undefined && review.taskId === taskId;
};

export const approvalExists = (
  aggregate: TaskAggregate,
  approvalId: string,
  taskId: string,
): boolean => {
  const approval = aggregate.approvals[approvalId as keyof TaskAggregate["approvals"]];
  return approval !== undefined && approval.taskId === taskId;
};

export const isApprovalEffective = (aggregate: TaskAggregate, approvalId: string): boolean =>
  !aggregate.authority.ineffectiveApprovalIds.includes(approvalId as Approval["id"]);

export const hasOpenStages = (aggregate: TaskAggregate): boolean =>
  Object.values(aggregate.stages).some(
    (stage) => stage.status === "pending" || stage.status === "active",
  );
