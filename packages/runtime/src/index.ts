export {
  AuthorityStoreError,
  authorityStoreErrorCodes,
  AuthorityStoreErrorCodes,
  CORRUPT_DATA,
  isAuthorityStoreError,
  OWNERSHIP_CONFLICT,
  REQUEST_ID_REUSE_MISMATCH,
  SQLITE_FAILURE,
  STORE_CLOSED,
  UNSUPPORTED_DATABASE_SCHEMA,
  type AuthorityStoreErrorCode,
} from "./errors";
export {
  aggregateSchemaVersion,
  decodeStoredTaskSnapshot,
  decodeTaskAggregate,
  encodeTaskAggregate,
  type StoredTaskSnapshotRow,
  type TaskSnapshot,
} from "./codec";
export { currentDatabaseSchemaVersion, minimumSqliteVersion } from "./schema";
export {
  openSqliteAuthorityStore,
  type AuthorityCommit,
  type AuthorityHistoryOptions,
  type AuthorityStore,
  type CommitTaskDecision,
  type ExecuteTaskCommandInput,
  type ListTasksOptions,
  type NoWriteTaskDecision,
  type PreconditionFailure,
  type PreconditionFailureHandler,
  type ResultCodec,
  type TaskCommandResponse,
  type TaskDecision,
  type TaskSummary,
} from "./store";
