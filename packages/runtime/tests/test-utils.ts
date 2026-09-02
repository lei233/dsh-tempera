import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import type { AuthorityStore } from "../src/index";
import { AuthorityStoreError, openSqliteAuthorityStore } from "../src/index";

export const nodeRequire = createRequire(import.meta.url);
export type MutableDatabase = ReturnType<typeof openRawDatabase>;

export interface TempAuthorityStore {
  readonly store: AuthorityStore;
  readonly path: string;
  readonly dir: string;
  cleanup(): void;
}

export const openRawDatabase = (path: string) => {
  const Database = nodeRequire("better-sqlite3") as unknown as new (path: string) => {
    exec(sql: string): unknown;
    prepare(sql: string): {
      run(...params: unknown[]): { changes: number };
      get(...params: unknown[]): unknown;
      all(...params: unknown[]): unknown[];
    };
    close(): void;
  };
  return new Database(path);
};

export const tempAuthorityStore = (prefix = "tempera-test-"): TempAuthorityStore => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const path = join(dir, "authority.sqlite");
  const store = openSqliteAuthorityStore(path);
  return {
    store,
    path,
    dir,
    cleanup() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
};

export const withTempAuthorityStore = <T>(
  fn: (store: AuthorityStore, path: string) => T,
  prefix = "tempera-test-",
): T => {
  const fixture = tempAuthorityStore(prefix);
  try {
    return fn(fixture.store, fixture.path);
  } finally {
    fixture.cleanup();
  }
};

export const mutateReceipt = (path: string, requestId: string, result: unknown): void => {
  const db = openRawDatabase(path);
  try {
    db.exec("DROP TRIGGER IF EXISTS command_receipts_no_update");
    const info = db
      .prepare("UPDATE command_receipts SET result_json = ? WHERE request_id = ?")
      .run(JSON.stringify(result), requestId);
    if (info.changes !== 1) {
      throw new Error(`Expected exactly one receipt for ${requestId}, but changed ${info.changes}`);
    }
  } finally {
    db.close();
  }
};

export const getReceiptCount = (store: AuthorityStore): number => {
  const db = (
    store as unknown as {
      db: { prepare(sql: string): { get(...params: unknown[]): { count: number } } };
    }
  ).db;
  const row = db.prepare("SELECT COUNT(*) AS count FROM command_receipts").get();
  return row.count;
};

export const expectAuthorityCorruption = (action: () => unknown): void => {
  let error: unknown;
  try {
    action();
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(AuthorityStoreError);
  expect((error as AuthorityStoreError).code).toBe("CORRUPT_DATA");
};

export const cursorFromJson = (versionedJson: string): string =>
  Buffer.from(versionedJson, "utf8").toString("base64url");

export const cursorFromPayload = (version: string, payload: unknown): string =>
  cursorFromJson(`${version}:${JSON.stringify(payload)}`);
