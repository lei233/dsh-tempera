import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  cursorFromJson,
  expectAuthorityCorruption,
  getReceiptCount,
  mutateReceipt,
  openRawDatabase,
  tempAuthorityStore,
  withTempAuthorityStore,
} from "./test-utils";
import type {
  ActorRef,
  ArtifactBinding,
  AuthorityAction,
  AuthorityScope,
  Candidate,
  CandidateId,
  DescriptorIdentity,
  FrozenDescriptor,
  JsonObject,
  Operation,
  OperationId,
  ReviewId,
  ScopeRef,
  Stage,
  StageId,
  TaskAggregate,
  TaskId,
} from "@dsh-tempera/domain";
import {
  HostCommandProtocolError,
  HostQueryProtocolError,
  createHostApplication,
  openSqliteAuthorityStore,
  type AuthorityStore,
  type HostCommandEnvelope,
  type HostRequestId,
  type ResultCodec,
} from "../src/index";

const taskId = "T1" as TaskId;
const stageId = "S1" as StageId;
const candidateId = "C1" as CandidateId;
const reviewId = "R1" as ReviewId;
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

const evaluationStage = (): Stage => ({
  id: stageId,
  taskId,
  role: "evaluation",
  kind: "host-review",
  contractVersion: "1",
  materializationKey: "review:1" as Stage["materializationKey"],
  semanticInputs: [
    { name: "candidate", value: { type: "candidate", id: candidateId } },
    { name: "authority-requirement", value: descriptor("authority-requirement", "req:review:1") },
  ],
  realizationRequirement: descriptor("realization-requirement", "req:realization:1"),
  allowedScope: scope,
  currentExecutionGeneration: 0,
  status: "active",
});

const candidateEntity = (): Candidate => ({
  id: candidateId,
  taskId,
  producedByInvocationId: "I1" as Candidate["producedByInvocationId"],
  artifact: artifact("candidate:1"),
  scopeRef: "repo:demo/read" as ScopeRef,
});

const preparedOperation = (): Operation => ({
  id: operationId,
  taskId,
  stageId,
  candidateId,
  approvalId: "A1" as Operation["approvalId"],
  targetScopeRef: "repo:demo/read" as ScopeRef,
  precondition: descriptor("effect-precondition", "pre:1"),
  effectKey: "apply:1" as Operation["effectKey"],
  status: "prepared",
});

const simpleResultCodec: ResultCodec<{ ok: boolean }> = {
  encode: (result) => result as JsonObject,
  decode: (value) => value as { ok: boolean },
};

const withStore = (fn: (store: AuthorityStore, path: string) => void): void => {
  const dir = mkdtempSync(join(tmpdir(), "tempera-host-"));
  const path = join(dir, "host.sqlite");
  const store = openSqliteAuthorityStore(path);
  try {
    fn(store, path);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
};

const defaultHostIds = (): { taskId: () => TaskId; reviewId: () => ReviewId } => ({
  taskId: () => taskId,
  reviewId: () => reviewId,
});

const assertHostQueryError = (
  action: () => unknown,
  code: HostQueryProtocolError["code"],
): void => {
  let error: unknown;
  try {
    action();
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(HostQueryProtocolError);
  expect((error as HostQueryProtocolError).code).toBe(code);
};

const snapshotCommandState = (store: AuthorityStore, targetTaskId: TaskId) => ({
  task: store.getTask(targetTaskId),
  history: store.getAuthorityHistory(targetTaskId),
  receiptCount: getReceiptCount(store),
});

const assertHostCorruption = (
  envelope: HostCommandEnvelope,
  mutatedResult: unknown,
  ids: ReturnType<typeof defaultHostIds> = defaultHostIds(),
): void => {
  const fixture = tempAuthorityStore("tempera-host-corrupt-");
  const app = createHostApplication(fixture.store, ids);
  try {
    app.execute(envelope);
    fixture.store.close();
    mutateReceipt(fixture.path, envelope.requestId, mutatedResult);

    const reopened = openSqliteAuthorityStore(fixture.path);
    try {
      const reopenedApp = createHostApplication(reopened, ids);
      expectAuthorityCorruption(() => reopenedApp.execute(envelope));
    } finally {
      reopened.close();
    }
  } finally {
    fixture.cleanup();
  }
};

const createEnvelope = (overrides: Partial<HostCommandEnvelope> = {}): HostCommandEnvelope => ({
  contractVersion: "tempera.host-command.v1",
  requestId: "host-req-1" as HostRequestId,
  expectedVersion: 0,
  command: {
    type: "create-task",
    creationSpec: descriptor("task-creation", "task-creation:1", { intent: "demo" }),
    policySnapshot: descriptor("task-policy", "policy:1", { mode: "demo" }),
    authorityScope: scope,
  },
  ...overrides,
});

const seedAggregate = (
  store: AuthorityStore,
  requestId: string,
  expectedVersion: number,
  aggregate: TaskAggregate,
  facts: JsonObject[],
  targetTaskId: TaskId = taskId,
): void => {
  store.executeTaskCommand(
    {
      requestId,
      payloadFingerprint: `fp:${requestId}`,
      taskId: targetTaskId,
      expectedVersion,
      resultCodec: simpleResultCodec,
      onPreconditionFailure: () => {
        throw new Error("unexpected precondition failure");
      },
    },
    () => ({
      kind: "commit",
      nextAggregate: aggregate,
      facts,
      result: { ok: true },
    }),
  );
};

const createReviewEnvelope = (
  overrides: Partial<HostCommandEnvelope> = {},
): HostCommandEnvelope => ({
  contractVersion: "tempera.host-command.v1",
  requestId: "host-review-1" as HostRequestId,
  expectedVersion: 2,
  command: {
    type: "submit-external-review",
    taskId,
    stageId,
    candidateId,
    actorRef: "actor:host" as ActorRef,
    disposition: "pass",
    evidence: [artifact("evidence:1")],
  },
  ...overrides,
});

const createCancelEnvelope = (
  overrides: Partial<HostCommandEnvelope> = {},
): HostCommandEnvelope => ({
  contractVersion: "tempera.host-command.v1",
  requestId: "host-cancel-1" as HostRequestId,
  expectedVersion: 2,
  command: {
    type: "cancel-task",
    taskId,
    actorRef: "actor:host" as ActorRef,
    cancellation: descriptor("task-cancellation", "cancel:1", { reason: "manual" }),
  },
  ...overrides,
});

const createReconcileEnvelope = (
  overrides: Partial<HostCommandEnvelope> = {},
): HostCommandEnvelope => ({
  contractVersion: "tempera.host-command.v1",
  requestId: "host-reconcile-1" as HostRequestId,
  expectedVersion: 2,
  command: {
    type: "request-operation-reconciliation",
    taskId,
    operationId,
    actorRef: "actor:host" as ActorRef,
  },
  ...overrides,
});

const seedReviewableTask = (store: AuthorityStore, seedRequestId = "seed-review"): void => {
  const app = createHostApplication(store, defaultHostIds());
  app.execute(createEnvelope());
  const base = store.getTask(taskId)?.aggregate;
  if (!base) throw new Error("task missing");
  const seeded: TaskAggregate = {
    ...base,
    task: { ...base.task, version: 2 },
    stages: { [stageId]: evaluationStage() },
    candidates: { [candidateId]: candidateEntity() },
  };
  seedAggregate(store, seedRequestId, 1, seeded, [{ type: "stage-materialized", taskId }]);
};

const seedReconcilableTask = (store: AuthorityStore, seedRequestId = "seed-reconcile"): void => {
  const app = createHostApplication(store, defaultHostIds());
  app.execute(createEnvelope());
  const base = store.getTask(taskId)?.aggregate;
  if (!base) throw new Error("task missing");
  const seeded: TaskAggregate = {
    ...base,
    task: { ...base.task, version: 2 },
    operations: {
      [operationId]: { ...preparedOperation(), status: "indeterminate" },
    },
  };
  seedAggregate(store, seedRequestId, 1, seeded, [{ type: "operation-prepared", taskId }]);
};

describe("HostApplication", () => {
  it("creates a task and replays the exact durable result", () => {
    withStore((store) => {
      const app = createHostApplication(store, {
        taskId: () => taskId,
        reviewId: () => reviewId,
      });
      const envelope = createEnvelope();
      const response = app.execute(envelope);
      expect(response.delivery).toBe("first-observation");
      expect(response.result).toEqual({
        kind: "committed",
        requestId: "host-req-1",
        taskId,
        committedVersion: 1,
        outcome: "task-created",
      });

      const replay = app.execute(envelope);
      expect(replay.delivery).toBe("replay");
      expect(replay.result).toEqual(response.result);

      const found = app.getTask(taskId);
      expect(found.kind).toBe("found");
      if (found.kind === "found") {
        expect(found.observedVersion).toBe(1);
        expect(found.aggregate.task.id).toBe(taskId);
      }
    });
  });

  it("rejects reserved request ids and invalid create expected versions", () => {
    withStore((store) => {
      const app = createHostApplication(store, {
        taskId: () => taskId,
        reviewId: () => reviewId,
      });
      expect(() =>
        app.execute(
          createEnvelope({
            requestId: "tempera:internal" as HostRequestId,
          }),
        ),
      ).toThrowError(HostCommandProtocolError);
      expect(() =>
        app.execute(
          createEnvelope({
            expectedVersion: 1,
          }),
        ),
      ).toThrowError(HostCommandProtocolError);
    });
  });
  it("rejects unknown nested create-task fields before writing any receipt", () => {
    withStore((store) => {
      const app = createHostApplication(store, {
        taskId: () => taskId,
        reviewId: () => reviewId,
      });
      const badDescriptor = {
        ...descriptor("task-creation", "task-creation:1"),
        extra: true,
      };
      let error: unknown;
      try {
        app.execute(
          createEnvelope({
            command: {
              type: "create-task",
              creationSpec: badDescriptor as never,
              policySnapshot: descriptor("task-policy", "policy:1"),
              authorityScope: scope,
            },
          }),
        );
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(HostCommandProtocolError);
      expect((error as HostCommandProtocolError).code).toBe("MALFORMED_COMMAND");
      expect(store.getTask(taskId)).toBeUndefined();
      expect(store.listTasks()).toEqual([]);
    });
  });

  it("submits an external review against a seeded active evaluation stage", () => {
    withStore((store) => {
      const app = createHostApplication(store, {
        taskId: () => taskId,
        reviewId: () => reviewId,
      });
      app.execute(createEnvelope());

      const base = store.getTask(taskId)?.aggregate;
      if (!base) throw new Error("task missing");
      const seeded: TaskAggregate = {
        ...base,
        task: { ...base.task, version: 2 },
        stages: { [stageId]: evaluationStage() },
        candidates: { [candidateId]: candidateEntity() },
      };
      seedAggregate(store, "seed-review", 1, seeded, [{ type: "stage-materialized", taskId }]);

      const response = app.execute({
        contractVersion: "tempera.host-command.v1",
        requestId: "host-review-1" as HostRequestId,
        expectedVersion: 2,
        command: {
          type: "submit-external-review",
          taskId,
          stageId,
          candidateId,
          actorRef: "actor:host" as ActorRef,
          disposition: "pass",
          evidence: [artifact("evidence:1")],
        },
      });

      expect(response.delivery).toBe("first-observation");
      expect(response.result).toMatchObject({
        kind: "committed",
        taskId,
        committedVersion: 3,
        outcome: "external-review-recorded",
      });

      const found = store.getTask(taskId);
      expect(found?.observedVersion).toBe(3);
      expect(found?.aggregate.reviews[reviewId]).toBeDefined();
      expect(found?.aggregate.stages[stageId].status).toBe("completed");
    });
  });

  it("cancels a task and aborts prepared operations atomically", () => {
    withStore((store) => {
      const app = createHostApplication(store, {
        taskId: () => taskId,
        reviewId: () => reviewId,
      });
      app.execute(createEnvelope());

      const base = store.getTask(taskId)?.aggregate;
      if (!base) throw new Error("task missing");
      const seeded: TaskAggregate = {
        ...base,
        task: { ...base.task, version: 2 },
        stages: { [stageId]: evaluationStage() },
        candidates: { [candidateId]: candidateEntity() },
        operations: { [operationId]: preparedOperation() },
      };
      seedAggregate(store, "seed-cancel", 1, seeded, [{ type: "stage-materialized", taskId }]);

      const response = app.execute({
        contractVersion: "tempera.host-command.v1",
        requestId: "host-cancel-1" as HostRequestId,
        expectedVersion: 2,
        command: {
          type: "cancel-task",
          taskId,
          actorRef: "actor:host" as ActorRef,
          cancellation: descriptor("task-cancellation", "cancel:1", { reason: "manual" }),
        },
      });

      expect(response.delivery).toBe("first-observation");
      expect(response.result).toMatchObject({
        kind: "committed",
        taskId,
        committedVersion: 3,
        outcome: "task-cancelled",
      });

      const found = store.getTask(taskId);
      expect(found?.aggregate.task.status).toBe("cancelled");
      expect(found?.aggregate.stages[stageId].status).toBe("cancelled");
      expect(found?.aggregate.operations[operationId].status).toBe("aborted");
    });
  });

  it("accepts reconciliation requests without advancing the task", () => {
    withStore((store) => {
      let notified = 0;
      const app = createHostApplication(
        store,
        {
          taskId: () => taskId,
          reviewId: () => reviewId,
        },
        () => {
          notified += 1;
        },
      );
      app.execute(createEnvelope());

      const base = store.getTask(taskId)?.aggregate;
      if (!base) throw new Error("task missing");
      const seeded: TaskAggregate = {
        ...base,
        task: { ...base.task, version: 2 },
        operations: {
          [operationId]: { ...preparedOperation(), status: "indeterminate" },
        },
      };
      seedAggregate(store, "seed-reconcile", 1, seeded, [{ type: "operation-prepared", taskId }]);

      const response = app.execute({
        contractVersion: "tempera.host-command.v1",
        requestId: "host-reconcile-1" as HostRequestId,
        expectedVersion: 2,
        command: {
          type: "request-operation-reconciliation",
          taskId,
          operationId,
          actorRef: "actor:host" as ActorRef,
        },
      });

      expect(response.delivery).toBe("first-observation");
      expect(response.result).toMatchObject({
        kind: "accepted-no-write",
        taskId,
        observedVersion: 2,
        outcome: "reconciliation-required",
      });
      expect(notified).toBe(1);

      const replay = app.execute({
        contractVersion: "tempera.host-command.v1",
        requestId: "host-reconcile-1" as HostRequestId,
        expectedVersion: 2,
        command: {
          type: "request-operation-reconciliation",
          taskId,
          operationId,
          actorRef: "actor:host" as ActorRef,
        },
      });
      expect(replay.delivery).toBe("replay");
      expect(notified).toBe(2);
      expect(store.getTask(taskId)?.observedVersion).toBe(2);
    });
  });
  it("does not call the reconciliation notifier for durable rejections", () => {
    withStore((store) => {
      let notified = 0;
      const app = createHostApplication(
        store,
        {
          taskId: () => taskId,
          reviewId: () => reviewId,
        },
        () => {
          notified += 1;
        },
      );
      app.execute(createEnvelope());

      const base = store.getTask(taskId)?.aggregate;
      if (!base) throw new Error("task missing");
      const seeded: TaskAggregate = {
        ...base,
        task: { ...base.task, version: 2 },
        operations: {
          [operationId]: { ...preparedOperation(), status: "prepared" },
        },
      };
      seedAggregate(store, "seed-reconcile-reject", 1, seeded, [
        { type: "operation-prepared", taskId },
      ]);

      const response = app.execute({
        contractVersion: "tempera.host-command.v1",
        requestId: "host-reconcile-reject" as HostRequestId,
        expectedVersion: 2,
        command: {
          type: "request-operation-reconciliation",
          taskId,
          operationId,
          actorRef: "actor:host" as ActorRef,
        },
      });

      expect(response.result).toMatchObject({
        kind: "rejected",
        code: "OPERATION_NOT_INDETERMINATE",
      });
      expect(notified).toBe(0);
    });
  });

  it("replays an accepted reconciliation and notifies again after notifier failure", () => {
    withStore((store) => {
      let notified = 0;
      const app = createHostApplication(
        store,
        {
          taskId: () => taskId,
          reviewId: () => reviewId,
        },
        () => {
          notified += 1;
          if (notified === 1) {
            throw new Error("notifier failed");
          }
        },
      );
      app.execute(createEnvelope());

      const base = store.getTask(taskId)?.aggregate;
      if (!base) throw new Error("task missing");
      const seeded: TaskAggregate = {
        ...base,
        task: { ...base.task, version: 2 },
        operations: {
          [operationId]: { ...preparedOperation(), status: "indeterminate" },
        },
      };
      seedAggregate(store, "seed-reconcile-fail", 1, seeded, [
        { type: "operation-prepared", taskId },
      ]);

      const envelope: HostCommandEnvelope = {
        contractVersion: "tempera.host-command.v1",
        requestId: "host-reconcile-fail" as HostRequestId,
        expectedVersion: 2,
        command: {
          type: "request-operation-reconciliation",
          taskId,
          operationId,
          actorRef: "actor:host" as ActorRef,
        },
      };

      expect(() => app.execute(envelope)).toThrowError("notifier failed");
      expect(notified).toBe(1);
      expect(store.getTask(taskId)?.observedVersion).toBe(2);

      const replay = app.execute(envelope);
      expect(replay.delivery).toBe("replay");
      expect(replay.result).toMatchObject({
        kind: "accepted-no-write",
        outcome: "reconciliation-required",
      });
      expect(notified).toBe(2);
    });
  });

  it("persists JSON-safe invalid evidence as REVIEW_EVIDENCE_INVALID without mutation", () => {
    withStore((store) => {
      const app = createHostApplication(store, {
        taskId: () => taskId,
        reviewId: () => reviewId,
      });
      app.execute(createEnvelope());

      const base = store.getTask(taskId)?.aggregate;
      if (!base) throw new Error("task missing");
      const seeded: TaskAggregate = {
        ...base,
        task: { ...base.task, version: 2 },
        stages: { [stageId]: evaluationStage() },
        candidates: { [candidateId]: candidateEntity() },
      };
      seedAggregate(store, "seed-evidence", 1, seeded, [{ type: "stage-materialized", taskId }]);

      const envelope = {
        contractVersion: "tempera.host-command.v1",
        requestId: "host-bad-evidence" as HostRequestId,
        expectedVersion: 2,
        command: {
          type: "submit-external-review",
          taskId,
          stageId,
          candidateId,
          actorRef: "actor:host" as ActorRef,
          disposition: "pass",
          evidence: [],
        },
      } as unknown as HostCommandEnvelope;

      const response = app.execute(envelope);
      expect(response.delivery).toBe("first-observation");
      expect(response.result).toMatchObject({
        kind: "rejected",
        code: "REVIEW_EVIDENCE_INVALID",
      });

      const after = store.getTask(taskId);
      expect(after?.observedVersion).toBe(2);
      expect(after?.aggregate.reviews[reviewId]).toBeUndefined();
      expect(after?.aggregate.stages[stageId].status).toBe("active");
      expect(store.getAuthorityHistory(taskId)).toHaveLength(2);

      const replay = app.execute(envelope);
      expect(replay.delivery).toBe("replay");
      expect(replay.result).toEqual(response.result);

      const { evidence: _omitted, ...commandWithoutEvidence } =
        envelope.command as unknown as Record<string, unknown>;
      const missingEnvelope = {
        ...envelope,
        requestId: "host-missing-evidence" as HostRequestId,
        command: commandWithoutEvidence,
      } as unknown as HostCommandEnvelope;
      const missingResponse = app.execute(missingEnvelope);
      expect(missingResponse.result).toMatchObject({
        kind: "rejected",
        code: "REVIEW_EVIDENCE_INVALID",
      });

      const extraFieldEnvelope = {
        ...envelope,
        requestId: "host-extra-evidence" as HostRequestId,
        command: {
          ...envelope.command,
          evidence: [{ ...artifact("evidence:1"), extra: true }],
        },
      } as unknown as HostCommandEnvelope;
      const extraFieldResponse = app.execute(extraFieldEnvelope);
      expect(extraFieldResponse.result).toMatchObject({
        kind: "rejected",
        code: "REVIEW_EVIDENCE_INVALID",
      });

      const changed = {
        ...envelope,
        command: {
          ...envelope.command,
          evidence: [artifact("evidence:1")],
        },
      } as unknown as HostCommandEnvelope;
      expect(() => app.execute(changed)).toThrowError(HostCommandProtocolError);
    });
  });

  it("rejects non-JSON evidence as a protocol error without writing a receipt", () => {
    withStore((store) => {
      const app = createHostApplication(store, {
        taskId: () => taskId,
        reviewId: () => reviewId,
      });
      app.execute(createEnvelope());

      const badEnvelope = {
        contractVersion: "tempera.host-command.v1",
        requestId: "host-nonjson-evidence" as HostRequestId,
        expectedVersion: 1,
        command: {
          type: "submit-external-review",
          taskId,
          stageId,
          candidateId,
          actorRef: "actor:host" as ActorRef,
          disposition: "pass",
          evidence: [() => "not-json"],
        },
      } as unknown as HostCommandEnvelope;

      expect(() => app.execute(badEnvelope)).toThrowError(HostCommandProtocolError);
      expect(() =>
        app.execute({
          ...badEnvelope,
          requestId: "host-nonjson-evidence-2" as HostRequestId,
        }),
      ).toThrowError(HostCommandProtocolError);
    });
  });

  it("strictly decodes generated cursors and rejects non-canonical aliases", () => {
    withStore((store) => {
      const app = createHostApplication(store, {
        taskId: () => taskId,
        reviewId: () => reviewId,
      });
      app.execute(createEnvelope());

      const app2 = createHostApplication(store, {
        taskId: () => "T2" as TaskId,
        reviewId: () => "R2" as ReviewId,
      });
      app2.execute({
        ...createEnvelope(),
        requestId: "host-req-2" as HostRequestId,
      });

      const page = app.listTasks({ limit: 1 });
      expect(page.items).toHaveLength(1);
      expect(page.nextCursor).toBeDefined();

      const next = app.listTasks({ limit: 1, cursor: page.nextCursor });
      expect(next.items).toHaveLength(1);
      expect(next.items[0]?.taskId).not.toBe(page.items[0]?.taskId);

      const malformed = `${page.nextCursor}=`;
      expect(() => app.listTasks({ cursor: malformed })).toThrowError(HostQueryProtocolError);
      expect(() => app.listTasks({ cursor: ` ${page.nextCursor}` })).toThrowError(
        HostQueryProtocolError,
      );

      const nonFiniteHistoryJson =
        '{"committedVersion":1e400,"kind":"authority-history","taskId":"T1","v":"v1"}';
      const nonFiniteHistoryCursor = Buffer.from(`v1:${nonFiniteHistoryJson}`, "utf8").toString(
        "base64url",
      );
      let historyError: unknown;
      try {
        app.getAuthorityHistory(taskId, { cursor: nonFiniteHistoryCursor });
      } catch (error) {
        historyError = error;
      }
      expect(historyError).toBeInstanceOf(HostQueryProtocolError);
      expect((historyError as HostQueryProtocolError).code).toBe("MALFORMED_CURSOR");

      const nonFiniteTaskJson =
        '{"kind":"task-list","status":null,"taskId":"T1","v":"v1","x":1e400}';
      const nonFiniteTaskCursor = Buffer.from(`v1:${nonFiniteTaskJson}`, "utf8").toString(
        "base64url",
      );
      let taskError: unknown;
      try {
        app.listTasks({ cursor: nonFiniteTaskCursor });
      } catch (error) {
        taskError = error;
      }
      expect(taskError).toBeInstanceOf(HostQueryProtocolError);
      expect((taskError as HostQueryProtocolError).code).toBe("MALFORMED_CURSOR");
      let statusMismatchError: unknown;
      try {
        app.listTasks({ status: "completed", cursor: page.nextCursor });
      } catch (error) {
        statusMismatchError = error;
      }
      expect(statusMismatchError).toBeInstanceOf(HostQueryProtocolError);
      expect((statusMismatchError as HostQueryProtocolError).code).toBe("CURSOR_QUERY_MISMATCH");

      const base = store.getTask(taskId)?.aggregate;
      if (!base) throw new Error("task missing");
      seedAggregate(
        store,
        "seed-history-cursor",
        1,
        { ...base, task: { ...base.task, version: 2 } },
        [{ type: "advanced", taskId }],
      );
      const historyPage = app.getAuthorityHistory(taskId, { limit: 1 });
      if (historyPage.kind !== "found") {
        throw new Error("expected history page");
      }
      expect(historyPage.nextCursor).toBeDefined();
      let historyMismatchError: unknown;
      try {
        app.getAuthorityHistory("T2" as TaskId, { cursor: historyPage.nextCursor });
      } catch (error) {
        historyMismatchError = error;
      }
      expect(historyMismatchError).toBeInstanceOf(HostQueryProtocolError);
      expect((historyMismatchError as HostQueryProtocolError).code).toBe("CURSOR_QUERY_MISMATCH");
    });
  });
  describe("durable Host result corruption matrix", () => {
    const createResult = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
      kind: "committed",
      requestId: "host-req-1",
      taskId,
      committedVersion: 1,
      outcome: "task-created",
      ...overrides,
    });

    it("rejects malformed committed create-task results", () => {
      const envelope = createEnvelope();
      const cases: Record<string, unknown>[] = [
        {
          kind: "committed",
          requestId: "host-req-1",
          taskId,
          committedVersion: 1,
          outcome: "unknown",
        },
        {
          kind: "committed",
          requestId: "host-req-1",
          committedVersion: 1,
          outcome: "task-created",
        },
        {
          kind: "committed",
          requestId: "host-req-1",
          taskId,
          committedVersion: 0,
          outcome: "task-created",
        },
        {
          kind: "committed",
          requestId: "host-req-1",
          taskId,
          committedVersion: -1,
          outcome: "task-created",
        },
        {
          kind: "committed",
          requestId: "host-req-1",
          taskId,
          committedVersion: 1.5,
          outcome: "task-created",
        },
        createResult({ extra: true }),
      ];
      for (const result of cases) {
        assertHostCorruption(envelope, result);
      }
    });

    it("rejects malformed accepted-no-write and rejected results", () => {
      withTempAuthorityStore((store) => {
        seedReconcilableTask(store, "seed-reconcile-corrupt-1");
        const envelope = createReconcileEnvelope({
          requestId: "host-reconcile-corrupt-1" as HostRequestId,
        });
        const app = createHostApplication(store, defaultHostIds());
        const response = app.execute(envelope);
        expect(response.result).toMatchObject({ kind: "accepted-no-write", observedVersion: 2 });
      });

      const acceptedCases: Record<string, unknown>[] = [
        {
          kind: "accepted-no-write",
          requestId: "host-reconcile-corrupt-1",
          taskId,
          observedVersion: 2,
          outcome: "unknown",
        },
        {
          kind: "accepted-no-write",
          requestId: "host-reconcile-corrupt-1",
          taskId,
          outcome: "reconciliation-required",
        },
        {
          kind: "accepted-no-write",
          requestId: "host-reconcile-corrupt-1",
          taskId,
          observedVersion: 0,
          outcome: "reconciliation-required",
        },
        {
          kind: "accepted-no-write",
          requestId: "host-reconcile-corrupt-1",
          taskId,
          observedVersion: -1,
          outcome: "reconciliation-required",
        },
        {
          kind: "accepted-no-write",
          requestId: "host-reconcile-corrupt-1",
          taskId,
          observedVersion: 1.5,
          outcome: "reconciliation-required",
        },
        {
          kind: "accepted-no-write",
          requestId: "host-reconcile-corrupt-1",
          taskId,
          observedVersion: 2,
          outcome: "reconciliation-required",
          extra: true,
        },
      ];
      for (const result of acceptedCases) {
        const fixture = tempAuthorityStore("tempera-host-accepted-corrupt-");
        const app = createHostApplication(fixture.store, defaultHostIds());
        try {
          seedReconcilableTask(fixture.store, "seed-accepted-corrupt");
          const envelope = createReconcileEnvelope({
            requestId: "host-reconcile-corrupt" as HostRequestId,
          });
          app.execute(envelope);
          fixture.store.close();
          mutateReceipt(fixture.path, envelope.requestId, result);
          const reopened = openSqliteAuthorityStore(fixture.path);
          try {
            const reopenedApp = createHostApplication(reopened, defaultHostIds());
            expectAuthorityCorruption(() => reopenedApp.execute(envelope));
          } finally {
            reopened.close();
          }
        } finally {
          fixture.cleanup();
        }
      }
    });

    it("rejects malformed TASK_ID_CONFLICT, TASK_VERSION_CONFLICT and other rejected receipts", () => {
      // TASK_ID_CONFLICT is produced by create-task when a candidate id already exists.
      const idConflictCases: Record<string, unknown>[] = [
        {
          kind: "rejected",
          requestId: "host-id-conflict",
          code: "TASK_ID_CONFLICT",
          observedVersion: 1,
          details: { expectedVersion: 0, observedVersion: 1 },
        },
        {
          kind: "rejected",
          requestId: "host-id-conflict",
          code: "TASK_ID_CONFLICT",
          taskId,
          details: { expectedVersion: 0, observedVersion: 1 },
        },
        {
          kind: "rejected",
          requestId: "host-id-conflict",
          code: "TASK_ID_CONFLICT",
          taskId,
          observedVersion: 1,
        },
        {
          kind: "rejected",
          requestId: "host-id-conflict",
          code: "TASK_ID_CONFLICT",
          taskId,
          observedVersion: 0,
          details: { expectedVersion: 0, observedVersion: 0 },
        },
        {
          kind: "rejected",
          requestId: "host-id-conflict",
          code: "TASK_ID_CONFLICT",
          taskId,
          observedVersion: -1,
          details: { expectedVersion: 0, observedVersion: -1 },
        },
        {
          kind: "rejected",
          requestId: "host-id-conflict",
          code: "TASK_ID_CONFLICT",
          taskId,
          observedVersion: 1.5,
          details: { expectedVersion: 0, observedVersion: 1.5 },
        },
        {
          kind: "rejected",
          requestId: "host-id-conflict",
          code: "TASK_ID_CONFLICT",
          taskId,
          observedVersion: 1,
          details: { expectedVersion: 1, observedVersion: 1 },
        },
        {
          kind: "rejected",
          requestId: "host-id-conflict",
          code: "TASK_ID_CONFLICT",
          taskId,
          observedVersion: 1,
          details: { expectedVersion: 0, observedVersion: 2 },
        },
        {
          kind: "rejected",
          requestId: "host-id-conflict",
          code: "TASK_ID_CONFLICT",
          taskId,
          observedVersion: 1,
          details: { expectedVersion: 0, observedVersion: 1, extra: true },
        },
      ];
      for (const result of idConflictCases) {
        assertHostCorruption(
          createEnvelope({ requestId: "host-id-conflict" as HostRequestId }),
          result,
          { taskId: () => taskId, reviewId: () => reviewId },
        );
      }

      const versionConflictCases: Record<string, unknown>[] = [
        {
          kind: "rejected",
          requestId: "host-version-conflict",
          code: "TASK_VERSION_CONFLICT",
          observedVersion: 2,
          details: { expectedVersion: 1, observedVersion: 2 },
        },
        {
          kind: "rejected",
          requestId: "host-version-conflict",
          code: "TASK_VERSION_CONFLICT",
          taskId,
          observedVersion: 2,
          details: { observedVersion: 2 },
        },
        {
          kind: "rejected",
          requestId: "host-version-conflict",
          code: "TASK_VERSION_CONFLICT",
          taskId,
          details: { expectedVersion: 1, observedVersion: 2 },
        },
        {
          kind: "rejected",
          requestId: "host-version-conflict",
          code: "TASK_VERSION_CONFLICT",
          taskId,
          observedVersion: 0,
          details: { expectedVersion: 1, observedVersion: 0 },
        },
        {
          kind: "rejected",
          requestId: "host-version-conflict",
          code: "TASK_VERSION_CONFLICT",
          taskId,
          observedVersion: -1,
          details: { expectedVersion: 1, observedVersion: -1 },
        },
        {
          kind: "rejected",
          requestId: "host-version-conflict",
          code: "TASK_VERSION_CONFLICT",
          taskId,
          observedVersion: 1.5,
          details: { expectedVersion: 1, observedVersion: 1.5 },
        },
        {
          kind: "rejected",
          requestId: "host-version-conflict",
          code: "TASK_VERSION_CONFLICT",
          taskId,
          observedVersion: 2,
          details: { expectedVersion: 0, observedVersion: 2 },
        },
        {
          kind: "rejected",
          requestId: "host-version-conflict",
          code: "TASK_VERSION_CONFLICT",
          taskId,
          observedVersion: 2,
          details: { expectedVersion: -1, observedVersion: 2 },
        },
        {
          kind: "rejected",
          requestId: "host-version-conflict",
          code: "TASK_VERSION_CONFLICT",
          taskId,
          observedVersion: 2,
          details: { expectedVersion: 1.5, observedVersion: 2 },
        },
        {
          kind: "rejected",
          requestId: "host-version-conflict",
          code: "TASK_VERSION_CONFLICT",
          taskId,
          observedVersion: 2,
          details: { expectedVersion: 1, observedVersion: 3 },
        },
        {
          kind: "rejected",
          requestId: "host-version-conflict",
          code: "TASK_VERSION_CONFLICT",
          taskId,
          observedVersion: 2,
          details: { expectedVersion: 1, observedVersion: 2, extra: true },
        },
        {
          kind: "rejected",
          requestId: "host-version-conflict",
          code: "TASK_VERSION_CONFLICT",
          taskId,
          observedVersion: 2,
          details: { expectedVersion: 1, observedVersion: 2 },
          forbidden: true,
        },
      ];
      for (const result of versionConflictCases) {
        const fixture = tempAuthorityStore("tempera-host-version-corrupt-");
        const app = createHostApplication(fixture.store, defaultHostIds());
        try {
          seedReviewableTask(fixture.store, "seed-version-corrupt");
          const envelope = createReviewEnvelope({
            requestId: "host-version-conflict" as HostRequestId,
          });
          // Use a version conflict envelope: expectedVersion 99 against observed 2.
          const conflictEnvelope = { ...envelope, expectedVersion: 99 } as HostCommandEnvelope;
          const first = app.execute(conflictEnvelope);
          expect(first.result).toMatchObject({ kind: "rejected", code: "TASK_VERSION_CONFLICT" });
          fixture.store.close();
          mutateReceipt(fixture.path, conflictEnvelope.requestId, result);
          const reopened = openSqliteAuthorityStore(fixture.path);
          try {
            const reopenedApp = createHostApplication(reopened, defaultHostIds());
            expectAuthorityCorruption(() => reopenedApp.execute(conflictEnvelope));
          } finally {
            reopened.close();
          }
        } finally {
          fixture.cleanup();
        }
      }

      const otherRejectedCases: Record<string, unknown>[] = [
        {
          kind: "rejected",
          requestId: "host-other",
          code: "TASK_NOT_FOUND",
          taskId,
          observedVersion: 1,
        },
        { kind: "rejected", requestId: "host-other", code: "TASK_NOT_ACTIVE", taskId, details: {} },
        {
          kind: "rejected",
          requestId: "host-other",
          code: "HOST_REVIEW_NOT_EXPECTED",
          taskId,
          observedVersion: 1,
        },
        {
          kind: "rejected",
          requestId: "host-other",
          code: "REVIEW_TARGET_MISMATCH",
          taskId,
          details: {},
        },
        {
          kind: "rejected",
          requestId: "host-other",
          code: "REVIEW_EVIDENCE_INVALID",
          taskId,
          observedVersion: 1,
        },
        {
          kind: "rejected",
          requestId: "host-other",
          code: "OPERATION_NOT_INDETERMINATE",
          taskId,
          details: {},
        },
      ];
      for (const result of otherRejectedCases) {
        assertHostCorruption(createEnvelope({ requestId: "host-other" as HostRequestId }), result);
      }
    });

    it("rejects malformed COMMAND_REJECTED results", () => {
      const cases: Record<string, unknown>[] = [
        {
          kind: "rejected",
          requestId: "host-command-rejected",
          code: "COMMAND_REJECTED",
          taskId,
          observedVersion: 1,
        },
        {
          kind: "rejected",
          requestId: "host-command-rejected",
          code: "COMMAND_REJECTED",
          taskId,
          details: { domainCode: "UNKNOWN_DOMAIN" },
        },
        {
          kind: "rejected",
          requestId: "host-command-rejected",
          code: "COMMAND_REJECTED",
          taskId,
          details: { domainCode: 42 },
        },
        {
          kind: "rejected",
          requestId: "host-command-rejected",
          code: "COMMAND_REJECTED",
          taskId,
          details: { domainCode: "STAGE_NOT_FOUND", extra: true },
        },
      ];
      for (const result of cases) {
        assertHostCorruption(
          createEnvelope({ requestId: "host-command-rejected" as HostRequestId }),
          result,
        );
      }
    });

    it("rejects unknown result kind, unknown rejection code, and stored request/task id mismatches", () => {
      assertHostCorruption(createEnvelope(), { kind: "unknown" });
      assertHostCorruption(createEnvelope(), {
        kind: "rejected",
        requestId: "host-req-1",
        code: "UNKNOWN_REJECTION",
        taskId,
      });
      assertHostCorruption(createEnvelope(), {
        kind: "committed",
        requestId: "different-request",
        taskId,
        committedVersion: 1,
        outcome: "task-created",
      });

      const reviewEnvelope = createReviewEnvelope();
      assertHostCorruption(
        reviewEnvelope,
        {
          kind: "committed",
          requestId: reviewEnvelope.requestId,
          taskId: "T2" as TaskId,
          committedVersion: 3,
          outcome: "external-review-recorded",
        },
        defaultHostIds(),
      );

      const cancelEnvelope = createCancelEnvelope();
      assertHostCorruption(
        cancelEnvelope,
        {
          kind: "committed",
          requestId: cancelEnvelope.requestId,
          taskId: "T2" as TaskId,
          committedVersion: 3,
          outcome: "task-cancelled",
        },
        defaultHostIds(),
      );

      const reconcileEnvelope = createReconcileEnvelope();
      assertHostCorruption(
        reconcileEnvelope,
        {
          kind: "accepted-no-write",
          requestId: reconcileEnvelope.requestId,
          taskId: "T2" as TaskId,
          observedVersion: 2,
          outcome: "reconciliation-required",
        },
        defaultHostIds(),
      );
    });

    it("returns the first persisted task id when create-task replay generates a different candidate", () => {
      const fixture = tempAuthorityStore("tempera-host-create-replay-");
      const ids = defaultHostIds();
      const firstId = taskId;
      const secondId = "T2" as TaskId;
      let call = 0;
      const alternatingIds = {
        taskId: () => (call++ === 0 ? firstId : secondId),
        reviewId: ids.reviewId,
      };
      const app = createHostApplication(fixture.store, alternatingIds);
      try {
        const envelope = createEnvelope();
        const first = app.execute(envelope);
        expect(first.delivery).toBe("first-observation");
        expect(first.result).toMatchObject({ taskId: firstId });

        const replay = app.execute(envelope);
        expect(replay.delivery).toBe("replay");
        expect(replay.result).toMatchObject({ taskId: firstId });
        expect(fixture.store.getTask(firstId)).toBeDefined();
        expect(fixture.store.getTask(secondId)).toBeUndefined();
      } finally {
        fixture.cleanup();
      }
    });
  });

  describe("Host cursor verification matrix", () => {
    it("round-trips listTasks across pages and after reopen", () => {
      withTempAuthorityStore((store, path) => {
        const app = createHostApplication(store, defaultHostIds());
        app.execute(createEnvelope());
        const app2 = createHostApplication(store, {
          taskId: () => "T2" as TaskId,
          reviewId: () => "R2" as ReviewId,
        });
        app2.execute({
          ...createEnvelope(),
          requestId: "host-req-2" as HostRequestId,
        });

        const first = app.listTasks({ limit: 1 });
        expect(first.items).toHaveLength(1);
        expect(first.nextCursor).toBeDefined();
        const second = app.listTasks({ limit: 1, cursor: first.nextCursor });
        expect(second.items).toHaveLength(1);
        expect(second.nextCursor).toBeUndefined();
        expect([...first.items, ...second.items].map((item) => item.taskId).sort()).toEqual([
          "T1",
          "T2",
        ]);

        store.close();
        const reopened = openSqliteAuthorityStore(path);
        try {
          const reopenedApp = createHostApplication(reopened, defaultHostIds());
          const page = reopenedApp.listTasks({ limit: 1 });
          const next = reopenedApp.listTasks({ limit: 1, cursor: page.nextCursor });
          expect([...page.items, ...next.items].map((item) => item.taskId).sort()).toEqual([
            "T1",
            "T2",
          ]);
        } finally {
          reopened.close();
        }
      });
    });

    it("rejects malformed listTasks cursors", () => {
      withTempAuthorityStore((store) => {
        const app = createHostApplication(store, defaultHostIds());
        app.execute(createEnvelope());
        const app2 = createHostApplication(store, {
          taskId: () => "T2" as TaskId,
          reviewId: () => "R2" as ReviewId,
        });
        app2.execute({
          ...createEnvelope(),
          requestId: "host-req-2" as HostRequestId,
        });
        const valid = app.listTasks({ limit: 1 }).nextCursor;
        if (!valid) throw new Error("expected next cursor");
        const cases: { name: string; cursor: string }[] = [
          { name: "padding", cursor: `${valid}=` },
          { name: "leading whitespace", cursor: ` ${valid}` },
          { name: "trailing whitespace", cursor: `${valid} ` },
          { name: "invalid alphabet", cursor: valid.replace(/[A-Za-z0-9_-]/, "+") },
          { name: "invalid utf8", cursor: Buffer.from([0xff, 0xfe]).toString("base64url") },
          { name: "invalid json", cursor: cursorFromJson("v1:not-json") },
          { name: "missing prefix", cursor: cursorFromJson("not-json") },
          { name: "wrong version", cursor: cursorFromJson("v9:{}") },
          {
            name: "non-canonical",
            cursor: cursorFromJson('v1:{"taskId":"T1","kind":"task-list","status":null,"v":"v1"}'),
          },
          {
            name: "unknown field",
            cursor: cursorFromJson(
              'v1:{"extra":true,"kind":"task-list","status":null,"taskId":"T1","v":"v1"}',
            ),
          },
          {
            name: "wrong kind",
            cursor: cursorFromJson(
              'v1:{"kind":"authority-history","status":null,"taskId":"T1","v":"v1"}',
            ),
          },
          {
            name: "invalid status",
            cursor: cursorFromJson(
              'v1:{"kind":"task-list","status":"bogus","taskId":"T1","v":"v1"}',
            ),
          },
          {
            name: "empty taskId",
            cursor: cursorFromJson('v1:{"kind":"task-list","status":null,"taskId":"","v":"v1"}'),
          },
          {
            name: "wrong taskId type",
            cursor: cursorFromJson('v1:{"kind":"task-list","status":null,"taskId":1,"v":"v1"}'),
          },
          {
            name: "1e400",
            cursor: cursorFromJson(
              'v1:{"kind":"task-list","status":null,"taskId":"T1","v":"v1","x":1e400}',
            ),
          },
        ];
        for (const c of cases) {
          assertHostQueryError(() => app.listTasks({ cursor: c.cursor }), "MALFORMED_CURSOR");
        }
      });
    });

    it("round-trips getAuthorityHistory and enforces binding after reopen", () => {
      withTempAuthorityStore((store, path) => {
        const app = createHostApplication(store, defaultHostIds());
        app.execute(createEnvelope());
        const base = store.getTask(taskId)?.aggregate;
        if (!base) throw new Error("task missing");
        seedAggregate(
          store,
          "seed-history-cursor",
          1,
          { ...base, task: { ...base.task, version: 2 } },
          [{ type: "advanced", taskId }],
        );

        const page = app.getAuthorityHistory(taskId, { limit: 1 });
        if (page.kind !== "found") throw new Error("expected history");
        expect(page.items).toHaveLength(1);
        expect(page.nextCursor).toBeDefined();
        const next = app.getAuthorityHistory(taskId, { limit: 1, cursor: page.nextCursor });
        if (next.kind !== "found") throw new Error("expected history");
        expect(next.items).toHaveLength(1);
        expect(next.nextCursor).toBeUndefined();
        expect(page.items[0]?.committedVersion).toBe(1);
        expect(next.items[0]?.committedVersion).toBe(2);

        store.close();
        const reopened = openSqliteAuthorityStore(path);
        try {
          const reopenedApp = createHostApplication(reopened, defaultHostIds());
          const first = reopenedApp.getAuthorityHistory(taskId, { limit: 1 });
          if (first.kind !== "found") throw new Error("expected history");
          const second = reopenedApp.getAuthorityHistory(taskId, {
            limit: 1,
            cursor: first.nextCursor,
          });
          if (second.kind !== "found") throw new Error("expected history");
          expect([...first.items, ...second.items].map((item) => item.committedVersion)).toEqual([
            1, 2,
          ]);
        } finally {
          reopened.close();
        }
      });
    });

    it("rejects malformed getAuthorityHistory cursors", () => {
      withTempAuthorityStore((store) => {
        const app = createHostApplication(store, defaultHostIds());
        app.execute(createEnvelope());
        const base = store.getTask(taskId)?.aggregate;
        if (!base) throw new Error("task missing");
        seedAggregate(
          store,
          "seed-history-cursor-malformed",
          1,
          { ...base, task: { ...base.task, version: 2 } },
          [{ type: "advanced", taskId }],
        );
        const valid = app.getAuthorityHistory(taskId, { limit: 1 });
        if (valid.kind !== "found" || !valid.nextCursor) throw new Error("expected next cursor");
        const cases: { name: string; cursor: string }[] = [
          { name: "padding", cursor: `${valid.nextCursor}=` },
          { name: "leading whitespace", cursor: ` ${valid.nextCursor}` },
          { name: "trailing whitespace", cursor: `${valid.nextCursor} ` },
          { name: "invalid alphabet", cursor: valid.nextCursor.replace(/[A-Za-z0-9_-]/, "+") },
          { name: "invalid utf8", cursor: Buffer.from([0xff, 0xfe]).toString("base64url") },
          { name: "invalid json", cursor: cursorFromJson("v1:not-json") },
          { name: "missing prefix", cursor: cursorFromJson("not-json") },
          { name: "wrong version", cursor: cursorFromJson("v9:{}") },
          {
            name: "non-canonical",
            cursor: cursorFromJson(
              'v1:{"v":"v1","kind":"authority-history","taskId":"T1","committedVersion":1}',
            ),
          },
          {
            name: "unknown field",
            cursor: cursorFromJson(
              'v1:{"committedVersion":1,"extra":true,"kind":"authority-history","taskId":"T1","v":"v1"}',
            ),
          },
          {
            name: "wrong kind",
            cursor: cursorFromJson(
              'v1:{"committedVersion":1,"kind":"task-list","taskId":"T1","v":"v1"}',
            ),
          },
          {
            name: "empty taskId",
            cursor: cursorFromJson(
              'v1:{"committedVersion":1,"kind":"authority-history","taskId":"","v":"v1"}',
            ),
          },
          {
            name: "wrong taskId type",
            cursor: cursorFromJson(
              'v1:{"committedVersion":1,"kind":"authority-history","taskId":1,"v":"v1"}',
            ),
          },
          {
            name: "committedVersion zero",
            cursor: cursorFromJson(
              'v1:{"committedVersion":0,"kind":"authority-history","taskId":"T1","v":"v1"}',
            ),
          },
          {
            name: "committedVersion negative",
            cursor: cursorFromJson(
              'v1:{"committedVersion":-1,"kind":"authority-history","taskId":"T1","v":"v1"}',
            ),
          },
          {
            name: "committedVersion non-integer",
            cursor: cursorFromJson(
              'v1:{"committedVersion":1.5,"kind":"authority-history","taskId":"T1","v":"v1"}',
            ),
          },
          {
            name: "committedVersion wrong type",
            cursor: cursorFromJson(
              'v1:{"committedVersion":"1","kind":"authority-history","taskId":"T1","v":"v1"}',
            ),
          },
          {
            name: "1e400",
            cursor: cursorFromJson(
              'v1:{"committedVersion":1e400,"kind":"authority-history","taskId":"T1","v":"v1"}',
            ),
          },
        ];
        for (const c of cases) {
          assertHostQueryError(
            () => app.getAuthorityHistory(taskId, { cursor: c.cursor }),
            "MALFORMED_CURSOR",
          );
        }
      });
    });

    it("enforces cursor/query binding for listTasks and history", () => {
      withTempAuthorityStore((store) => {
        const app = createHostApplication(store, defaultHostIds());
        app.execute(createEnvelope());
        const app2 = createHostApplication(store, {
          taskId: () => "T2" as TaskId,
          reviewId: () => "R2" as ReviewId,
        });
        app2.execute({
          ...createEnvelope(),
          requestId: "host-req-2" as HostRequestId,
        });
        const page = app.listTasks({ limit: 1 });
        if (!page.nextCursor) throw new Error("expected cursor");
        assertHostQueryError(
          () => app.listTasks({ status: "completed", cursor: page.nextCursor }),
          "CURSOR_QUERY_MISMATCH",
        );

        const activePage = app.listTasks({ status: "active", limit: 1 });
        if (!activePage.nextCursor) throw new Error("expected active cursor");
        const activeNext = app.listTasks({ status: "active", cursor: activePage.nextCursor });
        expect(activeNext.items).toHaveLength(1);

        const base = store.getTask(taskId)?.aggregate;
        if (!base) throw new Error("task missing");
        seedAggregate(
          store,
          "seed-history-binding",
          1,
          { ...base, task: { ...base.task, version: 2 } },
          [{ type: "advanced", taskId }],
        );
        const history = app.getAuthorityHistory(taskId, { limit: 1 });
        if (history.kind !== "found" || !history.nextCursor) throw new Error("expected cursor");
        assertHostQueryError(
          () => app.getAuthorityHistory("T2" as TaskId, { cursor: history.nextCursor }),
          "CURSOR_QUERY_MISMATCH",
        );
      });
    });
  });

  describe("Host command regression matrix", () => {
    it("provides first observation, exact replay, and fingerprint mismatch for all four commands", () => {
      withTempAuthorityStore((store) => {
        const app = createHostApplication(store, defaultHostIds());

        const create = createEnvelope();
        const createFirst = app.execute(create);
        expect(createFirst.delivery).toBe("first-observation");
        const createReplay = app.execute(create);
        expect(createReplay.delivery).toBe("replay");
        expect(createReplay.result).toEqual(createFirst.result);
        const createBefore = snapshotCommandState(store, taskId);
        const createChanged = {
          ...create,
          command: {
            ...create.command,
            policySnapshot: descriptor("task-policy", "policy:changed"),
          },
        } as HostCommandEnvelope;
        let createError: unknown;
        try {
          app.execute(createChanged);
        } catch (caught) {
          createError = caught;
        }
        expect(createError).toBeInstanceOf(HostCommandProtocolError);
        expect((createError as HostCommandProtocolError).code).toBe("REQUEST_ID_REUSE_MISMATCH");
        expect(snapshotCommandState(store, taskId)).toEqual(createBefore);
        const createFinalReplay = app.execute(create);
        expect(createFinalReplay.delivery).toBe("replay");
        expect(createFinalReplay.result).toEqual(createFirst.result);
        expect(snapshotCommandState(store, taskId)).toEqual(createBefore);

        seedReviewableTask(store, "seed-cmd-review");
        const review = createReviewEnvelope();
        const reviewFirst = app.execute(review);
        expect(reviewFirst.delivery).toBe("first-observation");
        expect(reviewFirst.result).toMatchObject({
          kind: "committed",
          outcome: "external-review-recorded",
        });
        const reviewReplay = app.execute(review);
        expect(reviewReplay.delivery).toBe("replay");
        expect(reviewReplay.result).toEqual(reviewFirst.result);
        const reviewBefore = snapshotCommandState(store, taskId);
        const reviewChanged = {
          ...review,
          command: { ...review.command, disposition: "reject" },
        } as HostCommandEnvelope;
        let reviewError: unknown;
        try {
          app.execute(reviewChanged);
        } catch (caught) {
          reviewError = caught;
        }
        expect(reviewError).toBeInstanceOf(HostCommandProtocolError);
        expect((reviewError as HostCommandProtocolError).code).toBe("REQUEST_ID_REUSE_MISMATCH");
        expect(snapshotCommandState(store, taskId)).toEqual(reviewBefore);
        const reviewFinalReplay = app.execute(review);
        expect(reviewFinalReplay.delivery).toBe("replay");
        expect(reviewFinalReplay.result).toEqual(reviewFirst.result);
        expect(snapshotCommandState(store, taskId)).toEqual(reviewBefore);

        // Cancel command on a fresh task (the review advanced T1 to 3, use a separate task).
        const cancelApp = createHostApplication(store, {
          taskId: () => "T2" as TaskId,
          reviewId: () => "R2" as ReviewId,
        });
        cancelApp.execute({ ...createEnvelope(), requestId: "host-create-t2" as HostRequestId });
        const base2 = store.getTask("T2" as TaskId)?.aggregate;
        if (!base2) throw new Error("task missing");
        const seededCancel: TaskAggregate = {
          ...base2,
          task: { ...base2.task, version: 2 },
          stages: { [stageId]: { ...evaluationStage(), taskId: "T2" as TaskId } },
          candidates: { [candidateId]: { ...candidateEntity(), taskId: "T2" as TaskId } },
          operations: { [operationId]: { ...preparedOperation(), taskId: "T2" as TaskId } },
        };
        seedAggregate(
          store,
          "seed-cancel-t2",
          1,
          seededCancel,
          [{ type: "advanced", taskId: "T2" as TaskId }],
          "T2" as TaskId,
        );
        const cancel = {
          ...createCancelEnvelope(),
          requestId: "host-cancel-t2" as HostRequestId,
          command: {
            ...createCancelEnvelope().command,
            taskId: "T2" as TaskId,
          },
        } as HostCommandEnvelope;
        const cancelFirst = cancelApp.execute(cancel);
        expect(cancelFirst.delivery).toBe("first-observation");
        const cancelReplay = cancelApp.execute(cancel);
        expect(cancelReplay.delivery).toBe("replay");
        expect(cancelReplay.result).toEqual(cancelFirst.result);
        const cancelBefore = snapshotCommandState(store, "T2" as TaskId);
        const cancelChanged = {
          ...cancel,
          command: {
            ...cancel.command,
            cancellation: descriptor("task-cancellation", "cancel:changed"),
          },
        } as HostCommandEnvelope;
        let cancelError: unknown;
        try {
          cancelApp.execute(cancelChanged);
        } catch (caught) {
          cancelError = caught;
        }
        expect(cancelError).toBeInstanceOf(HostCommandProtocolError);
        expect((cancelError as HostCommandProtocolError).code).toBe("REQUEST_ID_REUSE_MISMATCH");
        expect(snapshotCommandState(store, "T2" as TaskId)).toEqual(cancelBefore);
        const cancelFinalReplay = cancelApp.execute(cancel);
        expect(cancelFinalReplay.delivery).toBe("replay");
        expect(cancelFinalReplay.result).toEqual(cancelFirst.result);
        expect(snapshotCommandState(store, "T2" as TaskId)).toEqual(cancelBefore);

        // Reconciliation on T2 after cancellation? Use a fresh T3 to keep deterministic.
        const recApp = createHostApplication(store, {
          taskId: () => "T3" as TaskId,
          reviewId: () => "R3" as ReviewId,
        });
        recApp.execute({ ...createEnvelope(), requestId: "host-create-t3" as HostRequestId });
        const base3 = store.getTask("T3" as TaskId)?.aggregate;
        if (!base3) throw new Error("task missing");
        const seededRec: TaskAggregate = {
          ...base3,
          task: { ...base3.task, version: 2 },
          operations: {
            [operationId]: {
              ...preparedOperation(),
              taskId: "T3" as TaskId,
              status: "indeterminate",
            },
          },
        };
        seedAggregate(
          store,
          "seed-rec-t3",
          1,
          seededRec,
          [{ type: "advanced", taskId: "T3" as TaskId }],
          "T3" as TaskId,
        );
        const rec = {
          ...createReconcileEnvelope(),
          requestId: "host-rec-t3" as HostRequestId,
          command: { ...createReconcileEnvelope().command, taskId: "T3" as TaskId },
        } as HostCommandEnvelope;
        const recFirst = recApp.execute(rec);
        expect(recFirst.delivery).toBe("first-observation");
        const recReplay = recApp.execute(rec);
        expect(recReplay.delivery).toBe("replay");
        expect(recReplay.result).toEqual(recFirst.result);
        const recBefore = snapshotCommandState(store, "T3" as TaskId);
        const recChanged = {
          ...rec,
          command: { ...rec.command, actorRef: "actor:changed" as ActorRef },
        } as HostCommandEnvelope;
        let recError: unknown;
        try {
          recApp.execute(recChanged);
        } catch (caught) {
          recError = caught;
        }
        expect(recError).toBeInstanceOf(HostCommandProtocolError);
        expect((recError as HostCommandProtocolError).code).toBe("REQUEST_ID_REUSE_MISMATCH");
        expect(snapshotCommandState(store, "T3" as TaskId)).toEqual(recBefore);
        const recFinalReplay = recApp.execute(rec);
        expect(recFinalReplay.delivery).toBe("replay");
        expect(recFinalReplay.result).toEqual(recFirst.result);
        expect(snapshotCommandState(store, "T3" as TaskId)).toEqual(recBefore);
      });
    });

    it("replays durable not-found and version-conflict rejections for non-create commands", () => {
      withTempAuthorityStore((store) => {
        const app = createHostApplication(store, defaultHostIds());

        const reviewNotFound = {
          ...createReviewEnvelope(),
          requestId: "host-review-notfound" as HostRequestId,
        };
        const notFound = app.execute(reviewNotFound);
        expect(notFound.result).toMatchObject({ kind: "rejected", code: "TASK_NOT_FOUND" });
        seedReviewableTask(store, "seed-after-notfound");
        const replayNotFound = app.execute(reviewNotFound);
        expect(replayNotFound.delivery).toBe("replay");
        expect(replayNotFound.result).toEqual(notFound.result);

        const cancelNotFound = {
          ...createCancelEnvelope(),
          requestId: "host-cancel-notfound" as HostRequestId,
          command: { ...createCancelEnvelope().command, taskId: "T2" as TaskId },
        } as HostCommandEnvelope;
        const cancelNotFoundFirst = app.execute(cancelNotFound);
        expect(cancelNotFoundFirst.result).toMatchObject({
          kind: "rejected",
          code: "TASK_NOT_FOUND",
        });
        const cancelApp = createHostApplication(store, {
          taskId: () => "T2" as TaskId,
          reviewId: () => "R2" as ReviewId,
        });
        cancelApp.execute({ ...createEnvelope(), requestId: "host-create-t2" as HostRequestId });
        const base2 = store.getTask("T2" as TaskId)?.aggregate;
        if (!base2) throw new Error("task missing");
        const seededCancel: TaskAggregate = {
          ...base2,
          task: { ...base2.task, version: 2 },
          stages: { [stageId]: { ...evaluationStage(), taskId: "T2" as TaskId } },
          candidates: { [candidateId]: { ...candidateEntity(), taskId: "T2" as TaskId } },
          operations: { [operationId]: { ...preparedOperation(), taskId: "T2" as TaskId } },
        };
        seedAggregate(
          store,
          "seed-cancel-after-notfound",
          1,
          seededCancel,
          [{ type: "advanced", taskId: "T2" as TaskId }],
          "T2" as TaskId,
        );
        expect(app.execute(cancelNotFound).result).toEqual(cancelNotFoundFirst.result);

        const recNotFound = {
          ...createReconcileEnvelope(),
          requestId: "host-rec-notfound" as HostRequestId,
          command: { ...createReconcileEnvelope().command, taskId: "T3" as TaskId },
        } as HostCommandEnvelope;
        const recNotFoundFirst = app.execute(recNotFound);
        expect(recNotFoundFirst.result).toMatchObject({ kind: "rejected", code: "TASK_NOT_FOUND" });
        const recApp = createHostApplication(store, {
          taskId: () => "T3" as TaskId,
          reviewId: () => "R3" as ReviewId,
        });
        recApp.execute({ ...createEnvelope(), requestId: "host-create-t3" as HostRequestId });
        const base3 = store.getTask("T3" as TaskId)?.aggregate;
        if (!base3) throw new Error("task missing");
        const seededRec: TaskAggregate = {
          ...base3,
          task: { ...base3.task, version: 2 },
          operations: {
            [operationId]: {
              ...preparedOperation(),
              taskId: "T3" as TaskId,
              status: "indeterminate",
            },
          },
        };
        seedAggregate(
          store,
          "seed-rec-after-notfound",
          1,
          seededRec,
          [{ type: "advanced", taskId: "T3" as TaskId }],
          "T3" as TaskId,
        );
        expect(app.execute(recNotFound).result).toEqual(recNotFoundFirst.result);

        const reviewConflict = {
          ...createReviewEnvelope(),
          requestId: "host-review-conflict" as HostRequestId,
          expectedVersion: 99,
        };
        const reviewConflictFirst = app.execute(reviewConflict);
        expect(reviewConflictFirst.result).toMatchObject({
          kind: "rejected",
          code: "TASK_VERSION_CONFLICT",
        });
        const cancelConflict = {
          ...createCancelEnvelope(),
          requestId: "host-cancel-conflict" as HostRequestId,
          expectedVersion: 99,
        };
        const cancelConflictFirst = app.execute(cancelConflict);
        expect(cancelConflictFirst.result).toMatchObject({
          kind: "rejected",
          code: "TASK_VERSION_CONFLICT",
        });
        const recConflict = {
          ...createReconcileEnvelope(),
          requestId: "host-rec-conflict" as HostRequestId,
          expectedVersion: 99,
        };
        const recConflictFirst = app.execute(recConflict);
        expect(recConflictFirst.result).toMatchObject({
          kind: "rejected",
          code: "TASK_VERSION_CONFLICT",
        });

        // Advance from observed 2 to 3, then old requests must still replay the original conflict.
        const base = store.getTask(taskId)?.aggregate;
        if (!base) throw new Error("task missing");
        seedAggregate(store, "seed-advance", 2, { ...base, task: { ...base.task, version: 3 } }, [
          { type: "advanced", taskId },
        ]);
        expect(app.execute(reviewConflict).result).toEqual(reviewConflictFirst.result);
        expect(app.execute(cancelConflict).result).toEqual(cancelConflictFirst.result);
        expect(app.execute(recConflict).result).toEqual(recConflictFirst.result);
      });
    });

    it("covers submit-external-review authority and stage edge cases", () => {
      const runReviewCase = (stageMutator: (stage: Stage) => Stage, expectedCode: string): void => {
        withTempAuthorityStore((store) => {
          const app = createHostApplication(store, defaultHostIds());
          app.execute(createEnvelope());
          const base = store.getTask(taskId)?.aggregate;
          if (!base) throw new Error("task missing");
          const seeded: TaskAggregate = {
            ...base,
            task: { ...base.task, version: 2 },
            stages: { [stageId]: stageMutator(evaluationStage()) },
            candidates: { [candidateId]: candidateEntity() },
          };
          seedAggregate(store, `seed-${expectedCode}`, 1, seeded, [
            { type: "stage-materialized", taskId },
          ]);
          const before = snapshotCommandState(store, taskId);
          const response = app.execute(
            createReviewEnvelope({ requestId: `host-${expectedCode}` as HostRequestId }),
          );
          expect(response.result).toMatchObject({ kind: "rejected", code: expectedCode });
          const after = snapshotCommandState(store, taskId);
          expect(after.task).toEqual(before.task);
          expect(after.history).toEqual(before.history);
          expect(after.receiptCount).toBe(before.receiptCount + 1);
        });
      };

      const runReviewCommandCase = (
        commandMutator: (envelope: HostCommandEnvelope) => HostCommandEnvelope,
        expectedCode: string,
      ): void => {
        withTempAuthorityStore((store) => {
          const app = createHostApplication(store, defaultHostIds());
          app.execute(createEnvelope());
          const base = store.getTask(taskId)?.aggregate;
          if (!base) throw new Error("task missing");
          const seeded: TaskAggregate = {
            ...base,
            task: { ...base.task, version: 2 },
            stages: { [stageId]: evaluationStage() },
            candidates: { [candidateId]: candidateEntity() },
          };
          seedAggregate(store, `seed-${expectedCode}`, 1, seeded, [
            { type: "stage-materialized", taskId },
          ]);
          const before = snapshotCommandState(store, taskId);
          const response = app.execute(commandMutator(createReviewEnvelope()));
          expect(response.result).toMatchObject({ kind: "rejected", code: expectedCode });
          const after = snapshotCommandState(store, taskId);
          expect(after.task).toEqual(before.task);
          expect(after.history).toEqual(before.history);
          expect(after.receiptCount).toBe(before.receiptCount + 1);
        });
      };

      runReviewCase(
        (stage) => ({
          ...stage,
          semanticInputs: stage.semanticInputs.filter(
            (input) => input.name !== "authority-requirement",
          ),
        }),
        "HOST_REVIEW_NOT_EXPECTED",
      );
      runReviewCase(
        (stage) => ({
          ...stage,
          semanticInputs: [
            ...stage.semanticInputs,
            {
              name: "authority-requirement-2",
              value: descriptor("authority-requirement", "req:2"),
            },
          ],
        }),
        "HOST_REVIEW_NOT_EXPECTED",
      );
      runReviewCase((stage) => ({ ...stage, role: "work" }), "HOST_REVIEW_NOT_EXPECTED");
      runReviewCase(
        (stage) => ({ ...stage, status: "completed", completion: { kind: "succeeded" } }),
        "HOST_REVIEW_NOT_EXPECTED",
      );
      runReviewCase((stage) => ({ ...stage, status: "pending" }), "HOST_REVIEW_NOT_EXPECTED");
      runReviewCommandCase(
        (envelope) =>
          ({
            ...envelope,
            requestId: "host-review-candidate" as HostRequestId,
            command: { ...envelope.command, candidateId: "C2" as CandidateId },
          }) as HostCommandEnvelope,
        "REVIEW_TARGET_MISMATCH",
      );
      runReviewCommandCase(
        (envelope) =>
          ({
            ...envelope,
            requestId: "host-review-stage" as HostRequestId,
            command: { ...envelope.command, stageId: "S-unknown" as StageId },
          }) as HostCommandEnvelope,
        "HOST_REVIEW_NOT_EXPECTED",
      );

      withTempAuthorityStore((store) => {
        const app = createHostApplication(store, defaultHostIds());
        app.execute(createEnvelope());
        const base = store.getTask(taskId)?.aggregate;
        if (!base) throw new Error("task missing");
        const seeded: TaskAggregate = {
          ...base,
          task: { ...base.task, version: 2 },
          stages: { [stageId]: evaluationStage() },
          candidates: { [candidateId]: candidateEntity() },
        };
        seedAggregate(store, "seed-success-order", 1, seeded, [
          { type: "stage-materialized", taskId },
        ]);
        const response = app.execute(
          createReviewEnvelope({ requestId: "host-success-order" as HostRequestId }),
        );
        expect(response.result).toMatchObject({
          kind: "committed",
          committedVersion: 3,
          outcome: "external-review-recorded",
        });
        const found = store.getTask(taskId);
        if (!found) throw new Error("task missing");
        expect(found.observedVersion).toBe(3);
        expect(found.aggregate.task.version).toBe(3);
        expect(found.aggregate.reviews[reviewId]).toEqual({
          id: reviewId,
          taskId,
          stageId,
          candidateId,
          authorityRequirement: descriptor("authority-requirement", "req:review:1"),
          disposition: "pass",
          evidence: [artifact("evidence:1")],
          decisionProvenance: { kind: "actor", actorRef: "actor:host" },
        });
        expect(found.aggregate.stages[stageId]).toMatchObject({
          status: "completed",
          completion: { kind: "review", ref: reviewId },
        });
        const history = store.getAuthorityHistory(taskId);
        expect(history.map((commit) => commit.facts)).toEqual([
          [{ type: "task-created", taskId }],
          [{ type: "stage-materialized", taskId }],
          [
            {
              type: "external-review-submitted",
              taskId,
              stageId,
              reviewId,
              candidateId,
            },
            {
              type: "stage-completed",
              taskId,
              stageId,
              completion: { kind: "review", ref: reviewId },
            },
          ],
        ]);
      });
    });

    it("covers cancel-task stage and operation preservation and descriptor/fact coverage", () => {
      withTempAuthorityStore((store) => {
        const app = createHostApplication(store, defaultHostIds());
        app.execute(createEnvelope());
        const base = store.getTask(taskId)?.aggregate;
        if (!base) throw new Error("task missing");
        const pendingStage: Stage = {
          ...evaluationStage(),
          id: "S-pending" as StageId,
          materializationKey: "pending:1" as Stage["materializationKey"],
          status: "pending",
        };
        const completedStage: Stage = {
          ...evaluationStage(),
          id: "S-completed" as StageId,
          materializationKey: "completed:1" as Stage["materializationKey"],
          status: "completed",
          completion: { kind: "succeeded" },
        };
        const failedStage: Stage = {
          ...evaluationStage(),
          id: "S-failed" as StageId,
          materializationKey: "failed:1" as Stage["materializationKey"],
          status: "failed",
          failure: descriptor("stage-failure", "failure:1", { reason: "boom" }),
        };
        const cancelledStage: Stage = {
          ...evaluationStage(),
          id: "S-cancelled" as StageId,
          materializationKey: "cancelled:1" as Stage["materializationKey"],
          status: "cancelled",
          cancellation: descriptor("stage-cancellation", "cancel:old", { reason: "old" }),
        };
        const dispatched = {
          ...preparedOperation(),
          id: "O-dispatched" as OperationId,
          status: "dispatched" as const,
        };
        const indeterminate = {
          ...preparedOperation(),
          id: "O-indeterminate" as OperationId,
          status: "indeterminate" as const,
        };
        const confirmed = {
          ...preparedOperation(),
          id: "O-confirmed" as OperationId,
          status: "confirmed" as const,
          confirmation: artifact("confirm:1"),
        };
        const abortedOp = {
          ...preparedOperation(),
          id: "O-aborted" as OperationId,
          status: "aborted" as const,
          abortReason: descriptor("operation-abort", "abort:existing"),
        };
        const earlierPrepared = {
          ...preparedOperation(),
          id: "O0" as OperationId,
        };
        const cancellation = descriptor("task-cancellation", "cancel:matrix", {
          reason: "manual",
        });
        const seeded: TaskAggregate = {
          ...base,
          task: { ...base.task, version: 2 },
          stages: {
            [stageId]: evaluationStage(),
            [pendingStage.id]: pendingStage,
            [completedStage.id]: completedStage,
            [failedStage.id]: failedStage,
            [cancelledStage.id]: cancelledStage,
          },
          candidates: { [candidateId]: candidateEntity() },
          operations: {
            [operationId]: preparedOperation(),
            [earlierPrepared.id]: earlierPrepared,
            [dispatched.id]: dispatched,
            [indeterminate.id]: indeterminate,
            [confirmed.id]: confirmed,
            [abortedOp.id]: abortedOp,
          },
        };
        seedAggregate(store, "seed-cancel-matrix", 1, seeded, [
          { type: "stage-materialized", taskId },
        ]);
        const response = app.execute({
          ...createCancelEnvelope({ requestId: "host-cancel-matrix" as HostRequestId }),
          command: {
            type: "cancel-task",
            taskId,
            actorRef: "actor:host" as ActorRef,
            cancellation,
          },
        } as HostCommandEnvelope);
        expect(response.result).toMatchObject({
          kind: "committed",
          committedVersion: 3,
          outcome: "task-cancelled",
        });
        const found = store.getTask(taskId)?.aggregate;
        if (!found) throw new Error("task missing");
        expect(found.stages[stageId].status).toBe("cancelled");
        expect(found.stages[pendingStage.id].status).toBe("cancelled");
        expect(found.stages[completedStage.id].status).toBe("completed");
        expect(found.stages[completedStage.id]).toMatchObject({
          completion: { kind: "succeeded" },
        });
        expect(found.stages[failedStage.id].status).toBe("failed");
        expect(found.stages[failedStage.id]).toMatchObject({
          failure: { identity: "failure:1" },
        });
        expect(found.stages[cancelledStage.id].status).toBe("cancelled");
        expect(found.stages[cancelledStage.id]).toMatchObject({
          cancellation: { identity: "cancel:old" },
        });
        expect(found.operations[operationId].status).toBe("aborted");
        expect(found.operations[earlierPrepared.id].status).toBe("aborted");
        expect(found.operations[dispatched.id].status).toBe("dispatched");
        expect(found.operations[indeterminate.id].status).toBe("indeterminate");
        expect(found.operations[confirmed.id].status).toBe("confirmed");
        expect(found.operations[confirmed.id]).toMatchObject({
          confirmation: { ref: "confirm:1" },
        });
        expect(found.operations[abortedOp.id].status).toBe("aborted");
        expect(found.operations[abortedOp.id]).toMatchObject({
          abortReason: { identity: "abort:existing" },
        });

        const activeCancelled = found.stages[stageId] as Extract<Stage, { status: "cancelled" }>;
        const pendingCancelled = found.stages[pendingStage.id] as Extract<
          Stage,
          { status: "cancelled" }
        >;
        expect(activeCancelled.currentExecutionGeneration).toBe(1);
        expect(pendingCancelled.currentExecutionGeneration).toBe(1);

        const activeStageIdentity =
          "sha256:b673e27ec8719ce9e69a24533874e740750ff058466d9758ff6f917005c79700";
        const pendingStageIdentity =
          "sha256:75b40d0b4cdaf9ec8207eef06c7f9959da8ad3b11eb14a0d297347dbcfc12771";
        const earlierOperationIdentity =
          "sha256:413380d6a6b34824e85e3d4c1d18c4e6f11c6529d7665d5201f23c43be35789e";
        const operationIdentity =
          "sha256:686b947ba0732c3eca78bda1ab08ba069a7e158352b570f991b9556dfe3fe771";

        const stageCancellation = activeCancelled.cancellation;
        expect(stageCancellation).toEqual({
          kind: "stage-cancellation",
          contractVersion: cancellation.contractVersion,
          identity: activeStageIdentity,
          value: {
            taskCancellationIdentity: cancellation.identity,
            taskId,
            stageId,
          },
        });
        const pendingCancellation = pendingCancelled.cancellation;
        expect(pendingCancellation).toEqual({
          kind: "stage-cancellation",
          contractVersion: cancellation.contractVersion,
          identity: pendingStageIdentity,
          value: {
            taskCancellationIdentity: cancellation.identity,
            taskId,
            stageId: pendingStage.id,
          },
        });
        const operationAbort = (
          found.operations[operationId] as Extract<Operation, { status: "aborted" }>
        ).abortReason;
        expect(operationAbort).toEqual({
          kind: "operation-abort",
          contractVersion: cancellation.contractVersion,
          identity: operationIdentity,
          value: {
            taskCancellationIdentity: cancellation.identity,
            taskId,
            operationId,
          },
        });
        const earlierOperationAbort = (
          found.operations[earlierPrepared.id] as Extract<Operation, { status: "aborted" }>
        ).abortReason;
        expect(earlierOperationAbort).toEqual({
          kind: "operation-abort",
          contractVersion: cancellation.contractVersion,
          identity: earlierOperationIdentity,
          value: {
            taskCancellationIdentity: cancellation.identity,
            taskId,
            operationId: earlierPrepared.id,
          },
        });

        const history = store.getAuthorityHistory(taskId);
        const cancelFacts = history[history.length - 1]?.facts ?? [];
        expect(cancelFacts).toEqual([
          {
            type: "task-cancelled",
            taskId,
            cancellationIdentity: cancellation.identity,
          },
          {
            type: "stage-cancelled",
            taskId,
            stageId: pendingStage.id,
            previousGeneration: 0,
            newGeneration: 1,
            cancellationIdentity: cancellation.identity,
            descriptorIdentity: pendingStageIdentity,
          },
          {
            type: "stage-cancelled",
            taskId,
            stageId,
            previousGeneration: 0,
            newGeneration: 1,
            cancellationIdentity: cancellation.identity,
            descriptorIdentity: activeStageIdentity,
          },
          {
            type: "operation-aborted",
            taskId,
            operationId: earlierPrepared.id,
            cancellationIdentity: cancellation.identity,
            descriptorIdentity: earlierOperationIdentity,
          },
          {
            type: "operation-aborted",
            taskId,
            operationId,
            cancellationIdentity: cancellation.identity,
            descriptorIdentity: operationIdentity,
          },
        ]);
      });
    });
  });

  describe("Host query regression matrix", () => {
    it("covers getTask found, not-found, observedVersion, schema version, and aggregate", () => {
      withTempAuthorityStore((store) => {
        const app = createHostApplication(store, defaultHostIds());
        expect(app.getTask(taskId)).toEqual({ kind: "task-not-found", taskId });
        app.execute(createEnvelope());
        const found = app.getTask(taskId);
        expect(found.kind).toBe("found");
        if (found.kind === "found") {
          expect(found.observedVersion).toBe(1);
          expect(found.aggregateSchemaVersion).toBe(1);
          expect(found.aggregate.task.id).toBe(taskId);
          expect(found.aggregate.task.status).toBe("active");
        }
      });
    });

    it("covers listTasks status filter, limits, invalid inputs, cursor pagination, and stable order", () => {
      withTempAuthorityStore((store) => {
        const app = createHostApplication(store, defaultHostIds());
        app.execute(createEnvelope());
        const app2 = createHostApplication(store, {
          taskId: () => "T2" as TaskId,
          reviewId: () => "R2" as ReviewId,
        });
        app2.execute({ ...createEnvelope(), requestId: "host-req-2" as HostRequestId });

        expect(app.listTasks().items.map((item) => item.taskId)).toEqual(["T1", "T2"]);
        expect(app.listTasks({ status: "active" }).items).toHaveLength(2);
        expect(app.listTasks({ status: "completed" }).items).toHaveLength(0);
        expect(app.listTasks({ limit: 1 }).items).toHaveLength(1);
        expect(
          app.listTasks({ limit: 1, cursor: app.listTasks({ limit: 1 }).nextCursor }).items,
        ).toHaveLength(1);
        assertHostQueryError(() => app.listTasks({ status: "bogus" as never }), "INVALID_STATUS");
        assertHostQueryError(() => app.listTasks({ limit: 0 }), "INVALID_LIMIT");
        assertHostQueryError(() => app.listTasks({ limit: -1 }), "INVALID_LIMIT");
        assertHostQueryError(() => app.listTasks({ limit: 1.5 }), "INVALID_LIMIT");
      });
    });

    it("covers getAuthorityHistory found, not-found, limits, cursor pagination, and commit order", () => {
      withTempAuthorityStore((store) => {
        const app = createHostApplication(store, defaultHostIds());
        expect(app.getAuthorityHistory(taskId)).toEqual({ kind: "task-not-found", taskId });
        app.execute(createEnvelope());
        const base = store.getTask(taskId)?.aggregate;
        if (!base) throw new Error("task missing");
        seedAggregate(
          store,
          "seed-history-query",
          1,
          { ...base, task: { ...base.task, version: 2 } },
          [{ type: "advanced", taskId }],
        );
        const found = app.getAuthorityHistory(taskId);
        if (found.kind !== "found") throw new Error("expected history");
        expect(found.observedVersion).toBe(2);
        expect(found.items.map((item) => item.committedVersion)).toEqual([1, 2]);
        const page = app.getAuthorityHistory(taskId, { limit: 1 });
        if (page.kind !== "found" || !page.nextCursor) throw new Error("expected page");
        const next = app.getAuthorityHistory(taskId, { limit: 1, cursor: page.nextCursor });
        if (next.kind !== "found") throw new Error("expected next");
        expect([...page.items, ...next.items].map((item) => item.committedVersion)).toEqual([1, 2]);
        assertHostQueryError(() => app.getAuthorityHistory(taskId, { limit: 0 }), "INVALID_LIMIT");
        assertHostQueryError(() => app.getAuthorityHistory(taskId, { limit: -1 }), "INVALID_LIMIT");
        assertHostQueryError(
          () => app.getAuthorityHistory(taskId, { limit: 1.5 }),
          "INVALID_LIMIT",
        );
      });
    });

    it("proves queries are read-only", () => {
      withTempAuthorityStore((store, path) => {
        const app = createHostApplication(store, defaultHostIds());
        app.execute(createEnvelope());
        const base = store.getTask(taskId)?.aggregate;
        if (!base) throw new Error("task missing");
        seedAggregate(store, "seed-readonly", 1, { ...base, task: { ...base.task, version: 2 } }, [
          { type: "advanced", taskId },
        ]);
        const beforeTask = store.getTask(taskId);
        const beforeHistory = store.getAuthorityHistory(taskId);
        app.getTask(taskId);
        app.listTasks({ status: "active", limit: 1 });
        const history = app.getAuthorityHistory(taskId, { limit: 1 });
        if (history.kind !== "found" || !history.nextCursor)
          throw new Error("expected history page");
        app.getAuthorityHistory(taskId, { cursor: history.nextCursor });
        expect(store.getTask(taskId)).toEqual(beforeTask);
        expect(store.getAuthorityHistory(taskId)).toEqual(beforeHistory);

        store.close();
        const db = openRawDatabase(path);
        try {
          const count = (
            db.prepare("SELECT COUNT(*) AS count FROM command_receipts").get() as { count: number }
          ).count;
          expect(count).toBe(2);
        } finally {
          db.close();
        }
      });
    });
  });
});
