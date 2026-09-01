# MVP Host command and query contract decision

## Verdict

Freeze a narrow, versioned Host application boundary with exactly four semantic commands:

```text
create-task
submit-external-review
cancel-task
request-operation-reconciliation
```

The Host does not receive a generic Domain-command passthrough. Stage materialization, Invocation preparation and proposal acceptance, policy Approval, Operation preparation/dispatch/result recording, Task failure, and Task completion remain internal Task Manager/runtime decisions. A future policy that genuinely grants an external actor a distinct Approval authority must add a new named Host command and authority contract; it must not widen this MVP surface implicitly.

The user validated this boundary using the logic prototype captured on branch `codex/prototype-host-command-query-contract` at commit `3ed90c4` in `packages/runtime/prototypes/host-command-query-contract.html`.

## Public command envelope

Every Host command uses one normalized semantic envelope:

```ts
interface HostCommandEnvelope<Command extends HostCommand> {
  readonly contractVersion: "tempera.host-command.v1";
  readonly requestId: HostRequestId;
  readonly expectedVersion: number;
  readonly command: Command;
}
```

`requestId` is caller-supplied and manager-wide across the authority database, not scoped to a Task or transient Host session. Host IDs must not use the reserved `tempera:` prefix, which the runtime may use for stable internal command identities. Callers should use collision-resistant opaque IDs.

`expectedVersion` is always present. `create-task` uses `0`, meaning that no Task authority exists yet. Every other Host command names one `taskId` and compares against that Task's exact current version.

The application normalizes a trusted transport caller into a durable `ActorRef` before executing an authority-sensitive command. That `ActorRef` is included in the semantic command and its fingerprint. Session IDs, connection IDs, trace IDs, deadlines, and other delivery metadata are excluded. A replacement Host session can therefore redeliver the same semantic request for the same actor without changing its identity.

## Host commands

### `create-task`

The command carries the complete frozen `creationSpec`, `policySnapshot`, and `authorityScope` required by Task Domain v1. A mutable profile reference is not sufficient at this boundary: profile compilation must happen before the normalized command so retry after configuration change cannot silently change Task meaning.

The application prepares a new `TaskId` and initial aggregate for the authority-store transaction. A committed result durably returns `taskId` and version `1`. If the transaction rolls back before any receipt or Task exists, a later exact retry may safely prepare another ID because no identity obtained authority.

### `submit-external-review`

The command carries:

```text
taskId
stageId
candidateId
actorRef
disposition
one-or-more immutable evidence bindings
```

The Task Manager reads the active external evaluation Stage and verifies its frozen Candidate and authority requirement. The command may create exactly one immutable Review and complete that Stage in one authoritative commit. It never accepts a mutable report, a session identity, an Approval, or an arbitrary Stage outcome.

### `cancel-task`

The command carries `taskId`, the normalized authorized `actorRef`, and a frozen cancellation descriptor. A successful commit terminally cancels the Task, revokes new authority, fences current Invocation generations, prevents new materialization, and initiates best-effort executor cancellation outside the transaction. Already-dispatched or indeterminate Operations retain their reconciliation obligation.

### `request-operation-reconciliation`

The command carries `taskId`, exact `operationId`, and an authorized `actorRef`. It is legal only for the same `indeterminate` Operation at the expected Task version.

Its deterministic result is `reconciliation-required`, normally without an authority mutation or Task-version advance. The durable Operation state—not this wake-up request—is the reconciliation obligation, so restart scanning must still find it if the process dies after storing the receipt but before waking a provider. Provider evidence returns through the internal runtime path and is committed through the same authoritative reconciliation transition as normal recovery; the Host cannot submit confirmation or request speculative redispatch.

## Idempotency and result contract

The receipt key is the manager-wide `requestId`. Its canonical payload fingerprint covers:

```text
contractVersion
expectedVersion
complete normalized semantic command, including task target and ActorRef
```

It excludes `requestId` itself and non-semantic delivery metadata.

Rules are fixed:

- same `requestId` and same fingerprint returns the exact stored durable result without running the decision again;
- same `requestId` and a different fingerprint returns a hard `REQUEST_ID_REUSE_MISMATCH` protocol error and creates no new receipt;
- a deliberate retry after inspecting a version conflict uses a new `requestId` and the newly observed `expectedVersion`;
- deterministic success, deterministic Domain rejection, Task-version conflict, and accepted no-write outcomes receive durable receipts;
- infrastructure failure, process termination, transaction rollback, and failure before a deterministic result exists receive no receipt, so the exact same request may be retried.

The durable result is separate from delivery metadata:

```ts
interface HostCommandResponse {
  readonly delivery: "first-observation" | "replay";
  readonly result: DurableHostCommandResult;
}

type DurableHostCommandResult =
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
```

`delivery` may differ on replay; the nested durable result does not. Rejections use closed machine-readable codes plus bounded structured details. Human prose is diagnostic and is not the sole contract.

## Internal authority commands

The narrow Host union does not weaken retry requirements inside the Task Manager. Runtime-owned authority commands still use the same application command coordinator and `AuthorityStore` transaction contract with a stable request identity and Task `expectedVersion`.

Internal identities are derived or allocated from durable semantic keys such as `materializationKey`, `launchKey`, proposal identity/disposition, or `effectKey`, then stored in the same receipt ledger under the reserved runtime namespace. Provider callbacks, recovery scans, and process-local jobs never call pure Domain transitions outside this coordinator.

There are therefore two typed entry points over one correctness mechanism:

```text
executeHostCommand(HostCommandEnvelope)
executeRuntimeCommand(RuntimeCommandEnvelope)
              |
              v
same AuthorityStore decision transaction and receipt rules
```

The runtime union is not exported as a Host capability.

## Query contract

Queries are read-only and do not carry `requestId` or `expectedVersion`, create receipts, append journal facts, or advance Task authority.

The MVP exposes exactly:

```text
get-task(taskId)
list-tasks(status?, cursor?, limit?)
get-authority-history(taskId, afterCommittedVersion?, limit?)
```

`get-task` returns a provider-neutral serialized `TaskAggregate` view containing all seven durable entities, the authority projection, aggregate schema version, and `observedVersion`. It exposes no SQLite rows, DSH jobs/sessions, provider handles, workspace paths, or mutable telemetry.

`list-tasks` returns paginated summaries containing at least `taskId`, `status`, and `version`. `get-authority-history` returns immutable ordered authority-commit batches keyed by committed Task version; pagination resumes after a committed version rather than an unstable row offset.

Every Task-specific query result reports the version it observed. Callers use that value to form a later command, but a query does not reserve or lock the version. A subsequent conflict is expected concurrency, not a query failure.

The MVP does not expose `get-command-result(requestId)`. Exact command redelivery is the recovery mechanism; looking up a result without the original payload would bypass fingerprint verification and complicate authorization.

## Consequences for downstream decisions

- “Freeze the coding-default policy snapshot and continuation rules” must define the exact `policySnapshot` accepted by `create-task` and all internal continuations that Hosts cannot invoke directly.
- “Specify the authoritative transaction and recovery protocol” must assign stable internal request identities, journal facts, restart scans, and provider-result ingestion to `executeRuntimeCommand` without widening the Host union.
- The minimum operational projection remains fog until the recovery protocol is fixed. This query contract supplies authoritative aggregate/history reads, not yet a final human-facing explanation model for every wait and reconciliation state.
- DSH adapters may translate tool or session calls into this Host surface, but transient DSH Session or Job identity never enters command identity or Review authority.

## Explicitly rejected alternatives

- Exporting pure `AuthorityCommand` or `applyDomainCommand` to Hosts: it would let a caller bypass frozen continuation, acceptance, and effect policy.
- A generic `advance-task` command: it hides which authority is being exercised and makes request fingerprints and authorization ambiguous.
- Direct Host `create-approval`, `dispatch-operation`, `confirm-operation`, `complete-task`, or `fail-task` commands in the MVP: coding-default policy and trusted runtime evidence own those decisions.
- Omitting `expectedVersion` from reconciliation wake-up because it is normally no-write: legality is still evaluated against an exact Operation state, and deterministic conflict replay remains useful.
- Scoping `requestId` to a Host session: session replacement would destroy retry identity.
- Treating a profile name as the frozen creation policy: retry after configuration drift could silently create a Task with different semantics.
- Giving queries command receipts or implicit locks: inspection is not an authority transition and cannot reserve future authority.
