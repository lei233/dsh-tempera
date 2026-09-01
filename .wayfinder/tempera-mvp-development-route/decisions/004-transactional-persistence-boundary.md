# Transactional persistence boundary decision

## Verdict

The MVP authority store is a Tempera-owned SQLite database accessed through
`better-sqlite3`. It is composed into the runtime behind an application-level
`AuthorityStore` port; the Domain remains unaware of SQLite, SQL, transactions,
serialization, codecs, and migrations.

One database supports exactly one active Task Manager. The manager owns one
long-lived SQLite connection and fails closed if it cannot establish exclusive
ownership before migration or recovery begins.

## Connection and durability baseline

The authority connection establishes the following baseline before serving any
command or recovery work:

```text
PRAGMA locking_mode = EXCLUSIVE
PRAGMA journal_mode = WAL
PRAGMA synchronous = FULL
PRAGMA foreign_keys = ON
```

The adapter must force acquisition of the exclusive lock during startup. A lock
conflict is a startup failure, not a reason to fall back to shared access or to
wait indefinitely. All command, query, migration, journal, receipt, and recovery
access goes through the owned connection. Process termination releases SQLite's
file lock; the MVP does not add a sidecar lock, heartbeat lease, or active-active
manager protocol.

This is a supported-topology boundary, not distributed coordination. A later
implementation must still test that an accidental second process cannot mutate,
recover, or dispatch work against the database.

## Hybrid durable layout

The authority store uses three logical table responsibilities in one SQLite
database:

1. **Task snapshots** store the complete current `TaskAggregate` as validated JSON
   together with queryable `taskId`, `version`, `status`, and
   `aggregateSchemaVersion` metadata.
2. **Authority journal commits** are append-only. Each authoritative Task version
   has exactly one immutable commit record keyed by `(taskId, committedVersion)`
   and containing `previousVersion`, command identity, and an ordered batch of
   authority facts.
3. **Command receipts** store request identity, payload fingerprint, the exact
   deterministic result, and the committed Task version when one exists.

One authority command may create several related facts, such as accepting a
Candidate and completing its Stage. Those facts remain one ordered batch in the
single journal commit for the new Task version. A deterministic no-write result
has a receipt but no journal commit and does not advance `Task.version`.

The seven Domain entities are not normalized into seven relational table families
for the MVP. They remain a provider-neutral aggregate snapshot. Conversely, the
journal and request ledger are not embedded in that snapshot: keeping them in
separate append-only tables avoids rewriting history and lets one SQLite
transaction bind all three durable responsibilities.

Exact table and column spellings are mechanical implementation details. The
semantic separation and atomic relationships above are frozen.

## AuthorityStore transaction contract

`AuthorityStore` owns the transaction. Its Task command operation accepts the
application command identity and fingerprint, Task identity and expected version
where applicable, plus a strictly synchronous, deterministic, I/O-free decision
function over the exact durable Task snapshot.

Conceptually, one call performs:

```text
begin authoritative transaction
  find command receipt by request identity
  if found:
    require the same payload fingerprint
    return the exact durable result without invoking the decision function

  load and validate the current Task snapshot
  validate Task-level expected version / creation precondition
  invoke the pure decision function

  if the decision changes authority:
    write the next aggregate snapshot
    append exactly one journal commit for the new Task version

  write the deterministic command receipt
commit
```

Same request identity plus the same fingerprint replays the stored result. Same
request identity plus a different fingerprint is a hard mismatch. The exact
request-id namespace and public command envelope remain owned by
“Fix the MVP host command and query contract”.

The decision function may return either a next aggregate with ordered journal
facts and a result, or a deterministic no-write rejection. It may not perform
artifact verification, provider calls, filesystem work, Git operations, clock or
identifier generation, logging that correctness depends on, or any other I/O.
Such preparation happens before entering the transaction; the decision function
only validates and applies its frozen inputs to the exact snapshot.

The receipt ledger includes successful commits, deterministic Domain rejections,
and Task-version conflicts. Persisting conflicts prevents the same request from
later changing meaning after state advances; a caller that intentionally retries
against a new version uses a new request identity. Infrastructure failures,
process termination, transaction rollback, and failures before a deterministic
result exists do not create receipts, so the same request may be retried safely.

## Serialization and migration boundary

The runtime owns a versioned aggregate codec. Every snapshot has an explicit
`aggregateSchemaVersion` and is strictly validated on read. An unknown or newer
version fails closed instead of being interpreted approximately.

Database-schema migrations and aggregate representation migrations are distinct.
An automatic aggregate migration may only change representation while preserving
the frozen Domain meaning. A change to Task semantics, policy meaning, authority,
or historical interpretation is not a storage migration and must not happen
silently; it requires a future explicit authority/migration decision.

Neither the append-only authority journal, command receipts, nor terminal Task
snapshots are pruned during the MVP lifetime of the database.

## Consequences for downstream decisions

- “Fix the MVP host command and query contract” fixes the external envelope,
  request-id namespace, typed results, and query surface without exposing this
  database layout.
- “Specify the authoritative transaction and recovery protocol” defines exact
  per-command facts, crash scans, recovery actions, and transaction fault points
  on top of this `AuthorityStore` boundary.
- The operational projection and inspection surface remains fog until both the
  host query contract and recovery protocol are fixed.
- The repository/package placement of the port, SQLite adapter, codecs,
  migrations, fixtures, and conformance tests remains deferred until the related
  service and test boundaries are known.

## Explicitly rejected alternatives

- DSH `storageDomain` as the authority store: it has no promised multi-record
  transaction spanning snapshot, journal, and receipt.
- A single DSH KV envelope containing current state and all history: it rewrites
  unbounded history and makes recovery inspection and evolution unnecessarily
  fragile.
- Fully normalized tables for every Domain entity: it increases schema and mapper
  coupling before the MVP has proven a need for relational entity-level access.
- Generic CRUD or Unit-of-Work persistence ports: they leak storage mechanics and
  let callers accidentally split the authoritative commit.
- Application-managed load/decide/commit: Task CAS could make it safe, but it
  disperses idempotency replay and transaction ordering outside the authority
  store selected to own them.
- Multiple active managers, sidecar stale locks, and heartbeat lease takeover:
  they introduce split-brain and distributed recovery semantics outside the MVP.
- Node 22 `node:sqlite`: the supported Node 22 baseline still exposes it as an
  experimental API, while this boundary is correctness-critical.
