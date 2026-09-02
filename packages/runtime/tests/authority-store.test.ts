import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTask } from "@dsh-tempera/domain";
import type {
  ActiveTask,
  AuthorityAction,
  AuthorityScope,
  DescriptorIdentity,
  FrozenDescriptor,
  JsonObject,
  JsonValue,
  ScopeRef,
  Task,
  TaskAggregate,
  TaskId,
} from "@dsh-tempera/domain";
import { AuthorityStoreError, openSqliteAuthorityStore } from "../src/index";
import type {
  AuthorityStore,
  ExecuteTaskCommandInput,
  ResultCodec,
  TaskDecision,
} from "../src/index";

type SimpleResult = { ok: boolean; version?: number };
type WrappedResult = { result: { code: string } };

const taskId = "T1" as TaskId;

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

const taskScope: AuthorityScope = {
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
  creationSpec: descriptor("task-creation", "task-creation:1", {
    intent: "implement change",
  }),
  policySnapshot: descriptor("task-policy", "policy:default:1", {
    mode: "demo",
  }),
  authorityScope: taskScope,
});

const initialAggregate = (): TaskAggregate => createTask(activeTask());

const aggregateForTask = (id: TaskId): TaskAggregate => {
  const task: ActiveTask = { ...activeTask(), id };
  return createTask(task);
};

const completedAggregateForTask = (id: TaskId): TaskAggregate => {
  const task: Task = {
    ...activeTask(),
    id,
    status: "completed",
    completion: descriptor("task-completion", `task-completion:${id}`),
  };
  return {
    task,
    stages: {},
    invocations: {},
    candidates: {},
    reviews: {},
    approvals: {},
    operations: {},
    authority: { ineffectiveApprovalIds: [] },
  };
};

const simpleResultCodec: ResultCodec<SimpleResult> = {
  encode: (result) => result as JsonObject,
  decode: (value) => value as SimpleResult,
};

const wrappedResultCodec: ResultCodec<WrappedResult> = {
  encode: (result) => result as JsonObject,
  decode: (value) => value as WrappedResult,
};
const unknownResultCodec: ResultCodec<unknown> = {
  encode: (result) => result as JsonValue,
  decode: (value) => value,
};

const createInput = (
  overrides: Partial<ExecuteTaskCommandInput<SimpleResult>> = {},
): ExecuteTaskCommandInput<SimpleResult> => ({
  requestId: "req-1",
  payloadFingerprint: "fp-1",
  taskId,
  expectedVersion: 0,
  resultCodec: simpleResultCodec,
  onPreconditionFailure: () => {
    throw new Error("unexpected precondition failure");
  },
  ...overrides,
});

const commitDecision = (
  aggregate: TaskAggregate = initialAggregate(),
  facts: JsonObject[] = [{ type: "task-created", taskId }],
): TaskDecision<SimpleResult> => ({
  kind: "commit",
  nextAggregate: aggregate,
  facts,
  result: { ok: true, version: aggregate.task.version },
});

const withStore = (fn: (store: AuthorityStore, path: string) => void): void => {
  const dir = mkdtempSync(join(tmpdir(), "tempera-runtime-"));
  const path = join(dir, "authority.sqlite");
  const store = openSqliteAuthorityStore(path);
  try {
    fn(store, path);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
};
const nodeRequire = createRequire(import.meta.url);
const betterSqlite3Path = nodeRequire.resolve("better-sqlite3");

const startLockingChild = (dbPath: string) => {
  const script = `
    const Database = require(process.argv[2]);
    const db = new Database(process.argv[1], { timeout: 0 });
    db.pragma('locking_mode = EXCLUSIVE');
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = FULL');
    db.pragma('foreign_keys = ON');
    db.exec('BEGIN EXCLUSIVE');
    console.log('LOCKED');
    setTimeout(() => {}, 20000);
  `;
  const child = spawn(process.execPath, ["-e", script, dbPath, betterSqlite3Path], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const ready = new Promise<void>((resolve, reject) => {
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes("LOCKED")) {
        resolve();
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      reject(new Error(`locking child exited early (${code}): ${output}`));
    });
  });
  return { child, ready };
};

describe("AuthorityStore", () => {
  it("creates a task atomically with snapshot, journal, and receipt", () => {
    withStore((store) => {
      const response = store.executeTaskCommand(createInput(), () => commitDecision());

      expect(response).toEqual({
        delivery: "first-observation",
        result: { ok: true, version: 1 },
      });

      const task = store.getTask(taskId);
      expect(task?.observedVersion).toBe(1);
      expect(task?.aggregate.task.id).toBe(taskId);
      expect(task?.aggregate.task.status).toBe("active");

      expect(store.listTasks()).toEqual([
        {
          taskId,
          status: "active",
          version: 1,
          aggregateSchemaVersion: 1,
        },
      ]);

      expect(store.getAuthorityHistory(taskId)).toEqual([
        {
          taskId,
          committedVersion: 1,
          previousVersion: 0,
          commandIdentity: "req-1",
          facts: [{ type: "task-created", taskId }],
        },
      ]);
    });
  });
  it("fails with OWNERSHIP_CONFLICT while a child process holds the database lock", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tempera-lock-test-"));
    const path = join(dir, "authority.sqlite");
    const { child, ready } = startLockingChild(path);
    try {
      await ready;
      let error: unknown;
      try {
        openSqliteAuthorityStore(path);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(AuthorityStoreError);
      expect((error as AuthorityStoreError).code).toBe("OWNERSHIP_CONFLICT");
    } finally {
      child.kill();
      await new Promise((resolve) => child.once("exit", resolve));
      const reopened = openSqliteAuthorityStore(path);
      expect(reopened).toBeDefined();
      reopened.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("allows a child process to acquire the lock after the parent store closes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tempera-lock-release-"));
    const path = join(dir, "authority.sqlite");
    const store = openSqliteAuthorityStore(path);
    store.close();

    const { child, ready } = startLockingChild(path);
    try {
      await ready;
    } finally {
      child.kill();
      await new Promise((resolve) => child.once("exit", resolve));
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prevents a child process from acquiring the lock while the factory owns it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tempera-lock-test-"));
    const path = join(dir, "authority.sqlite");
    const store = openSqliteAuthorityStore(path);
    try {
      const script = `
        const Database = require(process.argv[2]);
        const db = new Database(process.argv[1], { timeout: 0 });
        db.pragma('locking_mode = EXCLUSIVE');
        try {
          db.exec('BEGIN EXCLUSIVE');
          console.log('UNEXPECTED_LOCK');
        } catch (error) {
          console.log(error && error.code ? error.code : String(error));
        }
      `;
      const result = spawnSync(process.execPath, ["-e", script, path, betterSqlite3Path], {
        encoding: "utf8",
        timeout: 5000,
      });
      expect(result.stdout).not.toContain("UNEXPECTED_LOCK");
      expect(result.stdout.trim()).toMatch(/SQLITE_BUSY|SQLITE_LOCKED/);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("replays the exact durable result without running callbacks", () => {
    withStore((store) => {
      const input = createInput();
      store.executeTaskCommand(input, () => commitDecision());

      let decideCalls = 0;
      const replay = store.executeTaskCommand({ ...input, payloadFingerprint: "fp-1" }, () => {
        decideCalls += 1;
        throw new Error("decide must not run on replay");
      });

      expect(replay).toEqual({
        delivery: "replay",
        result: { ok: true, version: 1 },
      });
      expect(decideCalls).toBe(0);
    });
  });

  it("rejects request id reuse with a different fingerprint without changing state", () => {
    withStore((store) => {
      const input = createInput();
      store.executeTaskCommand(input, () => commitDecision());

      expect(() =>
        store.executeTaskCommand({ ...input, payloadFingerprint: "fp-other" }, () =>
          commitDecision(),
        ),
      ).toThrowError(AuthorityStoreError);

      expect(store.getTask(taskId)?.observedVersion).toBe(1);
      expect(store.listTasks()).toHaveLength(1);
    });
  });

  it("writes a receipt for a version conflict and replays it after state advances", () => {
    withStore((store) => {
      store.executeTaskCommand(createInput(), () => commitDecision());

      const conflictRequest = "req-conflict";
      const conflict = store.executeTaskCommand(
        {
          requestId: conflictRequest,
          payloadFingerprint: "fp-conflict",
          taskId,
          expectedVersion: 2,
          resultCodec: simpleResultCodec,
          onPreconditionFailure: (failure) => {
            if (failure.kind === "task-not-found") {
              throw new Error("expected version conflict");
            }
            return {
              ok: false,
              version: failure.observedVersion,
            };
          },
        },
        () => {
          throw new Error("decide must not run on conflict");
        },
      );

      expect(conflict.delivery).toBe("first-observation");
      expect(conflict.result).toEqual({ ok: false, version: 1 });

      const baseAggregate = initialAggregate();
      const nextAggregate: TaskAggregate = {
        ...baseAggregate,
        task: { ...baseAggregate.task, version: 2 },
      };
      store.executeTaskCommand(
        {
          requestId: "req-advance",
          payloadFingerprint: "fp-advance",
          taskId,
          expectedVersion: 1,
          resultCodec: simpleResultCodec,
          onPreconditionFailure: () => {
            throw new Error("should not be called");
          },
        },
        () => ({
          kind: "commit",
          nextAggregate,
          facts: [{ type: "advanced", taskId }],
          result: { ok: true, version: 2 },
        }),
      );

      const replay = store.executeTaskCommand(
        {
          requestId: conflictRequest,
          payloadFingerprint: "fp-conflict",
          taskId,
          expectedVersion: 2,
          resultCodec: simpleResultCodec,
          onPreconditionFailure: () => {
            throw new Error("conflict handler must not run on replay");
          },
        },
        () => {
          throw new Error("decide must not run on replay");
        },
      );

      expect(replay).toEqual({
        delivery: "replay",
        result: { ok: false, version: 1 },
      });
      expect(store.getTask(taskId)?.observedVersion).toBe(2);
    });
  });

  it("persists a conflict handler result shaped as { result: ... } without unwrapping", () => {
    withStore((store) => {
      store.executeTaskCommand(createInput(), () => commitDecision());

      const conflict = store.executeTaskCommand(
        {
          requestId: "req-wrapped",
          payloadFingerprint: "fp-wrapped",
          taskId,
          expectedVersion: 99,
          resultCodec: wrappedResultCodec,
          onPreconditionFailure: () => ({ result: { code: "TASK_CONFLICT" } }),
        },
        () => {
          throw new Error("decide must not run on conflict");
        },
      );

      expect(conflict.delivery).toBe("first-observation");
      expect(conflict.result).toEqual({ result: { code: "TASK_CONFLICT" } });

      const replay = store.executeTaskCommand(
        {
          requestId: "req-wrapped",
          payloadFingerprint: "fp-wrapped",
          taskId,
          expectedVersion: 99,
          resultCodec: wrappedResultCodec,
          onPreconditionFailure: () => {
            throw new Error("handler must not run on replay");
          },
        },
        () => {
          throw new Error("decide must not run on replay");
        },
      );

      expect(replay).toEqual({
        delivery: "replay",
        result: { result: { code: "TASK_CONFLICT" } },
      });
      expect(store.getTask(taskId)?.observedVersion).toBe(1);
    });
  });

  it("rolls back all writes when a callback throws", () => {
    withStore((store) => {
      expect(() =>
        store.executeTaskCommand(createInput(), () => {
          throw new Error("boom");
        }),
      ).toThrowError("boom");

      expect(store.getTask(taskId)).toBeUndefined();
      expect(store.listTasks()).toEqual([]);
      expect(store.getAuthorityHistory(taskId)).toEqual([]);
    });
  });

  it("rolls back when a failpoint fires after snapshot and before receipt", () => {
    withStore((store) => {
      const sqliteStore = store as unknown as {
        setFailpoint(name: string, error?: unknown): void;
      };
      sqliteStore.setFailpoint("before-journal-write", new Error("failpoint"));

      expect(() => store.executeTaskCommand(createInput(), () => commitDecision())).toThrowError(
        "failpoint",
      );

      expect(store.getTask(taskId)).toBeUndefined();
      expect(store.listTasks()).toEqual([]);
      expect(store.getAuthorityHistory(taskId)).toEqual([]);
    });
  });
  it("leaves no partial durable state after each write failpoint", () => {
    const dir = mkdtempSync(join(tmpdir(), "tempera-failpoints-"));
    try {
      for (const failpoint of ["snapshot-write", "journal-write", "receipt-write", "commit"]) {
        const path = join(dir, `${failpoint}.sqlite`);
        const store = openSqliteAuthorityStore(path);
        const sqliteStore = store as unknown as {
          setFailpoint(name: string, error?: unknown): void;
        };
        sqliteStore.setFailpoint(failpoint, new Error("boom"));

        expect(() =>
          store.executeTaskCommand(createInput({ requestId: `req-${failpoint}` }), () =>
            commitDecision(),
          ),
        ).toThrowError("boom");

        store.close();

        const reopened = openSqliteAuthorityStore(path);
        expect(reopened.getTask(taskId)).toBeUndefined();
        expect(reopened.listTasks()).toEqual([]);
        expect(reopened.getAuthorityHistory(taskId)).toEqual([]);
        reopened.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns no-write receipts without changing snapshots or journal", () => {
    withStore((store) => {
      const response = store.executeTaskCommand(createInput({ requestId: "no-write" }), () => ({
        kind: "no-write",
        result: { ok: false, version: 0 },
      }));

      expect(response).toEqual({
        delivery: "first-observation",
        result: { ok: false, version: 0 },
      });
      expect(store.getTask(taskId)).toBeUndefined();
      expect(store.listTasks()).toEqual([]);
      expect(store.getAuthorityHistory(taskId)).toEqual([]);
    });
  });
  it("persists task-not-found and create-conflict receipts and replays them after state changes", () => {
    withStore((store) => {
      const notFound = store.executeTaskCommand(
        {
          ...createInput({ requestId: "not-found", expectedVersion: 1 }),
          onPreconditionFailure: () => ({ ok: false, version: 0 }),
        },
        () => {
          throw new Error("decide must not run on task-not-found");
        },
      );
      expect(notFound.delivery).toBe("first-observation");
      expect(notFound.result).toEqual({ ok: false, version: 0 });

      store.executeTaskCommand(createInput({ requestId: "create-task" }), () => commitDecision());

      const replayNotFound = store.executeTaskCommand(
        {
          ...createInput({ requestId: "not-found", expectedVersion: 1 }),
          onPreconditionFailure: () => {
            throw new Error("handler must not run on replay");
          },
        },
        () => {
          throw new Error("decide must not run on replay");
        },
      );
      expect(replayNotFound.result).toEqual({ ok: false, version: 0 });

      const createConflict = store.executeTaskCommand(
        {
          ...createInput({ requestId: "create-conflict", expectedVersion: 0 }),
          onPreconditionFailure: () => ({ ok: false, version: 1 }),
        },
        () => {
          throw new Error("decide must not run on create-conflict");
        },
      );
      expect(createConflict.result).toEqual({ ok: false, version: 1 });

      const baseAggregate = initialAggregate();
      const nextAggregate: TaskAggregate = {
        ...baseAggregate,
        task: { ...baseAggregate.task, version: 2 },
      };
      store.executeTaskCommand(
        createInput({ requestId: "advance-after-conflict", expectedVersion: 1 }),
        () => ({
          kind: "commit",
          nextAggregate,
          facts: [{ type: "advanced", taskId }],
          result: { ok: true, version: 2 },
        }),
      );

      const replayConflict = store.executeTaskCommand(
        {
          ...createInput({ requestId: "create-conflict", expectedVersion: 0 }),
          onPreconditionFailure: () => {
            throw new Error("handler must not run on replay");
          },
        },
        () => {
          throw new Error("decide must not run on replay");
        },
      );
      expect(replayConflict.result).toEqual({ ok: false, version: 1 });
    });
  });
  it("rejects non-JSON results and facts without leaving durable state", () => {
    withStore((store) => {
      const badResultRequest = "bad-result";
      const badResultInput = {
        ...createInput({ requestId: badResultRequest }),
        resultCodec: unknownResultCodec,
      } as unknown as ExecuteTaskCommandInput<SimpleResult>;

      expect(() =>
        store.executeTaskCommand(badResultInput, () => ({
          kind: "no-write",
          result: new Date() as unknown as SimpleResult,
        })),
      ).toThrowError(TypeError);

      expect(store.getTask(taskId)).toBeUndefined();
      expect(store.getAuthorityHistory(taskId)).toEqual([]);

      const retry = store.executeTaskCommand(createInput({ requestId: badResultRequest }), () =>
        commitDecision(),
      );
      expect(retry.delivery).toBe("first-observation");
      expect(retry.result).toEqual({ ok: true, version: 1 });

      const badFactInput = createInput({ requestId: "bad-fact", expectedVersion: 1 });
      const advancedAggregate: TaskAggregate = {
        ...initialAggregate(),
        task: { ...initialAggregate().task, version: 2 },
      };
      expect(() =>
        store.executeTaskCommand(badFactInput, () => ({
          kind: "commit",
          nextAggregate: advancedAggregate,
          facts: [new Date() as unknown as JsonObject],
          result: { ok: true, version: 2 },
        })),
      ).toThrowError(TypeError);

      expect(store.getTask(taskId)?.observedVersion).toBe(1);
      expect(store.getAuthorityHistory(taskId)).toHaveLength(1);
    });
  });

  it("rejects circular, sparse, and class-instance JSON values", () => {
    withStore((store) => {
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      const circularInput = {
        ...createInput({ requestId: "circular" }),
        resultCodec: unknownResultCodec,
      } as unknown as ExecuteTaskCommandInput<SimpleResult>;

      expect(() =>
        store.executeTaskCommand(circularInput, () => ({
          kind: "no-write",
          result: circular as unknown as SimpleResult,
        })),
      ).toThrowError(TypeError);

      const sparseInput = {
        ...createInput({ requestId: "sparse" }),
        resultCodec: unknownResultCodec,
      } as unknown as ExecuteTaskCommandInput<SimpleResult>;
      const sparse: unknown[] = [];
      sparse.length = 1;
      expect(() =>
        store.executeTaskCommand(sparseInput, () => ({
          kind: "no-write",
          result: sparse as unknown as SimpleResult,
        })),
      ).toThrowError(TypeError);

      class Example {}
      const classInput = {
        ...createInput({ requestId: "class" }),
        resultCodec: unknownResultCodec,
      } as unknown as ExecuteTaskCommandInput<SimpleResult>;
      expect(() =>
        store.executeTaskCommand(classInput, () => ({
          kind: "no-write",
          result: new Example() as unknown as SimpleResult,
        })),
      ).toThrowError(TypeError);

      expect(store.listTasks()).toEqual([]);
      expect(store.getAuthorityHistory(taskId)).toEqual([]);
    });
  });

  it("accepts plain objects, null-prototype objects, and dense nested arrays", () => {
    withStore((store) => {
      const plain = { nested: [1, 2, { ok: true }] };
      const nullProto = Object.assign(Object.create(null), { value: 42 });
      const input = {
        ...createInput({ requestId: "json-ok" }),
        resultCodec: unknownResultCodec,
      } as unknown as ExecuteTaskCommandInput<SimpleResult>;

      const response = store.executeTaskCommand(input, () => ({
        kind: "no-write",
        result: { plain, nullProto } as unknown as SimpleResult,
      }));

      expect(response.delivery).toBe("first-observation");
      const replay = store.executeTaskCommand({ ...input, payloadFingerprint: "fp-1" }, () => {
        throw new Error("decide must not run on replay");
      });
      expect(replay.delivery).toBe("replay");
      expect(replay.result).toEqual({
        plain: { nested: [1, 2, { ok: true }] },
        nullProto: { value: 42 },
      });
    });
  });
  it("does not execute a toJSON getter while rejecting the value", () => {
    withStore((store) => {
      let toJsonReads = 0;
      const value: Record<string, unknown> = {};
      Object.defineProperty(value, "toJSON", {
        enumerable: true,
        get: () => {
          toJsonReads += 1;
          return {};
        },
      });

      const input = {
        ...createInput({ requestId: "tojson-getter" }),
        resultCodec: unknownResultCodec,
      } as unknown as ExecuteTaskCommandInput<SimpleResult>;

      expect(() =>
        store.executeTaskCommand(input, () => ({
          kind: "no-write",
          result: value as unknown as SimpleResult,
        })),
      ).toThrowError(TypeError);
      expect(toJsonReads).toBe(0);

      expect(store.getTask(taskId)).toBeUndefined();
      const retry = store.executeTaskCommand(createInput({ requestId: "tojson-getter" }), () =>
        commitDecision(),
      );
      expect(retry.delivery).toBe("first-observation");
    });
  });
  it("does not execute a nextAggregate toJSON getter during commit encoding", () => {
    withStore((store) => {
      const base = initialAggregate();
      let toJsonReads = 0;
      const nextAggregate = { ...base } as TaskAggregate;
      Object.defineProperty(nextAggregate, "toJSON", {
        enumerable: true,
        get: () => {
          toJsonReads += 1;
          return {};
        },
      });

      expect(() =>
        store.executeTaskCommand(createInput({ requestId: "tojson-aggregate" }), () => ({
          kind: "commit",
          nextAggregate,
          facts: [{ type: "task-created", taskId }],
          result: { ok: true, version: 1 },
        })),
      ).toThrowError(TypeError);
      expect(toJsonReads).toBe(0);
      expect(store.getTask(taskId)).toBeUndefined();
      expect(store.getAuthorityHistory(taskId)).toEqual([]);

      const retry = store.executeTaskCommand(createInput({ requestId: "tojson-aggregate" }), () =>
        commitDecision(),
      );
      expect(retry.delivery).toBe("first-observation");
      expect(retry.result).toEqual({ ok: true, version: 1 });
    });
  });

  it("preserves state and schema version across reopen", () => {
    const dir = mkdtempSync(join(tmpdir(), "tempera-reopen-"));
    const path = join(dir, "authority.sqlite");
    const store = openSqliteAuthorityStore(path);
    store.executeTaskCommand(createInput(), () => commitDecision());
    store.close();

    const reopened = openSqliteAuthorityStore(path);
    expect(reopened.getTask(taskId)?.observedVersion).toBe(1);
    expect(reopened.getTask(taskId)?.aggregateSchemaVersion).toBe(1);
    expect(reopened.listTasks()).toEqual([
      {
        taskId,
        status: "active",
        version: 1,
        aggregateSchemaVersion: 1,
      },
    ]);
    expect(reopened.getAuthorityHistory(taskId)).toHaveLength(1);
    reopened.close();
    rmSync(dir, { recursive: true, force: true });
  });
  it("supports listTasks keyset pagination, status filtering, limits, and reopen stability", () => {
    const dir = mkdtempSync(join(tmpdir(), "tempera-list-paging-"));
    const path = join(dir, "authority.sqlite");
    const store = openSqliteAuthorityStore(path);

    const t1 = "T1" as TaskId;
    const t2 = "T2" as TaskId;
    const t3 = "T3" as TaskId;

    // Insert out of taskId order and mix statuses.
    store.executeTaskCommand(createInput({ requestId: "page-t3", taskId: t3 }), () => ({
      kind: "commit",
      nextAggregate: aggregateForTask(t3),
      facts: [{ type: "task-created", taskId: t3 }],
      result: { ok: true, version: 1 },
    }));
    store.executeTaskCommand(createInput({ requestId: "page-t1", taskId: t1 }), () => ({
      kind: "commit",
      nextAggregate: completedAggregateForTask(t1),
      facts: [{ type: "task-created", taskId: t1 }],
      result: { ok: true, version: 1 },
    }));
    store.executeTaskCommand(createInput({ requestId: "page-t2", taskId: t2 }), () => ({
      kind: "commit",
      nextAggregate: aggregateForTask(t2),
      facts: [{ type: "task-created", taskId: t2 }],
      result: { ok: true, version: 1 },
    }));

    expect(store.listTasks().map((row) => row.taskId)).toEqual([t1, t2, t3]);
    expect(store.listTasks({ status: "active" }).map((row) => row.taskId)).toEqual([t2, t3]);
    expect(store.listTasks({ status: "completed" }).map((row) => row.taskId)).toEqual([t1]);

    expect(store.listTasks({ limit: 2 }).map((row) => row.taskId)).toEqual([t1, t2]);
    expect(store.listTasks({ afterTaskId: t1 }).map((row) => row.taskId)).toEqual([t2, t3]);
    expect(store.listTasks({ afterTaskId: t2, limit: 1 }).map((row) => row.taskId)).toEqual([t3]);
    expect(store.listTasks({ cursor: t1 }).map((row) => row.taskId)).toEqual([t2, t3]);
    expect(
      store.listTasks({ status: "active", cursor: t2, limit: 1 }).map((row) => row.taskId),
    ).toEqual([t3]);

    store.close();
    const reopened = openSqliteAuthorityStore(path);
    expect(reopened.listTasks().map((row) => row.taskId)).toEqual([t1, t2, t3]);
    expect(
      reopened.listTasks({ status: "completed", cursor: t1, limit: 1 }).map((row) => row.taskId),
    ).toEqual([]);
    expect(
      reopened.listTasks({ status: "active", cursor: t1, limit: 1 }).map((row) => row.taskId),
    ).toEqual([t2]);
    expect(reopened.listTasks({ afterTaskId: t2, limit: 1 }).map((row) => row.taskId)).toEqual([
      t3,
    ]);
    reopened.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("supports authority history keyset pagination and reopen stability", () => {
    const dir = mkdtempSync(join(tmpdir(), "tempera-history-paging-"));
    const path = join(dir, "authority.sqlite");
    const store = openSqliteAuthorityStore(path);
    store.executeTaskCommand(createInput({ requestId: "hist-1" }), () => commitDecision());

    const advanceTo = (version: number, requestId: string) => {
      const base = initialAggregate();
      const nextAggregate: TaskAggregate = {
        ...base,
        task: { ...base.task, version },
      };
      store.executeTaskCommand(createInput({ requestId, expectedVersion: version - 1 }), () => ({
        kind: "commit",
        nextAggregate,
        facts: [{ type: "advanced", version }],
        result: { ok: true, version },
      }));
    };

    advanceTo(2, "hist-2");
    advanceTo(3, "hist-3");

    const all = store.getAuthorityHistory(taskId);
    expect(all.map((row) => row.committedVersion)).toEqual([1, 2, 3]);
    expect(
      store
        .getAuthorityHistory(taskId, { afterCommittedVersion: 1 })
        .map((row) => row.committedVersion),
    ).toEqual([2, 3]);
    expect(
      store
        .getAuthorityHistory(taskId, { afterCommittedVersion: 1, limit: 1 })
        .map((row) => row.committedVersion),
    ).toEqual([2]);

    store.close();
    const reopened = openSqliteAuthorityStore(path);
    expect(
      reopened
        .getAuthorityHistory(taskId, { afterCommittedVersion: 2 })
        .map((row) => row.committedVersion),
    ).toEqual([3]);
    reopened.close();
    rmSync(dir, { recursive: true, force: true });
  });
  it("rejects invalid version advances and wrong task ids without leaving durable residue", () => {
    withStore((store) => {
      store.executeTaskCommand(createInput({ requestId: "base-commit" }), () => commitDecision());

      const noAdvance = createInput({ requestId: "no-advance", expectedVersion: 1 });
      expect(() =>
        store.executeTaskCommand(noAdvance, () => ({
          kind: "commit",
          nextAggregate: initialAggregate(),
          facts: [{ type: "bad", taskId }],
          result: { ok: true, version: 1 },
        })),
      ).toThrowError();

      let noAdvanceRetryCalls = 0;
      const noAdvanceRetry = store.executeTaskCommand(noAdvance, () => {
        noAdvanceRetryCalls += 1;
        return { kind: "no-write", result: { ok: false, version: 1 } };
      });
      expect(noAdvanceRetry.delivery).toBe("first-observation");
      expect(noAdvanceRetryCalls).toBe(1);

      const base = initialAggregate();
      const skipAggregate: TaskAggregate = {
        ...base,
        task: { ...base.task, version: 3 },
      };
      const skipVersion = createInput({ requestId: "skip-version", expectedVersion: 1 });
      expect(() =>
        store.executeTaskCommand(skipVersion, () => ({
          kind: "commit",
          nextAggregate: skipAggregate,
          facts: [{ type: "bad", taskId }],
          result: { ok: true, version: 3 },
        })),
      ).toThrowError();

      let skipRetryCalls = 0;
      const skipRetry = store.executeTaskCommand(skipVersion, () => {
        skipRetryCalls += 1;
        return { kind: "no-write", result: { ok: false, version: 1 } };
      });
      expect(skipRetry.delivery).toBe("first-observation");
      expect(skipRetryCalls).toBe(1);

      const wrongTask = createInput({ requestId: "wrong-task", expectedVersion: 1 });
      expect(() =>
        store.executeTaskCommand(wrongTask, () => ({
          kind: "commit",
          nextAggregate: aggregateForTask("T2" as TaskId),
          facts: [{ type: "bad", taskId }],
          result: { ok: true, version: 2 },
        })),
      ).toThrowError();

      let wrongTaskRetryCalls = 0;
      const wrongTaskRetry = store.executeTaskCommand(wrongTask, () => {
        wrongTaskRetryCalls += 1;
        return { kind: "no-write", result: { ok: false, version: 1 } };
      });
      expect(wrongTaskRetry.delivery).toBe("first-observation");
      expect(wrongTaskRetryCalls).toBe(1);

      expect(store.getTask(taskId)?.observedVersion).toBe(1);
      expect(store.getAuthorityHistory(taskId)).toHaveLength(1);
      expect(store.listTasks()).toHaveLength(1);
    });
  });

  it("rejects UPDATE and DELETE on journal and receipt tables", () => {
    const dir = mkdtempSync(join(tmpdir(), "tempera-triggers-"));
    const path = join(dir, "authority.sqlite");
    const store = openSqliteAuthorityStore(path);
    store.executeTaskCommand(createInput(), () => commitDecision());
    store.close();

    const Database = nodeRequire(betterSqlite3Path) as new (path: string) => {
      prepare(sql: string): { run(...params: unknown[]): unknown };
      close(): void;
    };
    const db = new Database(path);
    try {
      expect(() =>
        db
          .prepare("UPDATE command_receipts SET result_json = ? WHERE request_id = ?")
          .run("{}", "req-1"),
      ).toThrowError();
      expect(() =>
        db.prepare("DELETE FROM command_receipts WHERE request_id = ?").run("req-1"),
      ).toThrowError();
      expect(() =>
        db
          .prepare("UPDATE authority_commits SET facts_json = ? WHERE task_id = ?")
          .run("[]", taskId),
      ).toThrowError();
      expect(() =>
        db.prepare("DELETE FROM authority_commits WHERE task_id = ?").run(taskId),
      ).toThrowError();
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("migrates an empty database from user_version 0 to 1 idempotently", () => {
    const dir = mkdtempSync(join(tmpdir(), "tempera-migrate-"));
    const path = join(dir, "authority.sqlite");
    const Database = nodeRequire(betterSqlite3Path) as unknown as new (path: string) => {
      pragma(source: string, options?: { simple?: boolean }): unknown;
      prepare(sql: string): { get(): { count: number } };
      close(): void;
    };

    const before = new Database(path);
    expect(before.pragma("user_version", { simple: true })).toBe(0);
    before.close();

    const store = openSqliteAuthorityStore(path);
    store.close();

    const after = new Database(path);
    expect(after.pragma("user_version", { simple: true })).toBe(1);
    const tableCount = after
      .prepare(
        "SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name IN ('task_snapshots', 'authority_commits', 'command_receipts')",
      )
      .get().count;
    expect(tableCount).toBe(3);
    after.close();

    const reopened = openSqliteAuthorityStore(path);
    reopened.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects a future database schema version", () => {
    const dir = mkdtempSync(join(tmpdir(), "tempera-future-schema-"));
    const path = join(dir, "authority.sqlite");
    const Database = nodeRequire(betterSqlite3Path) as new (path: string) => {
      pragma(source: string, options?: { simple?: boolean }): unknown;
      close(): void;
    };
    const db = new Database(path);
    db.pragma("user_version = 99");
    db.close();

    let error: unknown;
    try {
      openSqliteAuthorityStore(path);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(AuthorityStoreError);
    expect((error as AuthorityStoreError).code).toBe("UNSUPPORTED_DATABASE_SCHEMA");
    rmSync(dir, { recursive: true, force: true });
  });
  it("returns CORRUPT_DATA for corrupted snapshot, journal facts, and receipt result", () => {
    const baseDir = mkdtempSync(join(tmpdir(), "tempera-corrupt-"));
    try {
      const Database = nodeRequire(betterSqlite3Path) as unknown as new (path: string) => {
        exec(sql: string): unknown;
        prepare(sql: string): { run(...params: unknown[]): unknown };
        close(): void;
      };

      const snapshotPath = join(baseDir, "snapshot.sqlite");
      let store = openSqliteAuthorityStore(snapshotPath);
      store.executeTaskCommand(createInput(), () => commitDecision());
      store.close();
      let db = new Database(snapshotPath);
      db.prepare("UPDATE task_snapshots SET aggregate_json = ? WHERE task_id = ?").run(
        "{bad-json",
        taskId,
      );
      db.close();
      store = openSqliteAuthorityStore(snapshotPath);
      let snapshotError: unknown;
      try {
        store.getTask(taskId);
      } catch (error) {
        snapshotError = error;
      }
      expect(snapshotError).toBeInstanceOf(AuthorityStoreError);
      expect((snapshotError as AuthorityStoreError).code).toBe("CORRUPT_DATA");
      store.close();

      const factsPath = join(baseDir, "facts.sqlite");
      store = openSqliteAuthorityStore(factsPath);
      store.executeTaskCommand(createInput(), () => commitDecision());
      store.close();
      db = new Database(factsPath);
      db.exec(`
        DROP TRIGGER IF EXISTS authority_commits_no_update;
        DROP TRIGGER IF EXISTS authority_commits_no_delete;
      `);
      db.prepare("UPDATE authority_commits SET facts_json = ? WHERE task_id = ?").run(
        "{bad-json",
        taskId,
      );
      db.close();
      store = openSqliteAuthorityStore(factsPath);
      let factsError: unknown;
      try {
        store.getAuthorityHistory(taskId);
      } catch (error) {
        factsError = error;
      }
      expect(factsError).toBeInstanceOf(AuthorityStoreError);
      expect((factsError as AuthorityStoreError).code).toBe("CORRUPT_DATA");
      store.close();

      const resultPath = join(baseDir, "result.sqlite");
      store = openSqliteAuthorityStore(resultPath);
      store.executeTaskCommand(createInput(), () => commitDecision());
      store.close();
      db = new Database(resultPath);
      db.exec(`
        DROP TRIGGER IF EXISTS command_receipts_no_update;
        DROP TRIGGER IF EXISTS command_receipts_no_delete;
      `);
      db.prepare("UPDATE command_receipts SET result_json = ? WHERE request_id = ?").run(
        "{bad-json",
        "req-1",
      );
      db.close();
      store = openSqliteAuthorityStore(resultPath);
      let resultError: unknown;
      try {
        store.executeTaskCommand(createInput(), () => {
          throw new Error("decide must not run on corrupt receipt");
        });
      } catch (error) {
        resultError = error;
      }
      expect(resultError).toBeInstanceOf(AuthorityStoreError);
      expect((resultError as AuthorityStoreError).code).toBe("CORRUPT_DATA");
      store.close();
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("fails after close", () => {
    withStore((store) => {
      store.close();
      expect(() => store.getTask(taskId)).toThrowError(AuthorityStoreError);
      expect(() => store.executeTaskCommand(createInput(), () => commitDecision())).toThrowError(
        AuthorityStoreError,
      );
    });
  });
});
