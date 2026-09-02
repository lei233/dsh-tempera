import Database from "better-sqlite3";
import type { JsonObject, JsonValue, TaskAggregate, TaskId, TaskStatus } from "@dsh-tempera/domain";
import {
  aggregateSchemaVersion,
  decodeStoredTaskSnapshot,
  encodeTaskAggregate,
  isTaskStatus,
  type StoredTaskSnapshotRow,
  type TaskSnapshot,
} from "./codec";
import { AuthorityStoreError } from "./errors";
import { assertJsonObject, assertJsonValue } from "./json";
import { acquireExclusiveLock, configureConnection, migrate } from "./schema";

export type Delivery = "first-observation" | "replay";

export interface ResultCodec<TResult> {
  readonly encode: (result: TResult) => JsonValue;
  readonly decode: (value: unknown) => TResult;
}

export type NoWriteTaskDecision<TResult> = {
  readonly kind: "no-write";
  readonly result: TResult;
};

export type CommitTaskDecision<TResult> = {
  readonly kind: "commit";
  readonly nextAggregate: TaskAggregate;
  readonly facts: readonly JsonObject[];
  readonly result: TResult;
};

export type TaskDecision<TResult> = CommitTaskDecision<TResult> | NoWriteTaskDecision<TResult>;

export type PreconditionFailure =
  | {
      readonly kind: "task-not-found";
      readonly taskId: TaskId;
      readonly expectedVersion: number;
    }
  | {
      readonly kind: "create-conflict";
      readonly taskId: TaskId;
      readonly expectedVersion: 0;
      readonly observedVersion: number;
    }
  | {
      readonly kind: "version-conflict";
      readonly taskId: TaskId;
      readonly expectedVersion: number;
      readonly observedVersion: number;
    };

export type PreconditionFailureHandler<TResult> = (failure: PreconditionFailure) => TResult;

export interface ExecuteTaskCommandInput<TResult> {
  readonly requestId: string;
  readonly payloadFingerprint: string;
  readonly taskId: TaskId;
  readonly expectedVersion: number;
  readonly resultCodec: ResultCodec<TResult>;
  readonly onPreconditionFailure: PreconditionFailureHandler<TResult>;
}

export interface TaskCommandResponse<TResult> {
  readonly delivery: Delivery;
  readonly result: TResult;
}

export interface TaskSummary {
  readonly taskId: TaskId;
  readonly status: TaskStatus;
  readonly version: number;
  readonly aggregateSchemaVersion: number;
}

export interface AuthorityCommit {
  readonly taskId: TaskId;
  readonly committedVersion: number;
  readonly previousVersion: number;
  readonly commandIdentity: string;
  readonly facts: readonly JsonObject[];
}

export interface ListTasksOptions {
  readonly status?: TaskStatus;
  readonly limit?: number;
  readonly afterTaskId?: string;
  readonly cursor?: string;
}

export interface AuthorityHistoryOptions {
  readonly afterCommittedVersion?: number;
  readonly limit?: number;
}

export interface ListTasksPageResult {
  readonly items: TaskSummary[];
  readonly nextCursor?: TaskId;
}

export interface AuthorityHistoryPageResult {
  readonly items: AuthorityCommit[];
  readonly nextCursor?: number;
}

export interface AuthorityStore {
  executeTaskCommand<TResult>(
    input: ExecuteTaskCommandInput<TResult>,
    decide: (snapshot: TaskSnapshot | undefined) => TaskDecision<TResult>,
  ): TaskCommandResponse<TResult>;
  getTask(taskId: TaskId): TaskSnapshot | undefined;
  listTasks(
    options?: ListTasksOptions | TaskStatus,
    afterTaskId?: string,
    limit?: number,
  ): TaskSummary[];
  listTasksPage(options?: ListTasksOptions): ListTasksPageResult;
  getAuthorityHistory(
    taskId: TaskId,
    options?: AuthorityHistoryOptions | number,
    limit?: number,
  ): AuthorityCommit[];
  getAuthorityHistoryPage(
    taskId: TaskId,
    options?: AuthorityHistoryOptions,
  ): AuthorityHistoryPageResult;
  close(): void;
}

type FailpointName =
  | "before-snapshot-write"
  | "before-journal-write"
  | "before-receipt-write"
  | "before-commit";

interface ReceiptRow {
  readonly request_id: string;
  readonly payload_fingerprint: string;
  readonly result_json: string;
}

interface JournalRow {
  readonly task_id: string;
  readonly committed_version: number;
  readonly previous_version: number;
  readonly command_identity: string;
  readonly facts_json: string;
}

interface TaskSummaryRow {
  readonly task_id: string;
  readonly status: string;
  readonly version: number;
  readonly aggregate_schema_version: number;
}

const isSqliteError = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  typeof (error as { code?: unknown }).code === "string" &&
  (error as { code: string }).code.startsWith("SQLITE");

const sqliteFailure = (message: string): AuthorityStoreError =>
  new AuthorityStoreError("SQLITE_FAILURE", message);

const encodeResult = <TResult>(resultCodec: ResultCodec<TResult>, result: TResult): string => {
  const encoded = resultCodec.encode(result);
  assertJsonValue(encoded, "Result codec produced a non-JSON value");
  return JSON.stringify(encoded);
};

const decodeStoredResult = <TResult>(
  resultCodec: ResultCodec<TResult>,
  resultJson: string,
): TResult => {
  try {
    return resultCodec.decode(JSON.parse(resultJson));
  } catch (error) {
    throw new AuthorityStoreError(
      "CORRUPT_DATA",
      `Stored command result is corrupt: ${String(error)}`,
    );
  }
};

export class SqliteAuthorityStore implements AuthorityStore {
  private readonly db: Database.Database;
  private readonly getReceiptStatement: Database.Statement<[string], ReceiptRow>;
  private readonly getSnapshotStatement: Database.Statement<[string], StoredTaskSnapshotRow>;
  private readonly insertSnapshotStatement: Database.Statement;
  private readonly insertJournalStatement: Database.Statement;
  private readonly insertReceiptStatement: Database.Statement;
  private readonly listTasksStatement: Database.Statement;
  private readonly listTasksByStatusStatement: Database.Statement;
  private readonly listTasksAfterStatement: Database.Statement;
  private readonly listTasksByStatusAfterStatement: Database.Statement;
  private readonly listTasksLimitStatement: Database.Statement;
  private readonly listTasksByStatusLimitStatement: Database.Statement;
  private readonly listTasksAfterLimitStatement: Database.Statement;
  private readonly listTasksByStatusAfterLimitStatement: Database.Statement;
  private readonly historyStatement: Database.Statement;
  private readonly historyAfterStatement: Database.Statement;
  private readonly historyAfterLimitStatement: Database.Statement;
  private readonly historyLimitStatement: Database.Statement;
  private readonly failpoints = new Map<string, unknown>();
  private closed = false;

  constructor(db: Database.Database) {
    this.db = db;
    this.getReceiptStatement = db.prepare(
      "SELECT request_id, payload_fingerprint, result_json FROM command_receipts WHERE request_id = ?",
    );
    this.getSnapshotStatement = db.prepare(
      "SELECT task_id, version, status, aggregate_schema_version, aggregate_json FROM task_snapshots WHERE task_id = ?",
    );
    this.insertSnapshotStatement = db.prepare(`
      INSERT INTO task_snapshots (task_id, version, status, aggregate_schema_version, aggregate_json)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(task_id) DO UPDATE SET
        version = excluded.version,
        status = excluded.status,
        aggregate_schema_version = excluded.aggregate_schema_version,
        aggregate_json = excluded.aggregate_json
    `);
    this.insertJournalStatement = db.prepare(`
      INSERT INTO authority_commits
        (task_id, committed_version, previous_version, command_identity, facts_json)
      VALUES (?, ?, ?, ?, ?)
    `);
    this.insertReceiptStatement = db.prepare(`
      INSERT INTO command_receipts
        (request_id, payload_fingerprint, task_id, committed_version, result_json)
      VALUES (?, ?, ?, ?, ?)
    `);
    this.listTasksStatement = db.prepare(`
      SELECT task_id, status, version, aggregate_schema_version
      FROM task_snapshots
      ORDER BY task_id ASC
    `);
    this.listTasksByStatusStatement = db.prepare(`
      SELECT task_id, status, version, aggregate_schema_version
      FROM task_snapshots
      WHERE status = ?
      ORDER BY task_id ASC
    `);
    this.listTasksAfterStatement = db.prepare(`
      SELECT task_id, status, version, aggregate_schema_version
      FROM task_snapshots
      WHERE task_id > ?
      ORDER BY task_id ASC
    `);
    this.listTasksByStatusAfterStatement = db.prepare(`
      SELECT task_id, status, version, aggregate_schema_version
      FROM task_snapshots
      WHERE status = ? AND task_id > ?
      ORDER BY task_id ASC
    `);
    this.listTasksLimitStatement = db.prepare(`
      SELECT task_id, status, version, aggregate_schema_version
      FROM task_snapshots
      ORDER BY task_id ASC
      LIMIT ?
    `);
    this.listTasksByStatusLimitStatement = db.prepare(`
      SELECT task_id, status, version, aggregate_schema_version
      FROM task_snapshots
      WHERE status = ?
      ORDER BY task_id ASC
      LIMIT ?
    `);
    this.listTasksAfterLimitStatement = db.prepare(`
      SELECT task_id, status, version, aggregate_schema_version
      FROM task_snapshots
      WHERE task_id > ?
      ORDER BY task_id ASC
      LIMIT ?
    `);
    this.listTasksByStatusAfterLimitStatement = db.prepare(`
      SELECT task_id, status, version, aggregate_schema_version
      FROM task_snapshots
      WHERE status = ? AND task_id > ?
      ORDER BY task_id ASC
      LIMIT ?
    `);
    this.historyStatement = db.prepare(`
      SELECT task_id, committed_version, previous_version, command_identity, facts_json
      FROM authority_commits
      WHERE task_id = ?
      ORDER BY committed_version ASC
    `);
    this.historyAfterStatement = db.prepare(`
      SELECT task_id, committed_version, previous_version, command_identity, facts_json
      FROM authority_commits
      WHERE task_id = ? AND committed_version > ?
      ORDER BY committed_version ASC
    `);
    this.historyAfterLimitStatement = db.prepare(`
      SELECT task_id, committed_version, previous_version, command_identity, facts_json
      FROM authority_commits
      WHERE task_id = ? AND committed_version > ?
      ORDER BY committed_version ASC
      LIMIT ?
    `);
    this.historyLimitStatement = db.prepare(`
      SELECT task_id, committed_version, previous_version, command_identity, facts_json
      FROM authority_commits
      WHERE task_id = ?
      ORDER BY committed_version ASC
      LIMIT ?
    `);
  }

  /** @internal Test-only failpoint control. Not part of the stable public API. */
  setFailpoint(name: FailpointName | (string & {}), error?: unknown): void {
    if (error === undefined) {
      this.failpoints.delete(name);
    } else {
      this.failpoints.set(name, error);
    }
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new AuthorityStoreError("STORE_CLOSED", "AuthorityStore is closed");
    }
  }

  private throwAtFailpoint(name: string): void {
    const candidates = [name, `before-${name}`, `after-${name}`];
    if (name.endsWith("-write")) {
      const base = name.slice(0, -"-write".length);
      candidates.push(base, `before-${base}`, `after-${base}`);
    }
    let failure: unknown;
    for (const candidate of candidates) {
      if (this.failpoints.has(candidate)) {
        failure = this.failpoints.get(candidate);
        break;
      }
    }
    if (failure === undefined) {
      return;
    }
    if (failure === true) {
      throw new Error(`failpoint ${name}`);
    }
    if (typeof failure === "function") {
      throw failure();
    }
    throw failure;
  }

  executeTaskCommand<TResult>(
    input: ExecuteTaskCommandInput<TResult>,
    decide: (snapshot: TaskSnapshot | undefined) => TaskDecision<TResult>,
  ): TaskCommandResponse<TResult> {
    this.assertOpen();
    this.validateInput(input);

    let inTransaction = false;
    try {
      this.db.exec("BEGIN IMMEDIATE");
      inTransaction = true;

      const receipt = this.getReceiptStatement.get(input.requestId);
      if (receipt) {
        if (receipt.payload_fingerprint !== input.payloadFingerprint) {
          throw new AuthorityStoreError(
            "REQUEST_ID_REUSE_MISMATCH",
            `Request ${input.requestId} was already used with a different payload fingerprint`,
          );
        }
        const result = decodeStoredResult(input.resultCodec, receipt.result_json);
        this.db.exec("COMMIT");
        inTransaction = false;
        return { delivery: "replay", result };
      }

      const row = this.getSnapshotStatement.get(input.taskId);
      let snapshot: TaskSnapshot | undefined;
      if (row) {
        snapshot = decodeStoredTaskSnapshot(row);
      }

      const preconditionFailure = this.detectPreconditionFailure(input, snapshot);
      if (preconditionFailure) {
        const result = input.onPreconditionFailure(preconditionFailure);
        this.writeReceipt(input, null, result);
        this.db.exec("COMMIT");
        inTransaction = false;
        return { delivery: "first-observation", result };
      }

      const decision = decide(snapshot);
      if (decision.kind === "no-write") {
        this.writeReceipt(input, null, decision.result);
        this.db.exec("COMMIT");
        inTransaction = false;
        return { delivery: "first-observation", result: decision.result };
      }

      this.commitDecision(input, snapshot, decision);
      this.db.exec("COMMIT");
      inTransaction = false;
      return { delivery: "first-observation", result: decision.result };
    } catch (error) {
      if (inTransaction) {
        try {
          this.db.exec("ROLLBACK");
        } catch {
          // The original error is more useful.
        }
      }
      if (isSqliteError(error) && !(error instanceof AuthorityStoreError)) {
        throw sqliteFailure(`SQLite failure: ${(error as Error).message}`);
      }
      throw error;
    }
  }

  getTask(taskId: TaskId): TaskSnapshot | undefined {
    this.assertOpen();
    const row = this.getSnapshotStatement.get(taskId);
    if (!row) {
      return undefined;
    }
    return decodeStoredTaskSnapshot(row);
  }

  listTasks(
    options: ListTasksOptions | TaskStatus = {},
    afterTaskId?: string,
    limit?: number,
  ): TaskSummary[] {
    const normalizedOptions: ListTasksOptions =
      typeof options === "string" ? { status: options as TaskStatus, afterTaskId, limit } : options;
    const mergedOptions: ListTasksOptions = {
      ...normalizedOptions,
      ...(afterTaskId !== undefined ? { afterTaskId } : {}),
      ...(limit !== undefined ? { limit } : {}),
    };
    return this.listTasksPage(mergedOptions).items;
  }

  listTasksPage(options: ListTasksOptions = {}): ListTasksPageResult {
    this.assertOpen();
    const { status, afterTaskId, cursor, limit } = options;
    this.assertLimit(limit);
    const after = afterTaskId ?? cursor;
    const fetchLimit = limit === undefined ? undefined : limit + 1;

    let rows: TaskSummaryRow[];
    if (status !== undefined) {
      if (!isTaskStatus(status)) {
        throw sqliteFailure(`Invalid task status ${String(status)}`);
      }
      if (after !== undefined) {
        rows =
          fetchLimit === undefined
            ? (this.listTasksByStatusAfterStatement.all(status, after) as TaskSummaryRow[])
            : (this.listTasksByStatusAfterLimitStatement.all(
                status,
                after,
                fetchLimit,
              ) as TaskSummaryRow[]);
      } else {
        rows =
          fetchLimit === undefined
            ? (this.listTasksByStatusStatement.all(status) as TaskSummaryRow[])
            : (this.listTasksByStatusLimitStatement.all(status, fetchLimit) as TaskSummaryRow[]);
      }
    } else if (after !== undefined) {
      rows =
        fetchLimit === undefined
          ? (this.listTasksAfterStatement.all(after) as TaskSummaryRow[])
          : (this.listTasksAfterLimitStatement.all(after, fetchLimit) as TaskSummaryRow[]);
    } else {
      rows =
        fetchLimit === undefined
          ? (this.listTasksStatement.all() as TaskSummaryRow[])
          : (this.listTasksLimitStatement.all(fetchLimit) as TaskSummaryRow[]);
    }

    const hasMore = limit !== undefined && rows.length > limit;
    if (hasMore) {
      rows = rows.slice(0, limit);
    }

    const items = rows.map((row) => {
      if (row.aggregate_schema_version !== aggregateSchemaVersion) {
        throw new AuthorityStoreError(
          "CORRUPT_DATA",
          `Unsupported aggregate schema version ${row.aggregate_schema_version} in task_snapshots`,
        );
      }
      if (!isTaskStatus(row.status)) {
        throw new AuthorityStoreError(
          "CORRUPT_DATA",
          `Invalid task status ${row.status} in task_snapshots`,
        );
      }
      return {
        taskId: row.task_id as TaskId,
        status: row.status as TaskStatus,
        version: row.version,
        aggregateSchemaVersion: row.aggregate_schema_version,
      };
    });

    const nextCursor = hasMore && items.length > 0 ? items[items.length - 1]?.taskId : undefined;
    return { items, nextCursor };
  }

  getAuthorityHistory(
    taskId: TaskId,
    options: AuthorityHistoryOptions | number = {},
    limit?: number,
  ): AuthorityCommit[] {
    const normalizedOptions: AuthorityHistoryOptions =
      typeof options === "number" ? { afterCommittedVersion: options, limit } : options;
    const mergedOptions: AuthorityHistoryOptions = {
      ...normalizedOptions,
      ...(limit !== undefined ? { limit } : {}),
    };
    return this.getAuthorityHistoryPage(taskId, mergedOptions).items;
  }

  getAuthorityHistoryPage(
    taskId: TaskId,
    options: AuthorityHistoryOptions = {},
  ): AuthorityHistoryPageResult {
    this.assertOpen();
    const { afterCommittedVersion, limit } = options;
    this.assertLimit(limit);
    const fetchLimit = limit === undefined ? undefined : limit + 1;

    let rows: JournalRow[];
    if (afterCommittedVersion !== undefined && fetchLimit !== undefined) {
      rows = this.historyAfterLimitStatement.all(
        taskId,
        afterCommittedVersion,
        fetchLimit,
      ) as JournalRow[];
    } else if (afterCommittedVersion !== undefined) {
      rows = this.historyAfterStatement.all(taskId, afterCommittedVersion) as JournalRow[];
    } else if (fetchLimit !== undefined) {
      rows = this.historyLimitStatement.all(taskId, fetchLimit) as JournalRow[];
    } else {
      rows = this.historyStatement.all(taskId) as JournalRow[];
    }

    const hasMore = limit !== undefined && rows.length > limit;
    if (hasMore) {
      rows = rows.slice(0, limit);
    }

    const items = rows.map((row) => ({
      taskId: row.task_id as TaskId,
      committedVersion: row.committed_version,
      previousVersion: row.previous_version,
      commandIdentity: row.command_identity,
      facts: this.decodeFacts(row.facts_json),
    }));

    const nextCursor =
      hasMore && items.length > 0 ? items[items.length - 1]?.committedVersion : undefined;
    return { items, nextCursor };
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.db.close();
  }

  private validateInput<TResult>(input: ExecuteTaskCommandInput<TResult>): void {
    if (typeof input.requestId !== "string" || input.requestId.length === 0) {
      throw sqliteFailure("requestId must be a non-empty string");
    }
    if (typeof input.payloadFingerprint !== "string" || input.payloadFingerprint.length === 0) {
      throw sqliteFailure("payloadFingerprint must be a non-empty string");
    }
    if (typeof input.taskId !== "string" || input.taskId.length === 0) {
      throw sqliteFailure("taskId must be a non-empty string");
    }
    if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 0) {
      throw sqliteFailure("expectedVersion must be a non-negative integer");
    }
    if (
      typeof input.resultCodec !== "object" ||
      input.resultCodec === null ||
      typeof input.resultCodec.encode !== "function" ||
      typeof input.resultCodec.decode !== "function"
    ) {
      throw sqliteFailure("resultCodec must provide encode and decode functions");
    }
    if (typeof input.onPreconditionFailure !== "function") {
      throw sqliteFailure("onPreconditionFailure must be a function");
    }
  }

  private detectPreconditionFailure<TResult>(
    input: ExecuteTaskCommandInput<TResult>,
    snapshot: TaskSnapshot | undefined,
  ): PreconditionFailure | undefined {
    if (input.expectedVersion === 0) {
      if (snapshot) {
        return {
          kind: "create-conflict",
          taskId: input.taskId,
          expectedVersion: 0,
          observedVersion: snapshot.observedVersion,
        };
      }
      return undefined;
    }

    if (!snapshot) {
      return {
        kind: "task-not-found",
        taskId: input.taskId,
        expectedVersion: input.expectedVersion,
      };
    }
    if (snapshot.observedVersion !== input.expectedVersion) {
      return {
        kind: "version-conflict",
        taskId: input.taskId,
        expectedVersion: input.expectedVersion,
        observedVersion: snapshot.observedVersion,
      };
    }
    return undefined;
  }

  private commitDecision<TResult>(
    input: ExecuteTaskCommandInput<TResult>,
    snapshot: TaskSnapshot | undefined,
    decision: Extract<TaskDecision<TResult>, { kind: "commit" }>,
  ): void {
    const { nextAggregate, facts } = decision;
    const aggregateJson = encodeTaskAggregate(nextAggregate);

    if (nextAggregate.task.id !== input.taskId) {
      throw sqliteFailure(
        `Commit for task ${input.taskId} returned aggregate for task ${nextAggregate.task.id}`,
      );
    }

    const currentVersion = snapshot?.observedVersion ?? 0;
    const expectedNextVersion = currentVersion + 1;
    if (nextAggregate.task.version !== expectedNextVersion) {
      throw sqliteFailure(
        `Commit must advance task ${input.taskId} from version ${currentVersion} to ${expectedNextVersion}; got ${nextAggregate.task.version}`,
      );
    }

    if (!Array.isArray(facts) || facts.length === 0) {
      throw sqliteFailure("Commit must include at least one ordered authority fact");
    }
    for (const fact of facts) {
      assertJsonObject(fact, "Authority fact is not a JSON object");
    }

    const factsJson = JSON.stringify(facts);
    const commandIdentity = input.requestId;
    const previousVersion = currentVersion;
    const committedVersion = nextAggregate.task.version;

    this.throwAtFailpoint("snapshot-write");
    this.insertSnapshotStatement.run(
      input.taskId,
      committedVersion,
      nextAggregate.task.status,
      aggregateSchemaVersion,
      aggregateJson,
    );

    this.throwAtFailpoint("journal-write");
    this.insertJournalStatement.run(
      input.taskId,
      committedVersion,
      previousVersion,
      commandIdentity,
      factsJson,
    );

    this.writeReceipt(input, committedVersion, decision.result);
    this.throwAtFailpoint("commit");
  }

  private writeReceipt<TResult>(
    input: ExecuteTaskCommandInput<TResult>,
    committedVersion: number | null,
    result: TResult,
  ): void {
    const resultJson = encodeResult(input.resultCodec, result);
    this.throwAtFailpoint("receipt-write");
    this.insertReceiptStatement.run(
      input.requestId,
      input.payloadFingerprint,
      input.taskId,
      committedVersion,
      resultJson,
    );
  }

  private decodeFacts(factsJson: string): readonly JsonObject[] {
    let parsed: unknown;
    try {
      parsed = JSON.parse(factsJson);
    } catch (error) {
      throw new AuthorityStoreError(
        "CORRUPT_DATA",
        `Stored authority facts are corrupt: ${String(error)}`,
      );
    }
    if (!Array.isArray(parsed)) {
      throw new AuthorityStoreError("CORRUPT_DATA", "Stored authority facts must be a JSON array");
    }
    try {
      return parsed.map((fact) => {
        assertJsonObject(fact, "Stored authority fact is not a JSON object");
        return fact;
      });
    } catch (error) {
      throw new AuthorityStoreError(
        "CORRUPT_DATA",
        `Stored authority fact is corrupt: ${String(error)}`,
      );
    }
  }

  private assertLimit(limit: number | undefined): void {
    if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
      throw sqliteFailure("limit must be a positive integer");
    }
  }
}

const assertFileDatabasePath = (path: string): void => {
  if (typeof path !== "string" || path.length === 0) {
    throw sqliteFailure("path must be a non-empty string");
  }
  if (path === ":memory:" || path.startsWith("file:")) {
    throw sqliteFailure("Only file database paths are supported");
  }
};

export const openSqliteAuthorityStore = (path: string): AuthorityStore => {
  assertFileDatabasePath(path);

  let db: Database.Database;
  try {
    db = new Database(path, { timeout: 0 });
  } catch (error) {
    if (isSqliteError(error)) {
      throw sqliteFailure(`Unable to open SQLite database: ${(error as Error).message}`);
    }
    throw error;
  }

  try {
    configureConnection(db);
    acquireExclusiveLock(db);
    migrate(db);
    return new SqliteAuthorityStore(db);
  } catch (error) {
    try {
      db.close();
    } catch {
      // Preserve the original startup error.
    }
    if (
      isSqliteError(error) &&
      ((error as { code: string }).code === "SQLITE_BUSY" ||
        (error as { code: string }).code === "SQLITE_LOCKED")
    ) {
      throw new AuthorityStoreError(
        "OWNERSHIP_CONFLICT",
        `Another process owns the authority database: ${(error as { code: string }).code}`,
      );
    }
    throw error;
  }
};
