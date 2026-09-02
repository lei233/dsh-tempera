import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { expectAuthorityCorruption, mutateReceipt, tempAuthorityStore } from "./test-utils";
import type {
  ActiveTask,
  AuthorityAction,
  AuthorityScope,
  DescriptorIdentity,
  FrozenDescriptor,
  JsonObject,
  ScopeRef,
  Stage,
  StageId,
  TaskId,
} from "@dsh-tempera/domain";
import {
  createHostApplication,
  openSqliteAuthorityStore,
  type AuthorityStore,
  type HostRequestId,
} from "../src/index";
import { executeRuntimeCommand, type RuntimeCommandEnvelope } from "../src/internal-runtime";

const taskId = "T1" as TaskId;
const stageId = "S1" as StageId;

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
  creationSpec: descriptor("task-creation", "task-creation:1", { intent: "demo" }),
  policySnapshot: descriptor("task-policy", "policy:1", { mode: "demo" }),
  authorityScope: scope,
});

const stage = (id: StageId = stageId): Stage => ({
  id,
  taskId,
  role: "work",
  kind: "demo",
  contractVersion: "1",
  materializationKey: `work:${id}` as Stage["materializationKey"],
  semanticInputs: [{ name: "task", value: { type: "task", id: taskId } }],
  realizationRequirement: descriptor("realization-requirement", `req:${id}`),
  allowedScope: scope,
  currentExecutionGeneration: 0,
  status: "pending",
});

const withStore = (fn: (store: AuthorityStore) => void): void => {
  const dir = mkdtempSync(join(tmpdir(), "tempera-runtime-internal-"));
  const path = join(dir, "internal.sqlite");
  const store = openSqliteAuthorityStore(path);
  try {
    fn(store);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
};

const createHostTask = (store: AuthorityStore): void => {
  const app = createHostApplication(store, {
    taskId: () => taskId,
    reviewId: () => "R1" as never,
  });
  app.execute({
    contractVersion: "tempera.host-command.v1",
    requestId: "host-create" as HostRequestId,
    expectedVersion: 0,
    command: {
      type: "create-task",
      creationSpec: activeTask().creationSpec,
      policySnapshot: activeTask().policySnapshot,
      authorityScope: activeTask().authorityScope,
    },
  });
};

const runtimeEnvelope = (
  overrides: Partial<RuntimeCommandEnvelope> = {},
): RuntimeCommandEnvelope => ({
  contractVersion: "tempera.runtime-command.v1",
  requestId: "tempera:stage-1",
  taskId,
  expectedVersion: 1,
  command: {
    type: "materialize-stage",
    stage: stage(),
  },
  ...overrides,
});

const assertInternalCorruption = (
  envelope: RuntimeCommandEnvelope,
  mutatedResult: unknown,
): void => {
  const fixture = tempAuthorityStore("tempera-internal-corrupt-");
  try {
    createHostTask(fixture.store);
    executeRuntimeCommand(fixture.store, envelope);
    fixture.store.close();
    mutateReceipt(fixture.path, envelope.requestId, mutatedResult);

    const reopened = openSqliteAuthorityStore(fixture.path);
    try {
      expectAuthorityCorruption(() => executeRuntimeCommand(reopened, envelope));
    } finally {
      reopened.close();
    }
  } finally {
    fixture.cleanup();
  }
};

describe("executeRuntimeCommand", () => {
  it("shares the ledger and requires the reserved identity namespace", () => {
    withStore((store) => {
      const app = createHostApplication(store, {
        taskId: () => taskId,
        reviewId: () => "R1" as never,
      });
      app.execute({
        contractVersion: "tempera.host-command.v1",
        requestId: "host-create" as HostRequestId,
        expectedVersion: 0,
        command: {
          type: "create-task",
          creationSpec: activeTask().creationSpec,
          policySnapshot: activeTask().policySnapshot,
          authorityScope: activeTask().authorityScope,
        },
      });

      const envelope: RuntimeCommandEnvelope = {
        contractVersion: "tempera.runtime-command.v1",
        requestId: "tempera:stage-1",
        taskId,
        expectedVersion: 1,
        command: {
          type: "materialize-stage",
          stage: stage(),
        },
      };

      const response = executeRuntimeCommand(store, envelope);
      expect(response.delivery).toBe("first-observation");
      expect(response.result).toMatchObject({
        kind: "committed",
        taskId,
        committedVersion: 2,
      });

      const replay = executeRuntimeCommand(store, envelope);
      expect(replay.delivery).toBe("replay");
      expect(replay.result).toEqual(response.result);

      expect(store.getTask(taskId)?.aggregate.stages[stageId]).toBeDefined();
      expect(store.getAuthorityHistory(taskId)).toHaveLength(2);
    });
  });

  it("rejects a non-reserved runtime request id", () => {
    withStore((store) => {
      const app = createHostApplication(store, {
        taskId: () => taskId,
        reviewId: () => "R1" as never,
      });
      app.execute({
        contractVersion: "tempera.host-command.v1",
        requestId: "host-create" as HostRequestId,
        expectedVersion: 0,
        command: {
          type: "create-task",
          creationSpec: activeTask().creationSpec,
          policySnapshot: activeTask().policySnapshot,
          authorityScope: activeTask().authorityScope,
        },
      });

      expect(() =>
        executeRuntimeCommand(store, {
          contractVersion: "tempera.runtime-command.v1",
          requestId: "not-reserved",
          taskId,
          expectedVersion: 1,
          command: {
            type: "materialize-stage",
            stage: stage(),
          },
        }),
      ).toThrowError(TypeError);
    });
  });
  it("rejects expectedVersion 0 and empty task ids before touching the store", () => {
    withStore((store) => {
      const app = createHostApplication(store, {
        taskId: () => taskId,
        reviewId: () => "R1" as never,
      });
      app.execute({
        contractVersion: "tempera.host-command.v1",
        requestId: "host-create" as HostRequestId,
        expectedVersion: 0,
        command: {
          type: "create-task",
          creationSpec: activeTask().creationSpec,
          policySnapshot: activeTask().policySnapshot,
          authorityScope: activeTask().authorityScope,
        },
      });

      expect(() =>
        executeRuntimeCommand(store, {
          contractVersion: "tempera.runtime-command.v1",
          requestId: "tempera:bad-version",
          taskId,
          expectedVersion: 0,
          command: {
            type: "materialize-stage",
            stage: stage(),
          },
        }),
      ).toThrowError(TypeError);

      expect(() =>
        executeRuntimeCommand(store, {
          contractVersion: "tempera.runtime-command.v1",
          requestId: "tempera:bad-task",
          taskId: "" as TaskId,
          expectedVersion: 1,
          command: {
            type: "materialize-stage",
            stage: stage(),
          },
        }),
      ).toThrowError(TypeError);
    });
  });

  it("persists TASK_VERSION_CONFLICT and allows a fresh request at the new version", () => {
    withStore((store) => {
      const app = createHostApplication(store, {
        taskId: () => taskId,
        reviewId: () => "R1" as never,
      });
      app.execute({
        contractVersion: "tempera.host-command.v1",
        requestId: "host-create" as HostRequestId,
        expectedVersion: 0,
        command: {
          type: "create-task",
          creationSpec: activeTask().creationSpec,
          policySnapshot: activeTask().policySnapshot,
          authorityScope: activeTask().authorityScope,
        },
      });

      const first: RuntimeCommandEnvelope = {
        contractVersion: "tempera.runtime-command.v1",
        requestId: "tempera:stage-1",
        taskId,
        expectedVersion: 1,
        command: {
          type: "materialize-stage",
          stage: stage(),
        },
      };
      expect(executeRuntimeCommand(store, first).result).toMatchObject({
        kind: "committed",
        committedVersion: 2,
      });

      const stale: RuntimeCommandEnvelope = {
        contractVersion: "tempera.runtime-command.v1",
        requestId: "tempera:stage-stale",
        taskId,
        expectedVersion: 1,
        command: {
          type: "materialize-stage",
          stage: stage("S2" as StageId),
        },
      };
      const conflict = executeRuntimeCommand(store, stale);
      expect(conflict.delivery).toBe("first-observation");
      expect(conflict.result).toEqual({
        kind: "rejected",
        taskId,
        code: "TASK_VERSION_CONFLICT",
        expectedVersion: 1,
        observedVersion: 2,
      });

      const replay = executeRuntimeCommand(store, stale);
      expect(replay.delivery).toBe("replay");
      expect(replay.result).toEqual(conflict.result);
      expect(store.getTask(taskId)?.observedVersion).toBe(2);

      const retry: RuntimeCommandEnvelope = {
        ...stale,
        requestId: "tempera:stage-2",
        expectedVersion: 2,
      };
      const success = executeRuntimeCommand(store, retry);
      expect(success.delivery).toBe("first-observation");
      expect(success.result).toMatchObject({
        kind: "committed",
        committedVersion: 3,
      });
    });
  });
  describe("internal runtime result corruption matrix", () => {
    it("rejects malformed committed and accepted-no-write results", () => {
      const envelope = runtimeEnvelope();
      const cases: Record<string, unknown>[] = [
        { kind: "unknown" },
        { kind: "committed", taskId },
        { kind: "committed", taskId, committedVersion: 0 },
        { kind: "committed", taskId, committedVersion: -1 },
        { kind: "committed", taskId, committedVersion: 1.5 },
        { kind: "committed", taskId, committedVersion: 2, extra: true },
        { kind: "accepted-no-write", taskId },
        { kind: "accepted-no-write", taskId, observedVersion: 0 },
        { kind: "accepted-no-write", taskId, observedVersion: -1 },
        { kind: "accepted-no-write", taskId, observedVersion: 1.5 },
        { kind: "accepted-no-write", taskId, observedVersion: 2, extra: true },
      ];
      for (const result of cases) {
        assertInternalCorruption(envelope, result);
      }
    });

    it("rejects malformed rejected results", () => {
      const envelope = runtimeEnvelope();
      const cases: Record<string, unknown>[] = [
        { kind: "rejected", taskId, code: "UNKNOWN_CODE" },
        { kind: "rejected", taskId, code: "TASK_NOT_FOUND", extra: true },
        { kind: "rejected", taskId, code: "TASK_VERSION_CONFLICT", observedVersion: 2 },
        { kind: "rejected", taskId, code: "TASK_VERSION_CONFLICT", expectedVersion: 1 },
        {
          kind: "rejected",
          taskId,
          code: "TASK_VERSION_CONFLICT",
          expectedVersion: 0,
          observedVersion: 2,
        },
        {
          kind: "rejected",
          taskId,
          code: "TASK_VERSION_CONFLICT",
          expectedVersion: -1,
          observedVersion: 2,
        },
        {
          kind: "rejected",
          taskId,
          code: "TASK_VERSION_CONFLICT",
          expectedVersion: 1.5,
          observedVersion: 2,
        },
        {
          kind: "rejected",
          taskId,
          code: "TASK_VERSION_CONFLICT",
          expectedVersion: 1,
          observedVersion: 0,
        },
        {
          kind: "rejected",
          taskId,
          code: "TASK_VERSION_CONFLICT",
          expectedVersion: 1,
          observedVersion: -1,
        },
        {
          kind: "rejected",
          taskId,
          code: "TASK_VERSION_CONFLICT",
          expectedVersion: 1,
          observedVersion: 1.5,
        },
        {
          kind: "rejected",
          taskId,
          code: "TASK_VERSION_CONFLICT",
          expectedVersion: 1,
          observedVersion: 2,
          extra: true,
        },
        { kind: "rejected", taskId, code: "TASK_NOT_FOUND", expectedVersion: 1 },
        { kind: "rejected", taskId, code: "TASK_NOT_FOUND", observedVersion: 1 },
        { kind: "rejected", taskId, code: "STAGE_ALREADY_EXISTS", expectedVersion: 1 },
        { kind: "rejected", taskId, code: "STAGE_ALREADY_EXISTS", observedVersion: 1 },
      ];
      for (const result of cases) {
        assertInternalCorruption(envelope, result);
      }
    });

    it("rejects stored runtime task ID mismatches", () => {
      assertInternalCorruption(runtimeEnvelope(), {
        kind: "committed",
        taskId: "T2" as TaskId,
        committedVersion: 2,
      });
      assertInternalCorruption(runtimeEnvelope(), {
        kind: "rejected",
        taskId: "T2" as TaskId,
        code: "TASK_NOT_FOUND",
      });
    });

    it("successfully replays a real DomainRejectionCode rejection", () => {
      const fixture = tempAuthorityStore("tempera-internal-domain-");
      try {
        createHostTask(fixture.store);
        const first = runtimeEnvelope();
        const committed = executeRuntimeCommand(fixture.store, first);
        expect(committed.result).toMatchObject({ kind: "committed", committedVersion: 2 });

        const duplicate: RuntimeCommandEnvelope = {
          ...runtimeEnvelope(),
          requestId: "tempera:duplicate",
          expectedVersion: 2,
        };
        const rejection = executeRuntimeCommand(fixture.store, duplicate);
        expect(rejection.delivery).toBe("first-observation");
        expect(rejection.result).toMatchObject({
          kind: "rejected",
          code: "STAGE_ALREADY_EXISTS",
        });

        const replay = executeRuntimeCommand(fixture.store, duplicate);
        expect(replay.delivery).toBe("replay");
        expect(replay.result).toEqual(rejection.result);
      } finally {
        fixture.cleanup();
      }
    });
  });
});
