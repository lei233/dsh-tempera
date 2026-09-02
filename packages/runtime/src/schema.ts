import type Database from "better-sqlite3";
import { AuthorityStoreError } from "./errors";

export const currentDatabaseSchemaVersion = 1 as const;
export const minimumSqliteVersion = "3.51.3";

const sqliteVersionAtLeast = (version: string, minimum: string): boolean => {
  const parse = (value: string): number[] =>
    value.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const left = parse(version);
  const right = parse(minimum);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    if (a !== b) {
      return a > b;
    }
  }
  return true;
};

const assertSqliteVersion = (db: Database.Database): void => {
  const row = db.prepare("SELECT sqlite_version() AS version").get() as { version: string };
  if (!sqliteVersionAtLeast(row.version, minimumSqliteVersion)) {
    throw new AuthorityStoreError(
      "UNSUPPORTED_DATABASE_SCHEMA",
      `SQLite ${row.version} is older than required ${minimumSqliteVersion}`,
    );
  }
};

const normalizePragmaValue = (value: string | number): string | number => {
  if (value === 2 || value === "2" || value === "full") {
    return "full";
  }
  if (value === 1 || value === "1" || value === "on") {
    return "on";
  }
  return typeof value === "string" ? value.toLowerCase() : value;
};

const assertPragma = (db: Database.Database, name: string, expected: string | number): void => {
  const actual = db.pragma(name, { simple: true }) as string | number;
  const normalized = normalizePragmaValue(actual);
  const expectedNormalized = normalizePragmaValue(expected);
  if (normalized !== expectedNormalized) {
    throw new AuthorityStoreError(
      "UNSUPPORTED_DATABASE_SCHEMA",
      `PRAGMA ${name} expected ${String(expected)} but got ${String(actual)}`,
    );
  }
};

export const configureConnection = (db: Database.Database): void => {
  assertSqliteVersion(db);

  db.pragma("locking_mode = EXCLUSIVE");
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = FULL");
  db.pragma("foreign_keys = ON");

  assertPragma(db, "locking_mode", "exclusive");
  assertPragma(db, "journal_mode", "wal");
  assertPragma(db, "synchronous", "full");
  assertPragma(db, "foreign_keys", 1);
};

export const acquireExclusiveLock = (db: Database.Database): void => {
  try {
    db.exec("BEGIN EXCLUSIVE");
    db.exec("ROLLBACK");
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String((error as { code?: unknown }).code)
        : "";
    if (code === "SQLITE_BUSY" || code === "SQLITE_LOCKED") {
      throw new AuthorityStoreError(
        "OWNERSHIP_CONFLICT",
        `Another process owns the authority database: ${code}`,
      );
    }
    throw error;
  }
};

const migrationStatementsV1 = `
CREATE TABLE task_snapshots (
  task_id TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  status TEXT NOT NULL,
  aggregate_schema_version INTEGER NOT NULL,
  aggregate_json TEXT NOT NULL
);

CREATE TABLE authority_commits (
  task_id TEXT NOT NULL,
  committed_version INTEGER NOT NULL,
  previous_version INTEGER NOT NULL,
  command_identity TEXT NOT NULL UNIQUE,
  facts_json TEXT NOT NULL,
  PRIMARY KEY (task_id, committed_version),
  FOREIGN KEY (task_id) REFERENCES task_snapshots(task_id)
);

CREATE TABLE command_receipts (
  request_id TEXT PRIMARY KEY,
  payload_fingerprint TEXT NOT NULL,
  task_id TEXT NOT NULL,
  committed_version INTEGER,
  result_json TEXT NOT NULL
);

CREATE INDEX authority_commits_by_task_version
  ON authority_commits(task_id, committed_version);

CREATE INDEX command_receipts_by_task
  ON command_receipts(task_id);

CREATE TRIGGER authority_commits_no_update
BEFORE UPDATE ON authority_commits
BEGIN
  SELECT RAISE(ABORT, 'authority_commits are append-only');
END;

CREATE TRIGGER authority_commits_no_delete
BEFORE DELETE ON authority_commits
BEGIN
  SELECT RAISE(ABORT, 'authority_commits are append-only');
END;

CREATE TRIGGER command_receipts_no_update
BEFORE UPDATE ON command_receipts
BEGIN
  SELECT RAISE(ABORT, 'command_receipts are append-only');
END;

CREATE TRIGGER command_receipts_no_delete
BEFORE DELETE ON command_receipts
BEGIN
  SELECT RAISE(ABORT, 'command_receipts are append-only');
END;
`;

export const migrate = (db: Database.Database): void => {
  const currentVersion = db.pragma("user_version", { simple: true }) as number;

  if (currentVersion > currentDatabaseSchemaVersion) {
    throw new AuthorityStoreError(
      "UNSUPPORTED_DATABASE_SCHEMA",
      `Database schema version ${currentVersion} is newer than supported ${currentDatabaseSchemaVersion}`,
    );
  }

  if (currentVersion === currentDatabaseSchemaVersion) {
    return;
  }

  if (currentVersion !== 0) {
    throw new AuthorityStoreError(
      "UNSUPPORTED_DATABASE_SCHEMA",
      `Cannot migrate from database schema version ${currentVersion}`,
    );
  }

  db.exec("BEGIN");
  try {
    db.exec(migrationStatementsV1);
    db.pragma("user_version = 1");
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
};
