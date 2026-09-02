import { applyDomainCommand } from "@dsh-tempera/domain";
import type {
  AuthorityCommand,
  DomainRejectionCode,
  JsonObject,
  TaskAggregate,
  TaskId,
} from "@dsh-tempera/domain";
import { sha256Fingerprint } from "./canonical";
import type { TaskSnapshot } from "./codec";
import { AuthorityStoreError } from "./errors";
import { assertJsonValue } from "./json";
import { domainRejectionCodes } from "./rejection-codes";
import type { AuthorityStore, ExecuteTaskCommandInput, ResultCodec, TaskDecision } from "./store";

export type RuntimeAuthorityCommand = Exclude<
  AuthorityCommand,
  { readonly type: "submit-external-review" } | { readonly type: "cancel-task" }
>;

export type RuntimeRequestId = string & { readonly __brand?: "RuntimeRequestId" };

export interface RuntimeCommandEnvelope<
  C extends RuntimeAuthorityCommand = RuntimeAuthorityCommand,
> {
  readonly contractVersion: "tempera.runtime-command.v1";
  readonly requestId: RuntimeRequestId;
  readonly taskId: TaskId;
  readonly expectedVersion: number;
  readonly command: C;
}

export type RuntimeRejectionCode = "TASK_NOT_FOUND" | "TASK_VERSION_CONFLICT" | DomainRejectionCode;

export type RuntimeCommandResult =
  | {
      readonly kind: "committed";
      readonly taskId: TaskId;
      readonly committedVersion: number;
    }
  | {
      readonly kind: "accepted-no-write";
      readonly taskId: TaskId;
      readonly observedVersion: number;
    }
  | {
      readonly kind: "rejected";
      readonly taskId: TaskId;
      readonly code: RuntimeRejectionCode;
      readonly expectedVersion?: number;
      readonly observedVersion?: number;
    };

export interface RuntimeCommandResponse {
  readonly delivery: "first-observation" | "replay";
  readonly result: RuntimeCommandResult;
}
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const runtimeCommandTypes = new Set([
  "materialize-stage",
  "prepare-invocation",
  "accept-invocation-proposal",
  "create-approval",
  "invalidate-approval",
  "prepare-operation",
  "dispatch-operation",
  "abort-operation",
  "reconcile-operation",
  "complete-task",
  "fail-task",
]);
const runtimeRejectionCodes = new Set<string>([
  "TASK_NOT_FOUND",
  "TASK_VERSION_CONFLICT",
  ...domainRejectionCodes,
]);

const hasOnlyKeys = (record: Record<string, unknown>, allowed: readonly string[]): boolean => {
  const actual = Object.keys(record).sort();
  const expected = [...allowed].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};

const validateEnvelope = (envelope: unknown): RuntimeCommandEnvelope => {
  if (!isRecord(envelope)) {
    throw new TypeError("Runtime command envelope must be an object");
  }
  try {
    assertJsonValue(envelope, "Runtime command envelope must be plain JSON");
  } catch {
    throw new TypeError("Runtime command envelope is not JSON-safe");
  }
  const record = envelope as Record<string, unknown>;
  if (
    !hasOnlyKeys(record, ["contractVersion", "requestId", "taskId", "expectedVersion", "command"])
  ) {
    throw new TypeError("Runtime command envelope has unknown fields");
  }
  if (record.contractVersion !== "tempera.runtime-command.v1") {
    throw new TypeError("Unsupported runtime command contract version");
  }
  if (
    typeof record.requestId !== "string" ||
    record.requestId.length === 0 ||
    !record.requestId.startsWith("tempera:")
  ) {
    throw new TypeError("Runtime requestId must use the reserved tempera: namespace");
  }
  if (typeof record.taskId !== "string" || record.taskId.length === 0) {
    throw new TypeError("Runtime taskId must be a non-empty string");
  }
  if (!Number.isInteger(record.expectedVersion) || (record.expectedVersion as number) <= 0) {
    throw new TypeError("expectedVersion must be a positive integer");
  }
  if (
    !isRecord(record.command) ||
    typeof record.command.type !== "string" ||
    !runtimeCommandTypes.has(record.command.type)
  ) {
    throw new TypeError("Runtime command is not in the internal authority union");
  }
  try {
    assertJsonValue(record.command, "Runtime command must be plain JSON");
  } catch {
    throw new TypeError("Runtime command is not JSON-safe");
  }
  return envelope as unknown as RuntimeCommandEnvelope;
};
const committed = (taskId: TaskId, committedVersion: number): RuntimeCommandResult => ({
  kind: "committed",
  taskId,
  committedVersion,
});

const rejected = (
  taskId: TaskId,
  code: RuntimeRejectionCode,
  expectedVersion?: number,
  observedVersion?: number,
): RuntimeCommandResult => ({
  kind: "rejected",
  taskId,
  code,
  ...(expectedVersion !== undefined ? { expectedVersion } : {}),
  ...(observedVersion !== undefined ? { observedVersion } : {}),
});

const runtimeResultCodec: ResultCodec<RuntimeCommandResult> = {
  encode: (result) => {
    assertJsonValue(result, "Runtime result must be JSON-safe");
    return result as unknown as JsonObject;
  },
  decode: (value: unknown): RuntimeCommandResult => {
    if (!isRecord(value) || typeof value.kind !== "string") {
      throw new Error("Invalid runtime result");
    }
    const record = value as Record<string, unknown>;
    if (record.kind === "committed") {
      if (
        !hasOnlyKeys(record, ["kind", "taskId", "committedVersion"]) ||
        typeof record.taskId !== "string" ||
        record.taskId.length === 0 ||
        !Number.isInteger(record.committedVersion) ||
        (record.committedVersion as number) <= 0
      ) {
        throw new Error("Invalid committed runtime result");
      }
      return value as unknown as RuntimeCommandResult;
    }
    if (record.kind === "accepted-no-write") {
      if (
        !hasOnlyKeys(record, ["kind", "taskId", "observedVersion"]) ||
        typeof record.taskId !== "string" ||
        record.taskId.length === 0 ||
        !Number.isInteger(record.observedVersion) ||
        (record.observedVersion as number) <= 0
      ) {
        throw new Error("Invalid accepted-no-write runtime result");
      }
      return value as unknown as RuntimeCommandResult;
    }
    if (record.kind === "rejected") {
      if (
        typeof record.taskId !== "string" ||
        record.taskId.length === 0 ||
        typeof record.code !== "string" ||
        !runtimeRejectionCodes.has(record.code)
      ) {
        throw new Error("Invalid rejected runtime result");
      }
      const code = record.code;
      if (code === "TASK_VERSION_CONFLICT") {
        if (
          !hasOnlyKeys(record, ["kind", "taskId", "code", "expectedVersion", "observedVersion"]) ||
          !Number.isInteger(record.expectedVersion) ||
          (record.expectedVersion as number) <= 0 ||
          !Number.isInteger(record.observedVersion) ||
          (record.observedVersion as number) <= 0
        ) {
          throw new Error("Invalid TASK_VERSION_CONFLICT runtime result");
        }
      } else if (
        !hasOnlyKeys(record, ["kind", "taskId", "code"]) ||
        "expectedVersion" in record ||
        "observedVersion" in record
      ) {
        throw new Error(`Invalid ${code} runtime result`);
      }
      return value as unknown as RuntimeCommandResult;
    }
    throw new Error(`Unknown runtime result kind ${record.kind}`);
  },
};
const makeRuntimeResultCodec = (expectedTaskId: TaskId): ResultCodec<RuntimeCommandResult> => ({
  encode: runtimeResultCodec.encode,
  decode: (value) => {
    const result = runtimeResultCodec.decode(value);
    if (result.taskId !== expectedTaskId) {
      throw new Error("Stored runtime result task ID does not match the envelope target");
    }
    return result;
  },
});

const encodeRuntimeAuthorityFacts = (
  command: RuntimeAuthorityCommand,
  _previous: TaskAggregate,
  next: TaskAggregate,
): JsonObject[] => {
  const taskId = next.task.id;
  switch (command.type) {
    case "materialize-stage":
      return [
        {
          type: "stage-materialized",
          taskId,
          stageId: command.stage.id,
          version: next.task.version,
        },
      ];
    case "prepare-invocation":
      return [
        {
          type: "invocation-prepared",
          taskId,
          invocationId: command.invocation.id,
          version: next.task.version,
        },
      ];
    case "accept-invocation-proposal":
      return [
        {
          type: "invocation-proposal-accepted",
          taskId,
          invocationId: command.invocationId,
          version: next.task.version,
        },
      ];
    case "create-approval":
      return [
        {
          type: "approval-created",
          taskId,
          approvalId: command.approval.id,
          version: next.task.version,
        },
      ];
    case "invalidate-approval":
      return [
        {
          type: "approval-invalidated",
          taskId,
          approvalId: command.approvalId,
          version: next.task.version,
        },
      ];
    case "prepare-operation":
      return [
        {
          type: "operation-prepared",
          taskId,
          operationId: command.operation.id,
          version: next.task.version,
        },
      ];
    case "dispatch-operation":
      return [
        {
          type: "operation-dispatched",
          taskId,
          operationId: command.operationId,
          version: next.task.version,
        },
      ];
    case "abort-operation":
      return [
        {
          type: "operation-aborted",
          taskId,
          operationId: command.operationId,
          version: next.task.version,
        },
      ];
    case "reconcile-operation":
      return [
        {
          type: "operation-reconciled",
          taskId,
          operationId: command.operationId,
          version: next.task.version,
        },
      ];
    case "complete-task":
      return [{ type: "task-completed", taskId, version: next.task.version }];
    case "fail-task":
      return [{ type: "task-failed", taskId, version: next.task.version }];
    default: {
      const exhaustive: never = command;
      throw new Error(
        `Unhandled runtime command ${String((exhaustive as { type?: unknown }).type)}`,
      );
    }
  }
};
const mapPreconditionFailure = (
  failure: {
    kind: "task-not-found" | "version-conflict" | "create-conflict";
    taskId: TaskId;
    expectedVersion: number;
    observedVersion?: number;
  },
  taskId: TaskId,
): RuntimeCommandResult => {
  if (failure.kind === "task-not-found") {
    return rejected(taskId, "TASK_NOT_FOUND");
  }
  if (failure.kind === "version-conflict") {
    return rejected(
      taskId,
      "TASK_VERSION_CONFLICT",
      failure.expectedVersion,
      failure.observedVersion,
    );
  }
  throw new Error(
    "Internal invariant failure: create-conflict is unreachable for runtime commands",
  );
};

export const executeRuntimeCommand = (
  store: AuthorityStore,
  envelope: RuntimeCommandEnvelope,
): RuntimeCommandResponse => {
  const validated = validateEnvelope(envelope);
  const requestId = validated.requestId;
  const taskId = validated.taskId;
  const payloadFingerprint = sha256Fingerprint({
    contractVersion: validated.contractVersion,
    expectedVersion: validated.expectedVersion,
    command: validated.command,
  });

  const input: ExecuteTaskCommandInput<RuntimeCommandResult> = {
    requestId,
    payloadFingerprint,
    taskId,
    expectedVersion: validated.expectedVersion,
    resultCodec: makeRuntimeResultCodec(taskId),
    onPreconditionFailure: (failure) => mapPreconditionFailure(failure, taskId),
  };

  try {
    return store.executeTaskCommand(input, (snapshot: TaskSnapshot | undefined) =>
      decideRuntime(validated.command, snapshot, taskId),
    );
  } catch (error) {
    if (error instanceof AuthorityStoreError && error.code === "REQUEST_ID_REUSE_MISMATCH") {
      throw new TypeError("Runtime request ID reuse mismatch");
    }
    throw error;
  }
};

const decideRuntime = (
  command: RuntimeAuthorityCommand,
  snapshot: TaskSnapshot | undefined,
  taskId: TaskId,
): TaskDecision<RuntimeCommandResult> => {
  if (!snapshot) {
    return {
      kind: "no-write",
      result: rejected(taskId, "TASK_NOT_FOUND"),
    };
  }
  const result = applyDomainCommand(snapshot.aggregate, command);
  if (!result.ok) {
    return {
      kind: "no-write",
      result: rejected(taskId, result.error.code),
    };
  }
  return {
    kind: "commit",
    nextAggregate: result.value,
    facts: encodeRuntimeAuthorityFacts(command, snapshot.aggregate, result.value),
    result: committed(taskId, result.value.task.version),
  };
};
