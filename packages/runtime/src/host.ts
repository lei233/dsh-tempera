import { applyDomainCommand, createTask } from "@dsh-tempera/domain";
import type {
  ActorRef,
  ArtifactBinding,
  AuthorityScope,
  Brand,
  CandidateId,
  DescriptorIdentity,
  DomainRejection,
  FrozenDescriptor,
  JsonObject,
  OperationId,
  ReviewDisposition,
  StageId,
  TaskAggregate,
  TaskId,
  TaskStatus,
  ReviewId,
} from "@dsh-tempera/domain";
import { canonicalJson, identityFromCanonical, sha256Fingerprint } from "./canonical";
import { AuthorityStoreError } from "./errors";
import { assertJsonValue } from "./json";
import { domainRejectionCodes } from "./rejection-codes";
import type { TaskSnapshot } from "./codec";
import type {
  AuthorityCommit,
  AuthorityStore,
  ExecuteTaskCommandInput,
  ResultCodec,
  TaskCommandResponse,
  TaskDecision,
  TaskSummary,
} from "./store";

export type HostRequestId = Brand<string, "HostRequestId">;

export type HostCommand =
  | {
      readonly type: "create-task";
      readonly creationSpec: FrozenDescriptor<"task-creation">;
      readonly policySnapshot: FrozenDescriptor<"task-policy">;
      readonly authorityScope: AuthorityScope;
    }
  | {
      readonly type: "submit-external-review";
      readonly taskId: TaskId;
      readonly stageId: StageId;
      readonly candidateId: CandidateId;
      readonly actorRef: ActorRef;
      readonly disposition: ReviewDisposition;
      readonly evidence: readonly [ArtifactBinding, ...ArtifactBinding[]];
    }
  | {
      readonly type: "cancel-task";
      readonly taskId: TaskId;
      readonly actorRef: ActorRef;
      readonly cancellation: FrozenDescriptor<"task-cancellation">;
    }
  | {
      readonly type: "request-operation-reconciliation";
      readonly taskId: TaskId;
      readonly operationId: OperationId;
      readonly actorRef: ActorRef;
    };

export interface HostCommandEnvelope<C extends HostCommand = HostCommand> {
  readonly contractVersion: "tempera.host-command.v1";
  readonly requestId: HostRequestId;
  readonly expectedVersion: number;
  readonly command: C;
}

export type HostCommittedOutcome = "task-created" | "external-review-recorded" | "task-cancelled";

export type HostRejectionCode =
  | "TASK_ID_CONFLICT"
  | "TASK_NOT_FOUND"
  | "TASK_VERSION_CONFLICT"
  | "TASK_NOT_ACTIVE"
  | "HOST_REVIEW_NOT_EXPECTED"
  | "REVIEW_TARGET_MISMATCH"
  | "REVIEW_EVIDENCE_INVALID"
  | "OPERATION_NOT_INDETERMINATE"
  | "COMMAND_REJECTED";

export type DurableHostCommandResult =
  | {
      readonly kind: "committed";
      readonly requestId: HostRequestId;
      readonly taskId: TaskId;
      readonly committedVersion: number;
      readonly outcome: HostCommittedOutcome;
    }
  | {
      readonly kind: "accepted-no-write";
      readonly requestId: HostRequestId;
      readonly taskId: TaskId;
      readonly observedVersion: number;
      readonly outcome: "reconciliation-required";
    }
  | {
      readonly kind: "rejected";
      readonly requestId: HostRequestId;
      readonly code: HostRejectionCode;
      readonly taskId?: TaskId;
      readonly observedVersion?: number;
      readonly details?: JsonObject;
    };

export interface HostCommandResponse {
  readonly delivery: "first-observation" | "replay";
  readonly result: DurableHostCommandResult;
}

export type HostCommandProtocolErrorCode =
  | "UNSUPPORTED_CONTRACT_VERSION"
  | "INVALID_REQUEST_ID"
  | "INVALID_EXPECTED_VERSION"
  | "MALFORMED_COMMAND"
  | "NON_CANONICAL_OR_NON_JSON_PAYLOAD"
  | "REQUEST_ID_REUSE_MISMATCH";

export class HostCommandProtocolError extends Error {
  readonly code: HostCommandProtocolErrorCode;

  constructor(code: HostCommandProtocolErrorCode, message: string) {
    super(message);
    this.name = "HostCommandProtocolError";
    this.code = code;
  }
}

export type HostQueryProtocolErrorCode =
  | "MALFORMED_CURSOR"
  | "CURSOR_QUERY_MISMATCH"
  | "INVALID_STATUS"
  | "INVALID_LIMIT";

export class HostQueryProtocolError extends Error {
  readonly code: HostQueryProtocolErrorCode;

  constructor(code: HostQueryProtocolErrorCode, message: string) {
    super(message);
    this.name = "HostQueryProtocolError";
    this.code = code;
  }
}

export interface HostListTasksOptions {
  readonly status?: TaskStatus;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface HostAuthorityHistoryOptions {
  readonly cursor?: string;
  readonly limit?: number;
}

export type GetTaskResult =
  | {
      readonly kind: "found";
      readonly taskId: TaskId;
      readonly observedVersion: number;
      readonly aggregateSchemaVersion: number;
      readonly aggregate: TaskAggregate;
    }
  | {
      readonly kind: "task-not-found";
      readonly taskId: TaskId;
    };

export interface ListTasksResult {
  readonly items: TaskSummary[];
  readonly nextCursor?: string;
}

export interface AuthorityHistoryItem extends AuthorityCommit {}

export type GetAuthorityHistoryResult =
  | {
      readonly kind: "found";
      readonly taskId: TaskId;
      readonly observedVersion: number;
      readonly items: AuthorityHistoryItem[];
      readonly nextCursor?: string;
    }
  | {
      readonly kind: "task-not-found";
      readonly taskId: TaskId;
    };

export interface HostIdFactory {
  readonly taskId: () => TaskId;
  readonly reviewId: () => ReviewId;
}

export type ReconciliationNotifier = (taskId: TaskId, operationId: OperationId) => void;

export interface HostApplication {
  execute<C extends HostCommand>(envelope: HostCommandEnvelope<C>): HostCommandResponse;
  getTask(taskId: TaskId): GetTaskResult;
  listTasks(options?: HostListTasksOptions): ListTasksResult;
  getAuthorityHistory(
    taskId: TaskId,
    options?: HostAuthorityHistoryOptions,
  ): GetAuthorityHistoryResult;
  close(): void;
}
const CURSOR_VERSION = "v1";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

const isFrozenDescriptor = <K extends string>(
  value: unknown,
  kind: K,
): value is FrozenDescriptor<K> =>
  isRecord(value) &&
  hasOnlyKeys(value, ["kind", "contractVersion", "identity", "value"]) &&
  value.kind === kind &&
  typeof value.contractVersion === "string" &&
  typeof value.identity === "string" &&
  isRecord(value.value);

const isArtifactBinding = (value: unknown): value is ArtifactBinding =>
  isRecord(value) &&
  hasOnlyAllowedKeys(value, ["ref", "integrity", "mediaKind"]) &&
  typeof value.ref === "string" &&
  typeof value.integrity === "string" &&
  (value.mediaKind === undefined || typeof value.mediaKind === "string");

const isAuthorityScope = (value: unknown): value is AuthorityScope =>
  isRecord(value) &&
  hasOnlyKeys(value, ["grants"]) &&
  Array.isArray(value.grants) &&
  value.grants.every(
    (grant) =>
      isRecord(grant) &&
      hasOnlyKeys(grant, ["scopeRef", "actions"]) &&
      typeof grant.scopeRef === "string" &&
      Array.isArray(grant.actions) &&
      grant.actions.every((action) => typeof action === "string"),
  );

const isReviewDisposition = (value: unknown): value is ReviewDisposition =>
  value === "pass" || value === "needs_changes" || value === "reject" || value === "abstain";
const hasOnlyKeys = (record: Record<string, unknown>, allowed: readonly string[]): boolean => {
  const actual = Object.keys(record).sort();
  const expected = [...allowed].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};
const hasOnlyAllowedKeys = (record: Record<string, unknown>, allowed: readonly string[]): boolean =>
  Object.keys(record).every((key) => allowed.includes(key));

const isValidEvidence = (
  evidence: unknown,
): evidence is readonly [ArtifactBinding, ...ArtifactBinding[]] =>
  Array.isArray(evidence) &&
  evidence.length > 0 &&
  evidence.every((item) => isArtifactBinding(item));
const validateEnvelope = (envelope: unknown): HostCommandEnvelope => {
  if (!isRecord(envelope)) {
    throw new HostCommandProtocolError(
      "MALFORMED_COMMAND",
      "Host command envelope must be an object",
    );
  }
  try {
    assertJsonValue(envelope, "Host command envelope must be a plain JSON value");
  } catch {
    throw new HostCommandProtocolError(
      "NON_CANONICAL_OR_NON_JSON_PAYLOAD",
      "Host command envelope contains non-JSON or non-canonical values",
    );
  }
  const record = envelope as Record<string, unknown>;
  if (!hasOnlyKeys(record, ["contractVersion", "requestId", "expectedVersion", "command"])) {
    throw new HostCommandProtocolError(
      "MALFORMED_COMMAND",
      "Host command envelope has unknown fields",
    );
  }
  if (record.contractVersion !== "tempera.host-command.v1") {
    throw new HostCommandProtocolError(
      "UNSUPPORTED_CONTRACT_VERSION",
      `Unsupported Host contract version ${String(record.contractVersion)}`,
    );
  }
  if (
    typeof record.requestId !== "string" ||
    record.requestId.length === 0 ||
    record.requestId.startsWith("tempera:")
  ) {
    throw new HostCommandProtocolError(
      "INVALID_REQUEST_ID",
      "Host requestId must be a non-empty string without the reserved tempera: prefix",
    );
  }
  if (!Number.isInteger(record.expectedVersion) || (record.expectedVersion as number) < 0) {
    throw new HostCommandProtocolError(
      "INVALID_EXPECTED_VERSION",
      "expectedVersion must be a non-negative integer",
    );
  }
  if (!isRecord(record.command)) {
    throw new HostCommandProtocolError("MALFORMED_COMMAND", "Host command must be an object");
  }

  const command = record.command;
  switch (command.type) {
    case "create-task": {
      if (record.expectedVersion !== 0) {
        throw new HostCommandProtocolError(
          "INVALID_EXPECTED_VERSION",
          "create-task requires expectedVersion 0",
        );
      }
      if (
        !hasOnlyKeys(command, ["type", "creationSpec", "policySnapshot", "authorityScope"]) ||
        !isFrozenDescriptor(command.creationSpec, "task-creation") ||
        !isFrozenDescriptor(command.policySnapshot, "task-policy") ||
        !isAuthorityScope(command.authorityScope)
      ) {
        throw new HostCommandProtocolError(
          "MALFORMED_COMMAND",
          "create-task command has invalid fields",
        );
      }
      break;
    }
    case "submit-external-review": {
      if (!Number.isInteger(record.expectedVersion) || (record.expectedVersion as number) <= 0) {
        throw new HostCommandProtocolError(
          "INVALID_EXPECTED_VERSION",
          "submit-external-review requires expectedVersion > 0",
        );
      }
      if (
        !hasOnlyAllowedKeys(command, [
          "type",
          "taskId",
          "stageId",
          "candidateId",
          "actorRef",
          "disposition",
          "evidence",
        ]) ||
        !isNonEmptyString(command.taskId) ||
        !isNonEmptyString(command.stageId) ||
        !isNonEmptyString(command.candidateId) ||
        !isNonEmptyString(command.actorRef) ||
        !isReviewDisposition(command.disposition)
      ) {
        throw new HostCommandProtocolError(
          "MALFORMED_COMMAND",
          "submit-external-review command has invalid fields",
        );
      }
      break;
    }
    case "cancel-task": {
      if (!Number.isInteger(record.expectedVersion) || (record.expectedVersion as number) <= 0) {
        throw new HostCommandProtocolError(
          "INVALID_EXPECTED_VERSION",
          "cancel-task requires expectedVersion > 0",
        );
      }
      if (
        !hasOnlyKeys(command, ["type", "taskId", "actorRef", "cancellation"]) ||
        !isNonEmptyString(command.taskId) ||
        !isNonEmptyString(command.actorRef) ||
        !isFrozenDescriptor(command.cancellation, "task-cancellation")
      ) {
        throw new HostCommandProtocolError(
          "MALFORMED_COMMAND",
          "cancel-task command has invalid fields",
        );
      }
      break;
    }
    case "request-operation-reconciliation": {
      if (!Number.isInteger(record.expectedVersion) || (record.expectedVersion as number) <= 0) {
        throw new HostCommandProtocolError(
          "INVALID_EXPECTED_VERSION",
          "request-operation-reconciliation requires expectedVersion > 0",
        );
      }
      if (
        !hasOnlyKeys(command, ["type", "taskId", "operationId", "actorRef"]) ||
        !isNonEmptyString(command.taskId) ||
        !isNonEmptyString(command.operationId) ||
        !isNonEmptyString(command.actorRef)
      ) {
        throw new HostCommandProtocolError(
          "MALFORMED_COMMAND",
          "request-operation-reconciliation command has invalid fields",
        );
      }
      break;
    }
    default:
      throw new HostCommandProtocolError(
        "MALFORMED_COMMAND",
        `Unknown Host command type ${String((command as { type?: unknown }).type)}`,
      );
  }

  try {
    assertJsonValue(command, "Host command must be a plain JSON value");
  } catch {
    throw new HostCommandProtocolError(
      "NON_CANONICAL_OR_NON_JSON_PAYLOAD",
      "Host command contains non-JSON or non-canonical values",
    );
  }

  return envelope as unknown as HostCommandEnvelope;
};
const fingerprintEnvelope = (envelope: HostCommandEnvelope): string => {
  try {
    return sha256Fingerprint({
      contractVersion: envelope.contractVersion,
      expectedVersion: envelope.expectedVersion,
      command: envelope.command,
    });
  } catch {
    throw new HostCommandProtocolError(
      "NON_CANONICAL_OR_NON_JSON_PAYLOAD",
      "Host command cannot be canonically fingerprinted",
    );
  }
};

const committedResult = (
  requestId: HostRequestId,
  taskId: TaskId,
  committedVersion: number,
  outcome: HostCommittedOutcome,
): DurableHostCommandResult => ({
  kind: "committed",
  requestId,
  taskId,
  committedVersion,
  outcome,
});

const acceptedNoWriteResult = (
  requestId: HostRequestId,
  taskId: TaskId,
  observedVersion: number,
): DurableHostCommandResult => ({
  kind: "accepted-no-write",
  requestId,
  taskId,
  observedVersion,
  outcome: "reconciliation-required",
});

const rejectedResult = (
  requestId: HostRequestId,
  code: HostRejectionCode,
  taskId?: TaskId,
  observedVersion?: number,
  details?: JsonObject,
): DurableHostCommandResult => ({
  kind: "rejected",
  requestId,
  code,
  ...(taskId !== undefined ? { taskId } : {}),
  ...(observedVersion !== undefined ? { observedVersion } : {}),
  ...(details !== undefined ? { details } : {}),
});

const hostRejectionCodes = new Set<HostRejectionCode>([
  "TASK_ID_CONFLICT",
  "TASK_NOT_FOUND",
  "TASK_VERSION_CONFLICT",
  "TASK_NOT_ACTIVE",
  "HOST_REVIEW_NOT_EXPECTED",
  "REVIEW_TARGET_MISMATCH",
  "REVIEW_EVIDENCE_INVALID",
  "OPERATION_NOT_INDETERMINATE",
  "COMMAND_REJECTED",
]);

const decodeHostResult = (value: unknown): DurableHostCommandResult => {
  if (!isRecord(value) || typeof value.kind !== "string") {
    throw new Error("Host result must be an object with a kind");
  }
  const record = value as Record<string, unknown>;
  if (record.kind === "committed") {
    if (
      !hasOnlyKeys(record, ["kind", "requestId", "taskId", "committedVersion", "outcome"]) ||
      typeof record.requestId !== "string" ||
      record.requestId.length === 0 ||
      typeof record.taskId !== "string" ||
      record.taskId.length === 0 ||
      !Number.isInteger(record.committedVersion) ||
      (record.committedVersion as number) <= 0 ||
      (record.outcome !== "task-created" &&
        record.outcome !== "external-review-recorded" &&
        record.outcome !== "task-cancelled")
    ) {
      throw new Error("Invalid committed Host result");
    }
    return value as unknown as DurableHostCommandResult;
  }
  if (record.kind === "accepted-no-write") {
    if (
      !hasOnlyKeys(record, ["kind", "requestId", "taskId", "observedVersion", "outcome"]) ||
      typeof record.requestId !== "string" ||
      record.requestId.length === 0 ||
      typeof record.taskId !== "string" ||
      record.taskId.length === 0 ||
      !Number.isInteger(record.observedVersion) ||
      (record.observedVersion as number) <= 0 ||
      record.outcome !== "reconciliation-required"
    ) {
      throw new Error("Invalid accepted-no-write Host result");
    }
    return value as unknown as DurableHostCommandResult;
  }
  if (record.kind === "rejected") {
    const rejectedKeys = ["kind", "requestId", "code", "taskId", "observedVersion", "details"];
    if (
      !Object.keys(record).every((key) => rejectedKeys.includes(key)) ||
      typeof record.requestId !== "string" ||
      record.requestId.length === 0 ||
      record.requestId.startsWith("tempera:") ||
      typeof record.code !== "string" ||
      !hostRejectionCodes.has(record.code as HostRejectionCode)
    ) {
      throw new Error("Invalid rejected Host result");
    }
    const code = record.code as HostRejectionCode;
    const requireTaskOnly = (allowedKeys: readonly string[]): void => {
      if (
        !Object.keys(record).every((key) => allowedKeys.includes(key)) ||
        typeof record.taskId !== "string" ||
        record.taskId.length === 0 ||
        "observedVersion" in record ||
        "details" in record
      ) {
        throw new Error(`Invalid rejected Host result for ${code}`);
      }
    };
    switch (code) {
      case "TASK_ID_CONFLICT":
        if (
          !Object.keys(record).every((key) =>
            ["kind", "requestId", "code", "taskId", "observedVersion", "details"].includes(key),
          ) ||
          typeof record.taskId !== "string" ||
          record.taskId.length === 0 ||
          !Number.isInteger(record.observedVersion) ||
          (record.observedVersion as number) <= 0 ||
          !isRecord(record.details) ||
          !hasOnlyKeys(record.details, ["expectedVersion", "observedVersion"]) ||
          record.details.expectedVersion !== 0 ||
          record.details.observedVersion !== record.observedVersion
        ) {
          throw new Error("Invalid TASK_ID_CONFLICT Host result");
        }
        break;
      case "TASK_VERSION_CONFLICT":
        if (
          !Object.keys(record).every((key) =>
            ["kind", "requestId", "code", "taskId", "observedVersion", "details"].includes(key),
          ) ||
          typeof record.taskId !== "string" ||
          record.taskId.length === 0 ||
          !Number.isInteger(record.observedVersion) ||
          (record.observedVersion as number) <= 0 ||
          !isRecord(record.details) ||
          !hasOnlyKeys(record.details, ["expectedVersion", "observedVersion"]) ||
          !Number.isInteger(record.details.expectedVersion) ||
          (record.details.expectedVersion as number) <= 0 ||
          record.details.observedVersion !== record.observedVersion
        ) {
          throw new Error("Invalid TASK_VERSION_CONFLICT Host result");
        }
        break;
      case "TASK_NOT_FOUND":
      case "TASK_NOT_ACTIVE":
      case "HOST_REVIEW_NOT_EXPECTED":
      case "REVIEW_TARGET_MISMATCH":
      case "REVIEW_EVIDENCE_INVALID":
      case "OPERATION_NOT_INDETERMINATE":
        requireTaskOnly(["kind", "requestId", "code", "taskId"]);
        break;
      case "COMMAND_REJECTED": {
        const allowed = ["kind", "requestId", "code", "taskId", "details"];
        if (
          !Object.keys(record).every((key) => allowed.includes(key)) ||
          typeof record.taskId !== "string" ||
          record.taskId.length === 0 ||
          "observedVersion" in record ||
          (record.details !== undefined &&
            (!isRecord(record.details) ||
              !hasOnlyKeys(record.details, ["domainCode"]) ||
              typeof record.details.domainCode !== "string" ||
              !domainRejectionCodes.has(record.details.domainCode)))
        ) {
          throw new Error("Invalid COMMAND_REJECTED Host result");
        }
        break;
      }
      default:
        throw new Error(`Unhandled Host rejection code ${code}`);
    }
    return value as unknown as DurableHostCommandResult;
  }
  throw new Error(`Unknown Host result kind ${record.kind}`);
};

const makeHostResultCodec = (
  expectedRequestId: HostRequestId,
  expectedTaskId?: TaskId,
): ResultCodec<DurableHostCommandResult> => ({
  encode: (result) => {
    assertJsonValue(result, "Host result must be JSON-safe");
    return result as unknown as JsonObject;
  },
  decode: (value) => {
    const result = decodeHostResult(value);
    if (result.requestId !== expectedRequestId) {
      throw new Error("Stored Host result request ID does not match the current request");
    }
    if (
      expectedTaskId !== undefined &&
      "taskId" in result &&
      result.taskId !== undefined &&
      result.taskId !== expectedTaskId
    ) {
      throw new Error("Stored Host result task ID does not match the command target");
    }
    return result;
  },
});

const mapDomainRejection = (
  requestId: HostRequestId,
  taskId: TaskId | undefined,
  rejection: DomainRejection,
): DurableHostCommandResult => {
  switch (rejection.code) {
    case "TASK_NOT_ACTIVE":
      return rejectedResult(requestId, "TASK_NOT_ACTIVE", taskId);
    case "STAGE_NOT_FOUND":
    case "STAGE_ALREADY_COMPLETED":
    case "STAGE_NOT_ACTIVE":
    case "STAGE_ROLE_MISMATCH":
    case "REVIEW_TARGET_MISMATCH":
      return rejectedResult(requestId, "HOST_REVIEW_NOT_EXPECTED", taskId);
    case "REVIEW_CANDIDATE_MISMATCH":
    case "CANDIDATE_NOT_FOUND":
    case "REVIEW_AUTHORITY_REQUIREMENT_MISMATCH":
      return rejectedResult(requestId, "REVIEW_TARGET_MISMATCH", taskId);
    case "REVIEW_EVIDENCE_INVALID":
      return rejectedResult(requestId, "REVIEW_EVIDENCE_INVALID", taskId);
    default:
      return rejectedResult(requestId, "COMMAND_REJECTED", taskId, undefined, {
        domainCode: rejection.code,
      });
  }
};
const strictDecodeCursorText = (cursor: string): string => {
  if (typeof cursor !== "string" || cursor.length === 0) {
    throw new HostQueryProtocolError("MALFORMED_CURSOR", "Cursor must be a non-empty string");
  }
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) {
    throw new HostQueryProtocolError(
      "MALFORMED_CURSOR",
      "Cursor must use canonical unpadded base64url",
    );
  }
  const bytes = Buffer.from(cursor, "base64url");
  if (bytes.length === 0 || Buffer.from(bytes).toString("base64url") !== cursor) {
    throw new HostQueryProtocolError("MALFORMED_CURSOR", "Cursor is not canonical base64url");
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new HostQueryProtocolError("MALFORMED_CURSOR", "Cursor contains invalid UTF-8");
  }
};

const decodeCursorPayload = (cursor: string): Record<string, unknown> => {
  try {
    const text = strictDecodeCursorText(cursor);
    const separator = text.indexOf(":");
    if (separator <= 0) {
      throw new HostQueryProtocolError("MALFORMED_CURSOR", "Cursor is missing its version prefix");
    }
    const version = text.slice(0, separator);
    if (version !== CURSOR_VERSION) {
      throw new HostQueryProtocolError("MALFORMED_CURSOR", "Unsupported cursor version");
    }
    const jsonText = text.slice(separator + 1);
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      throw new HostQueryProtocolError("MALFORMED_CURSOR", "Cursor payload is not valid JSON");
    }
    if (!isRecord(parsed)) {
      throw new HostQueryProtocolError("MALFORMED_CURSOR", "Cursor payload must be a plain object");
    }
    if (canonicalJson(parsed) !== jsonText) {
      throw new HostQueryProtocolError("MALFORMED_CURSOR", "Cursor payload is not canonical JSON");
    }
    return parsed;
  } catch (error) {
    if (error instanceof HostQueryProtocolError) {
      throw error;
    }
    throw new HostQueryProtocolError(
      "MALFORMED_CURSOR",
      "Cursor payload is invalid or non-canonical",
    );
  }
};

const decodeTaskListCursor = (cursor: string, status: TaskStatus | undefined): TaskId => {
  const payload = decodeCursorPayload(cursor);
  if (
    payload.v !== CURSOR_VERSION ||
    payload.kind !== "task-list" ||
    !hasOnlyKeys(payload, ["v", "kind", "status", "taskId"]) ||
    typeof payload.taskId !== "string" ||
    payload.taskId.length === 0 ||
    (payload.status !== null &&
      (typeof payload.status !== "string" || !taskStatuses.has(payload.status as TaskStatus)))
  ) {
    throw new HostQueryProtocolError("MALFORMED_CURSOR", "Malformed task-list cursor payload");
  }
  const cursorStatus = payload.status === null ? undefined : (payload.status as TaskStatus);
  if (cursorStatus !== status) {
    throw new HostQueryProtocolError(
      "CURSOR_QUERY_MISMATCH",
      "Task-list cursor does not match the requested status filter",
    );
  }
  return payload.taskId as TaskId;
};

const decodeHistoryCursor = (cursor: string, taskId: TaskId): number => {
  const payload = decodeCursorPayload(cursor);
  if (
    payload.v !== CURSOR_VERSION ||
    payload.kind !== "authority-history" ||
    !hasOnlyKeys(payload, ["v", "kind", "taskId", "committedVersion"]) ||
    typeof payload.taskId !== "string" ||
    payload.taskId.length === 0 ||
    !Number.isInteger(payload.committedVersion) ||
    (payload.committedVersion as number) <= 0
  ) {
    throw new HostQueryProtocolError(
      "MALFORMED_CURSOR",
      "Malformed authority-history cursor payload",
    );
  }
  if (payload.taskId !== taskId) {
    throw new HostQueryProtocolError(
      "CURSOR_QUERY_MISMATCH",
      "Authority-history cursor does not match the requested task",
    );
  }
  return payload.committedVersion as number;
};

const encodeTaskListCursor = (status: TaskStatus | undefined, taskId: TaskId): string => {
  const payload = {
    v: CURSOR_VERSION,
    kind: "task-list",
    status: status ?? null,
    taskId,
  };
  return Buffer.from(`${CURSOR_VERSION}:${canonicalJson(payload)}`, "utf8").toString("base64url");
};

const encodeHistoryCursor = (taskId: TaskId, committedVersion: number): string => {
  const payload = {
    v: CURSOR_VERSION,
    kind: "authority-history",
    taskId,
    committedVersion,
  };
  return Buffer.from(`${CURSOR_VERSION}:${canonicalJson(payload)}`, "utf8").toString("base64url");
};

const validateQueryLimit = (limit: number | undefined): void => {
  if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
    throw new HostQueryProtocolError("INVALID_LIMIT", "limit must be a positive integer");
  }
};

const taskStatuses = new Set<TaskStatus>(["active", "completed", "failed", "cancelled"]);

const validateQueryStatus = (status: TaskStatus | undefined): void => {
  if (status !== undefined && !taskStatuses.has(status)) {
    throw new HostQueryProtocolError("INVALID_STATUS", `Unknown task status ${String(status)}`);
  }
};

const descriptorIdentity = (value: JsonObject): DescriptorIdentity =>
  `sha256:${identityFromCanonical(value)}` as DescriptorIdentity;
class HostApplicationImpl implements HostApplication {
  private readonly store: AuthorityStore;
  private readonly idFactory: HostIdFactory;
  private readonly reconciliationNotifier?: ReconciliationNotifier;

  constructor(
    store: AuthorityStore,
    idFactory: HostIdFactory,
    reconciliationNotifier?: ReconciliationNotifier,
  ) {
    this.store = store;
    this.idFactory = idFactory;
    this.reconciliationNotifier = reconciliationNotifier;
  }

  execute<C extends HostCommand>(envelope: HostCommandEnvelope<C>): HostCommandResponse {
    const validated = validateEnvelope(envelope);
    const requestId = validated.requestId;
    const payloadFingerprint = fingerprintEnvelope(validated);

    switch (validated.command.type) {
      case "create-task":
        return this.createTask(
          validated as HostCommandEnvelope<Extract<HostCommand, { type: "create-task" }>>,
          requestId,
          payloadFingerprint,
        );
      case "submit-external-review":
        return this.submitExternalReview(
          validated as HostCommandEnvelope<
            Extract<HostCommand, { type: "submit-external-review" }>
          >,
          requestId,
          payloadFingerprint,
        );
      case "cancel-task":
        return this.cancelTask(
          validated as HostCommandEnvelope<Extract<HostCommand, { type: "cancel-task" }>>,
          requestId,
          payloadFingerprint,
        );
      case "request-operation-reconciliation":
        return this.requestOperationReconciliation(
          validated as HostCommandEnvelope<
            Extract<HostCommand, { type: "request-operation-reconciliation" }>
          >,
          requestId,
          payloadFingerprint,
        );
    }
  }

  private createTask(
    envelope: HostCommandEnvelope<Extract<HostCommand, { type: "create-task" }>>,
    requestId: HostRequestId,
    payloadFingerprint: string,
  ): HostCommandResponse {
    const command = envelope.command;
    const taskId = this.idFactory.taskId();
    const aggregate = createTask({
      id: taskId,
      version: 1,
      status: "active",
      creationSpec: command.creationSpec,
      policySnapshot: command.policySnapshot,
      authorityScope: command.authorityScope,
    });

    const input = {
      requestId,
      payloadFingerprint,
      taskId,
      expectedVersion: 0,
      resultCodec: makeHostResultCodec(requestId),
      onPreconditionFailure: (failure: {
        kind: "create-conflict" | "task-not-found" | "version-conflict";
        taskId: TaskId;
        expectedVersion: number;
        observedVersion?: number;
      }): DurableHostCommandResult => {
        if (failure.kind === "create-conflict") {
          return rejectedResult(requestId, "TASK_ID_CONFLICT", taskId, failure.observedVersion, {
            expectedVersion: 0,
            observedVersion: failure.observedVersion!,
          });
        }
        return rejectedResult(requestId, "TASK_NOT_FOUND", taskId);
      },
    };

    return this.runCommand(input, () => ({
      kind: "commit",
      nextAggregate: aggregate,
      facts: [{ type: "task-created", taskId }],
      result: committedResult(requestId, taskId, 1, "task-created"),
    }));
  }
  private submitExternalReview(
    envelope: HostCommandEnvelope<Extract<HostCommand, { type: "submit-external-review" }>>,
    requestId: HostRequestId,
    payloadFingerprint: string,
  ): HostCommandResponse {
    const command = envelope.command;
    const reviewId = this.idFactory.reviewId();

    const input = {
      requestId,
      payloadFingerprint,
      taskId: command.taskId,
      expectedVersion: envelope.expectedVersion,
      resultCodec: makeHostResultCodec(requestId, command.taskId),
      onPreconditionFailure: (failure: {
        kind: "task-not-found" | "version-conflict" | "create-conflict";
        taskId: TaskId;
        expectedVersion: number;
        observedVersion?: number;
      }): DurableHostCommandResult => {
        if (failure.kind === "task-not-found") {
          return rejectedResult(requestId, "TASK_NOT_FOUND", command.taskId);
        }
        if (failure.kind === "version-conflict") {
          return rejectedResult(
            requestId,
            "TASK_VERSION_CONFLICT",
            command.taskId,
            failure.observedVersion,
            {
              expectedVersion: failure.expectedVersion,
              ...(failure.observedVersion !== undefined
                ? { observedVersion: failure.observedVersion }
                : {}),
            },
          );
        }
        return rejectedResult(requestId, "COMMAND_REJECTED", command.taskId);
      },
    };

    return this.runCommand(input, (snapshot) => {
      if (!snapshot) {
        return {
          kind: "no-write",
          result: rejectedResult(requestId, "TASK_NOT_FOUND", command.taskId),
        };
      }
      if (!isValidEvidence(command.evidence)) {
        return {
          kind: "no-write",
          result: rejectedResult(requestId, "REVIEW_EVIDENCE_INVALID", command.taskId),
        };
      }
      const aggregate = snapshot.aggregate;
      const stage = aggregate.stages[command.stageId];
      const authorityRequirement = stage
        ? (stage.semanticInputs.find(
            (input) =>
              typeof input.value === "object" &&
              input.value !== null &&
              !Array.isArray(input.value) &&
              (input.value as { kind?: unknown }).kind === "authority-requirement",
          )?.value as FrozenDescriptor<"authority-requirement"> | undefined)
        : undefined;

      const review = {
        id: reviewId,
        taskId: command.taskId,
        stageId: command.stageId,
        candidateId: command.candidateId,
        authorityRequirement:
          authorityRequirement ??
          ({
            kind: "authority-requirement",
            contractVersion: "",
            identity: "",
            value: {},
          } as FrozenDescriptor<"authority-requirement">),
        disposition: command.disposition,
        evidence: command.evidence,
        decisionProvenance: {
          kind: "actor" as const,
          actorRef: command.actorRef,
        },
      };

      const domainResult = applyDomainCommand(aggregate, {
        type: "submit-external-review",
        review,
      });
      if (!domainResult.ok) {
        return {
          kind: "no-write",
          result: mapDomainRejection(requestId, command.taskId, domainResult.error),
        };
      }
      const nextAggregate = domainResult.value;
      return {
        kind: "commit",
        nextAggregate,
        facts: [
          {
            type: "external-review-submitted",
            taskId: command.taskId,
            stageId: command.stageId,
            reviewId,
            candidateId: command.candidateId,
          },
          {
            type: "stage-completed",
            taskId: command.taskId,
            stageId: command.stageId,
            completion: { kind: "review", ref: reviewId },
          },
        ] as JsonObject[],
        result: committedResult(
          requestId,
          command.taskId,
          nextAggregate.task.version,
          "external-review-recorded",
        ),
      };
    });
  }
  private cancelTask(
    envelope: HostCommandEnvelope<Extract<HostCommand, { type: "cancel-task" }>>,
    requestId: HostRequestId,
    payloadFingerprint: string,
  ): HostCommandResponse {
    const command = envelope.command;
    const snapshot = this.store.getTask(command.taskId);
    const cancellation = command.cancellation;

    const stageCancellations: FrozenDescriptor<"stage-cancellation">[] = [];
    const operationAborts: FrozenDescriptor<"operation-abort">[] = [];

    if (snapshot && snapshot.observedVersion === envelope.expectedVersion) {
      const aggregate = snapshot.aggregate;
      const openStages = Object.values(aggregate.stages)
        .filter((stage) => stage.status === "pending" || stage.status === "active")
        .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
      const preparedOperations = Object.values(aggregate.operations)
        .filter((operation) => operation.status === "prepared")
        .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));

      for (const stage of openStages) {
        const identity = descriptorIdentity({
          taskCancellationIdentity: cancellation.identity,
          kind: "stage-cancellation",
          stageId: stage.id,
        });
        stageCancellations.push({
          kind: "stage-cancellation",
          contractVersion: cancellation.contractVersion,
          identity,
          value: {
            taskCancellationIdentity: cancellation.identity,
            taskId: command.taskId,
            stageId: stage.id,
          },
        });
      }
      for (const operation of preparedOperations) {
        const identity = descriptorIdentity({
          taskCancellationIdentity: cancellation.identity,
          kind: "operation-abort",
          operationId: operation.id,
        });
        operationAborts.push({
          kind: "operation-abort",
          contractVersion: cancellation.contractVersion,
          identity,
          value: {
            taskCancellationIdentity: cancellation.identity,
            taskId: command.taskId,
            operationId: operation.id,
          },
        });
      }
    }

    const input = {
      requestId,
      payloadFingerprint,
      taskId: command.taskId,
      expectedVersion: envelope.expectedVersion,
      resultCodec: makeHostResultCodec(requestId, command.taskId),
      onPreconditionFailure: (failure: {
        kind: "task-not-found" | "version-conflict" | "create-conflict";
        taskId: TaskId;
        expectedVersion: number;
        observedVersion?: number;
      }): DurableHostCommandResult => {
        if (failure.kind === "task-not-found") {
          return rejectedResult(requestId, "TASK_NOT_FOUND", command.taskId);
        }
        if (failure.kind === "version-conflict") {
          return rejectedResult(
            requestId,
            "TASK_VERSION_CONFLICT",
            command.taskId,
            failure.observedVersion,
            {
              expectedVersion: failure.expectedVersion,
              ...(failure.observedVersion !== undefined
                ? { observedVersion: failure.observedVersion }
                : {}),
            },
          );
        }
        return rejectedResult(requestId, "COMMAND_REJECTED", command.taskId);
      },
    };

    return this.runCommand(input, (transactionSnapshot) => {
      if (!transactionSnapshot) {
        return {
          kind: "no-write",
          result: rejectedResult(requestId, "TASK_NOT_FOUND", command.taskId),
        };
      }
      const aggregate = transactionSnapshot.aggregate;
      const domainResult = applyDomainCommand(aggregate, {
        type: "cancel-task",
        cancellation,
        stageCancellations,
        operationAborts,
      });
      if (!domainResult.ok) {
        return {
          kind: "no-write",
          result: mapDomainRejection(requestId, command.taskId, domainResult.error),
        };
      }
      const nextAggregate = domainResult.value;
      const previousStages = Object.values(aggregate.stages).filter(
        (stage) => stage.status === "pending" || stage.status === "active",
      );
      const previousOperations = Object.values(aggregate.operations).filter(
        (operation) => operation.status === "prepared",
      );
      const facts: JsonObject[] = [
        {
          type: "task-cancelled",
          taskId: command.taskId,
          cancellationIdentity: cancellation.identity,
        },
      ];
      for (const stage of previousStages.sort((left, right) =>
        left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
      )) {
        const derived = stageCancellations.find(
          (descriptor) => descriptor.value.stageId === stage.id,
        );
        facts.push({
          type: "stage-cancelled",
          taskId: command.taskId,
          stageId: stage.id,
          previousGeneration: stage.currentExecutionGeneration,
          newGeneration: stage.currentExecutionGeneration + 1,
          cancellationIdentity: cancellation.identity,
          descriptorIdentity: derived?.identity ?? null,
        });
      }
      for (const operation of previousOperations.sort((left, right) =>
        left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
      )) {
        const derived = operationAborts.find(
          (descriptor) => descriptor.value.operationId === operation.id,
        );
        facts.push({
          type: "operation-aborted",
          taskId: command.taskId,
          operationId: operation.id,
          cancellationIdentity: cancellation.identity,
          descriptorIdentity: derived?.identity ?? null,
        });
      }
      return {
        kind: "commit",
        nextAggregate,
        facts,
        result: committedResult(
          requestId,
          command.taskId,
          nextAggregate.task.version,
          "task-cancelled",
        ),
      };
    });
  }
  private requestOperationReconciliation(
    envelope: HostCommandEnvelope<
      Extract<HostCommand, { type: "request-operation-reconciliation" }>
    >,
    requestId: HostRequestId,
    payloadFingerprint: string,
  ): HostCommandResponse {
    const command = envelope.command;
    const input = {
      requestId,
      payloadFingerprint,
      taskId: command.taskId,
      expectedVersion: envelope.expectedVersion,
      resultCodec: makeHostResultCodec(requestId, command.taskId),
      onPreconditionFailure: (failure: {
        kind: "task-not-found" | "version-conflict" | "create-conflict";
        taskId: TaskId;
        expectedVersion: number;
        observedVersion?: number;
      }): DurableHostCommandResult => {
        if (failure.kind === "task-not-found") {
          return rejectedResult(requestId, "TASK_NOT_FOUND", command.taskId);
        }
        if (failure.kind === "version-conflict") {
          return rejectedResult(
            requestId,
            "TASK_VERSION_CONFLICT",
            command.taskId,
            failure.observedVersion,
            {
              expectedVersion: failure.expectedVersion,
              ...(failure.observedVersion !== undefined
                ? { observedVersion: failure.observedVersion }
                : {}),
            },
          );
        }
        return rejectedResult(requestId, "COMMAND_REJECTED", command.taskId);
      },
    };

    const response = this.runCommand(input, (snapshot) => {
      if (!snapshot) {
        return {
          kind: "no-write",
          result: rejectedResult(requestId, "TASK_NOT_FOUND", command.taskId),
        };
      }
      const operation = snapshot.aggregate.operations[command.operationId];
      if (
        !operation ||
        operation.taskId !== command.taskId ||
        operation.status !== "indeterminate"
      ) {
        return {
          kind: "no-write",
          result: rejectedResult(requestId, "OPERATION_NOT_INDETERMINATE", command.taskId),
        };
      }
      return {
        kind: "no-write",
        result: acceptedNoWriteResult(requestId, command.taskId, snapshot.observedVersion),
      };
    });

    if (
      this.reconciliationNotifier &&
      response.result.kind === "accepted-no-write" &&
      response.result.outcome === "reconciliation-required"
    ) {
      this.reconciliationNotifier(command.taskId, command.operationId);
    }
    return response;
  }

  private runCommand<TResult>(
    input: ExecuteTaskCommandInput<TResult>,
    decide: (snapshot: TaskSnapshot | undefined) => TaskDecision<TResult>,
  ): TaskCommandResponse<TResult> {
    try {
      return this.store.executeTaskCommand(input, decide);
    } catch (error) {
      if (error instanceof AuthorityStoreError && error.code === "REQUEST_ID_REUSE_MISMATCH") {
        throw new HostCommandProtocolError("REQUEST_ID_REUSE_MISMATCH", error.message);
      }
      throw error;
    }
  }

  getTask(taskId: TaskId): GetTaskResult {
    const snapshot = this.store.getTask(taskId);
    if (!snapshot) {
      return { kind: "task-not-found", taskId };
    }
    return {
      kind: "found",
      taskId,
      observedVersion: snapshot.observedVersion,
      aggregateSchemaVersion: snapshot.aggregateSchemaVersion,
      aggregate: snapshot.aggregate,
    };
  }

  listTasks(options: HostListTasksOptions = {}): ListTasksResult {
    validateQueryLimit(options.limit);
    validateQueryStatus(options.status);

    let afterTaskId: TaskId | undefined;
    if (options.cursor !== undefined) {
      afterTaskId = decodeTaskListCursor(options.cursor, options.status);
    }

    const page = this.store.listTasksPage({
      status: options.status,
      afterTaskId,
      limit: options.limit,
    });

    const nextCursor =
      page.nextCursor !== undefined
        ? encodeTaskListCursor(options.status, page.nextCursor)
        : undefined;

    return { items: page.items, nextCursor };
  }

  getAuthorityHistory(
    taskId: TaskId,
    options: HostAuthorityHistoryOptions = {},
  ): GetAuthorityHistoryResult {
    validateQueryLimit(options.limit);
    const task = this.store.getTask(taskId);
    if (!task) {
      return { kind: "task-not-found", taskId };
    }

    let afterCommittedVersion: number | undefined;
    if (options.cursor !== undefined) {
      afterCommittedVersion = decodeHistoryCursor(options.cursor, taskId);
    }

    const page = this.store.getAuthorityHistoryPage(taskId, {
      afterCommittedVersion,
      limit: options.limit,
    });

    const nextCursor =
      page.nextCursor !== undefined ? encodeHistoryCursor(taskId, page.nextCursor) : undefined;

    return {
      kind: "found",
      taskId,
      observedVersion: task.observedVersion,
      items: page.items,
      nextCursor,
    };
  }

  close(): void {
    this.store.close();
  }
}
export const createHostApplication = (
  store: AuthorityStore,
  idFactory: HostIdFactory,
  reconciliationNotifier?: ReconciliationNotifier,
): HostApplication => new HostApplicationImpl(store, idFactory, reconciliationNotifier);
