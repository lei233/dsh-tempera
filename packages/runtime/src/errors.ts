export const REQUEST_ID_REUSE_MISMATCH = "REQUEST_ID_REUSE_MISMATCH";
export const OWNERSHIP_CONFLICT = "OWNERSHIP_CONFLICT";
export const UNSUPPORTED_DATABASE_SCHEMA = "UNSUPPORTED_DATABASE_SCHEMA";
export const CORRUPT_DATA = "CORRUPT_DATA";
export const STORE_CLOSED = "STORE_CLOSED";
export const SQLITE_FAILURE = "SQLITE_FAILURE";

export const authorityStoreErrorCodes = [
  REQUEST_ID_REUSE_MISMATCH,
  OWNERSHIP_CONFLICT,
  UNSUPPORTED_DATABASE_SCHEMA,
  CORRUPT_DATA,
  STORE_CLOSED,
  SQLITE_FAILURE,
] as const;

export const AuthorityStoreErrorCodes = {
  REQUEST_ID_REUSE_MISMATCH,
  OWNERSHIP_CONFLICT,
  UNSUPPORTED_DATABASE_SCHEMA,
  CORRUPT_DATA,
  STORE_CLOSED,
  SQLITE_FAILURE,
} as const;

export type AuthorityStoreErrorCode = (typeof authorityStoreErrorCodes)[number];

export class AuthorityStoreError extends Error {
  readonly code: AuthorityStoreErrorCode;

  constructor(code: AuthorityStoreErrorCode, message: string) {
    super(message);
    this.name = "AuthorityStoreError";
    this.code = code;
  }
}

export const isAuthorityStoreError = (error: unknown): error is AuthorityStoreError =>
  error instanceof AuthorityStoreError;
