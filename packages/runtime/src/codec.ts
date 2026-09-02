import { z } from "zod";
import type { JsonObject, JsonValue, TaskAggregate, TaskStatus } from "@dsh-tempera/domain";
import { AuthorityStoreError } from "./errors";
import { assertJsonObject, deepFreeze } from "./json";

export const aggregateSchemaVersion = 1 as const;

const finiteNumber = z.number().refine((value) => Number.isFinite(value), {
  message: "number must be finite",
});

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    finiteNumber,
    z.string(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

const jsonObjectSchema = z.record(z.string(), jsonValueSchema) as z.ZodType<JsonObject>;

const descriptorSchema = (kind: string) =>
  z
    .object({
      kind: z.literal(kind),
      contractVersion: z.string(),
      identity: z.string(),
      value: jsonObjectSchema,
    })
    .strict();

const frozenDescriptorSchema = z
  .object({
    kind: z.string(),
    contractVersion: z.string(),
    identity: z.string(),
    value: jsonObjectSchema,
  })
  .strict();

const taskCreationDescriptorSchema = descriptorSchema("task-creation");
const taskPolicyDescriptorSchema = descriptorSchema("task-policy");
const taskCompletionDescriptorSchema = descriptorSchema("task-completion");
const taskFailureDescriptorSchema = descriptorSchema("task-failure");
const taskCancellationDescriptorSchema = descriptorSchema("task-cancellation");
const realizationRequirementDescriptorSchema = descriptorSchema("realization-requirement");
const stageFailureDescriptorSchema = descriptorSchema("stage-failure");
const stageCancellationDescriptorSchema = descriptorSchema("stage-cancellation");
const realizerBindingDescriptorSchema = descriptorSchema("realizer-binding");
const invocationFailureDescriptorSchema = descriptorSchema("invocation-failure");
const candidatePreconditionDescriptorSchema = descriptorSchema("candidate-precondition");
const authorityRequirementDescriptorSchema = descriptorSchema("authority-requirement");
const effectPreconditionDescriptorSchema = descriptorSchema("effect-precondition");
const operationAbortDescriptorSchema = descriptorSchema("operation-abort");

const artifactBindingSchema = z
  .object({
    ref: z.string(),
    integrity: z.string(),
    mediaKind: z.string().optional(),
  })
  .strict();

const scopeGrantSchema = z
  .object({
    scopeRef: z.string(),
    actions: z.array(z.string()),
  })
  .strict();

const authorityScopeSchema = z
  .object({
    grants: z.array(scopeGrantSchema),
  })
  .strict();

const semanticEntityRefSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("task"), id: z.string() }).strict(),
  z.object({ type: z.literal("stage"), id: z.string() }).strict(),
  z.object({ type: z.literal("candidate"), id: z.string() }).strict(),
  z.object({ type: z.literal("review"), id: z.string() }).strict(),
  z.object({ type: z.literal("approval"), id: z.string() }).strict(),
  z.object({ type: z.literal("operation"), id: z.string() }).strict(),
]);

const semanticInputSchema = z
  .object({
    name: z.string(),
    value: z.union([semanticEntityRefSchema, frozenDescriptorSchema]),
  })
  .strict();

const stageCompletionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("candidate"), ref: z.string() }).strict(),
  z.object({ kind: z.literal("review"), ref: z.string() }).strict(),
  z.object({ kind: z.literal("operation"), ref: z.string() }).strict(),
  z.object({ kind: z.literal("succeeded") }).strict(),
]);

const commonTaskFields = {
  id: z.string(),
  version: finiteNumber.refine((value) => Number.isInteger(value) && value >= 1, {
    message: "Task version must be a positive integer",
  }),
  creationSpec: taskCreationDescriptorSchema,
  policySnapshot: taskPolicyDescriptorSchema,
  authorityScope: authorityScopeSchema,
};

const taskSchema = z.discriminatedUnion("status", [
  z.object({ ...commonTaskFields, status: z.literal("active") }).strict(),
  z
    .object({
      ...commonTaskFields,
      status: z.literal("completed"),
      completion: taskCompletionDescriptorSchema,
    })
    .strict(),
  z
    .object({
      ...commonTaskFields,
      status: z.literal("failed"),
      failure: taskFailureDescriptorSchema,
    })
    .strict(),
  z
    .object({
      ...commonTaskFields,
      status: z.literal("cancelled"),
      cancellation: taskCancellationDescriptorSchema,
    })
    .strict(),
]);

const commonStageFields = {
  id: z.string(),
  taskId: z.string(),
  role: z.enum(["work", "proposal", "evaluation", "effect"]),
  kind: z.string(),
  contractVersion: z.string(),
  materializationKey: z.string(),
  semanticInputs: z.array(semanticInputSchema),
  realizationRequirement: realizationRequirementDescriptorSchema,
  allowedScope: authorityScopeSchema,
  currentExecutionGeneration: finiteNumber.refine(
    (value) => Number.isInteger(value) && value >= 0,
    {
      message: "Stage generation must be a non-negative integer",
    },
  ),
};

const stageSchema = z.union([
  z
    .object({
      ...commonStageFields,
      status: z.union([z.literal("pending"), z.literal("active")]),
    })
    .strict(),
  z
    .object({
      ...commonStageFields,
      status: z.literal("completed"),
      completion: stageCompletionSchema,
    })
    .strict(),
  z
    .object({
      ...commonStageFields,
      status: z.literal("failed"),
      failure: stageFailureDescriptorSchema,
    })
    .strict(),
  z
    .object({
      ...commonStageFields,
      status: z.literal("cancelled"),
      cancellation: stageCancellationDescriptorSchema,
    })
    .strict(),
]);

const proposalDispositionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("unresolved") }).strict(),
  z
    .object({
      kind: z.literal("accepted"),
      completion: stageCompletionSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("rejected"),
      reason: z.enum(["stale-generation", "integrity", "task-state", "invalid-outcome"]),
    })
    .strict(),
]);

const invocationSchema = z
  .object({
    id: z.string(),
    taskId: z.string(),
    stageId: z.string(),
    generation: finiteNumber.refine((value) => Number.isInteger(value) && value >= 0, {
      message: "Invocation generation must be a non-negative integer",
    }),
    launchKey: z.string(),
    realizerBinding: realizerBindingDescriptorSchema,
    status: z.enum(["prepared", "launched", "succeeded", "failed", "indeterminate", "cancelled"]),
    proposal: artifactBindingSchema.optional(),
    proposalDisposition: proposalDispositionSchema,
    failure: invocationFailureDescriptorSchema.optional(),
  })
  .strict();

const candidateSchema = z
  .object({
    id: z.string(),
    taskId: z.string(),
    producedByInvocationId: z.string(),
    derivedFromCandidateId: z.string().optional(),
    artifact: artifactBindingSchema,
    scopeRef: z.string(),
    precondition: candidatePreconditionDescriptorSchema.optional(),
  })
  .strict();

const reviewProvenanceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("invocation"), invocationId: z.string() }).strict(),
  z
    .object({
      kind: z.literal("actor"),
      actorRef: z.string(),
    })
    .strict(),
]);

const reviewSchema = z
  .object({
    id: z.string(),
    taskId: z.string(),
    stageId: z.string(),
    candidateId: z.string(),
    authorityRequirement: authorityRequirementDescriptorSchema,
    disposition: z.enum(["pass", "needs_changes", "reject", "abstain"]),
    evidence: z.array(artifactBindingSchema).min(1),
    decisionProvenance: reviewProvenanceSchema,
  })
  .strict();

const approvalProvenanceSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("policy"),
      policyIdentity: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("actor"),
      actorRef: z.string(),
      authorityRequirement: authorityRequirementDescriptorSchema,
    })
    .strict(),
]);

const approvalSchema = z
  .object({
    id: z.string(),
    taskId: z.string(),
    candidateId: z.string(),
    policyIdentity: z.string(),
    evidenceReviewIds: z.array(z.string()).min(1),
    decisionProvenance: approvalProvenanceSchema,
  })
  .strict();

const commonOperationFields = {
  id: z.string(),
  taskId: z.string(),
  stageId: z.string(),
  candidateId: z.string(),
  approvalId: z.string(),
  targetScopeRef: z.string(),
  precondition: effectPreconditionDescriptorSchema,
  effectKey: z.string(),
};

const operationSchema = z.union([
  z
    .object({
      ...commonOperationFields,
      status: z.enum(["prepared", "dispatched", "indeterminate"]),
    })
    .strict(),
  z
    .object({
      ...commonOperationFields,
      status: z.literal("confirmed"),
      confirmation: artifactBindingSchema,
    })
    .strict(),
  z
    .object({
      ...commonOperationFields,
      status: z.literal("aborted"),
      abortReason: operationAbortDescriptorSchema,
    })
    .strict(),
]);

const authorityProjectionSchema = z
  .object({
    ineffectiveApprovalIds: z.array(z.string()),
  })
  .strict();

const taskAggregateSchema = z
  .object({
    task: taskSchema,
    stages: z.record(z.string(), stageSchema),
    invocations: z.record(z.string(), invocationSchema),
    candidates: z.record(z.string(), candidateSchema),
    reviews: z.record(z.string(), reviewSchema),
    approvals: z.record(z.string(), approvalSchema),
    operations: z.record(z.string(), operationSchema),
    authority: authorityProjectionSchema,
  })
  .strict();

const validateAggregateInvariants = (aggregate: TaskAggregate): void => {
  const taskId = aggregate.task.id;

  const assertKeyMatches = <T extends { id: string }>(
    table: Readonly<Record<string, T>>,
    label: string,
  ): void => {
    for (const [key, entity] of Object.entries(table)) {
      if (entity.id !== key) {
        throw new AuthorityStoreError(
          "CORRUPT_DATA",
          `${label} key "${key}" does not match entity id "${entity.id}"`,
        );
      }
    }
  };

  assertKeyMatches(aggregate.stages, "stages");
  assertKeyMatches(aggregate.invocations, "invocations");
  assertKeyMatches(aggregate.candidates, "candidates");
  assertKeyMatches(aggregate.reviews, "reviews");
  assertKeyMatches(aggregate.approvals, "approvals");
  assertKeyMatches(aggregate.operations, "operations");

  const assertTaskOwnership = <T extends { taskId: string }>(
    table: Readonly<Record<string, T>>,
    label: string,
  ): void => {
    for (const entity of Object.values(table)) {
      if (entity.taskId !== taskId) {
        throw new AuthorityStoreError(
          "CORRUPT_DATA",
          `${label} entity ${entity.taskId} does not belong to task ${taskId}`,
        );
      }
    }
  };

  assertTaskOwnership(aggregate.stages, "stages");
  assertTaskOwnership(aggregate.invocations, "invocations");
  assertTaskOwnership(aggregate.candidates, "candidates");
  assertTaskOwnership(aggregate.reviews, "reviews");
  assertTaskOwnership(aggregate.approvals, "approvals");
  assertTaskOwnership(aggregate.operations, "operations");
};

const codecs: Record<number, { decode: (json: unknown) => TaskAggregate }> = {
  [aggregateSchemaVersion]: {
    decode: (json: unknown): TaskAggregate => {
      const result = taskAggregateSchema.safeParse(json);
      if (!result.success) {
        throw new AuthorityStoreError(
          "CORRUPT_DATA",
          `TaskAggregate v1 validation failed: ${result.error.message}`,
        );
      }
      const aggregate = result.data as unknown as TaskAggregate;
      validateAggregateInvariants(aggregate);
      return deepFreeze(aggregate);
    },
  },
};

export interface TaskSnapshot {
  readonly aggregate: TaskAggregate;
  readonly aggregateSchemaVersion: number;
  readonly observedVersion: number;
}

export interface StoredTaskSnapshotRow {
  readonly task_id: string;
  readonly version: number;
  readonly status: string;
  readonly aggregate_schema_version: number;
  readonly aggregate_json: string;
}

export const decodeTaskAggregate = (
  aggregateSchemaVersionToDecode: number,
  json: unknown,
): TaskAggregate => {
  const codec = codecs[aggregateSchemaVersionToDecode];
  if (!codec) {
    throw new AuthorityStoreError(
      "CORRUPT_DATA",
      `Unsupported aggregate schema version ${aggregateSchemaVersionToDecode}`,
    );
  }
  return codec.decode(json);
};

export const decodeStoredTaskSnapshot = (row: StoredTaskSnapshotRow): TaskSnapshot => {
  if (row.aggregate_schema_version !== aggregateSchemaVersion) {
    throw new AuthorityStoreError(
      "CORRUPT_DATA",
      `Unsupported aggregate schema version ${row.aggregate_schema_version}`,
    );
  }

  let aggregate: TaskAggregate;
  try {
    aggregate = decodeTaskAggregate(row.aggregate_schema_version, JSON.parse(row.aggregate_json));
  } catch (error) {
    if (error instanceof AuthorityStoreError) {
      throw error;
    }
    throw new AuthorityStoreError(
      "CORRUPT_DATA",
      `Task snapshot JSON is corrupt: ${String(error)}`,
    );
  }

  if (
    aggregate.task.id !== row.task_id ||
    aggregate.task.version !== row.version ||
    aggregate.task.status !== row.status
  ) {
    throw new AuthorityStoreError(
      "CORRUPT_DATA",
      `Task snapshot metadata does not match aggregate for task ${row.task_id}`,
    );
  }

  return {
    aggregate,
    aggregateSchemaVersion: aggregateSchemaVersion,
    observedVersion: row.version,
  };
};

export const encodeTaskAggregate = (aggregate: TaskAggregate): string => {
  assertJsonObject(aggregate as unknown as JsonObject, "TaskAggregate is not JSON-safe");
  const json = JSON.stringify(aggregate);
  const reparsed: unknown = JSON.parse(json);
  decodeTaskAggregate(aggregateSchemaVersion, reparsed);
  return json;
};

export const validateTaskAggregate = (aggregate: TaskAggregate): void => {
  encodeTaskAggregate(aggregate);
};

export const taskStatusSchema = z.enum(["active", "completed", "failed", "cancelled"]);

export const isTaskStatus = (value: string): value is TaskStatus =>
  taskStatusSchema.safeParse(value).success;

export type { TaskStatus };
