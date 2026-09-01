# qoder-agent-bridge archaeology for Tempera MVP

## Scope and source baseline

Research date: 2026-09-01. The inspected official repository snapshot is
[`lei233/qoder-agent-bridge` commit `38fa061` (v0.2.0, 2026-08-28)](https://github.com/lei233/qoder-agent-bridge/tree/38fa06106ba1cf9037691cb9a97bed614a557ff7).
Only that repository's source, tests, and authored documentation were used.

The repository describes itself as an intentionally intermediate architecture:
pure Task Core plus a file-backed Embedded Host around Qoder Runner and Git
worktree mechanics. Its own checkpoint explicitly says this is fail-closed enough
for that milestone but lacks request idempotency, expected-version concurrency,
execution fencing, an operation journal, automatic crash reconciliation, and a
durable completion sink. This limitation is authoritative context, not an
inference: see
[`docs/task-core-migration-evaluation.md` lines 184-231](https://github.com/lei233/qoder-agent-bridge/blob/38fa06106ba1cf9037691cb9a97bed614a557ff7/docs/task-core-migration-evaluation.md#L184-L231).

## Decisions Tempera should preserve

### 1. Candidate identity is a durable domain identity plus an integrity binding

The bridge Candidate binds its own ID to the producing Invocation, workspace
lineage, frozen baseline, immutable artifact locator, SHA-256, canonical changed
files, and creation time
([type](https://github.com/lei233/qoder-agent-bridge/blob/38fa06106ba1cf9037691cb9a97bed614a557ff7/packages/core/src/task/types.ts#L24-L33)).
Candidate creation is legal only after a succeeded producer, on the current
workspace lineage, and at most once per producing Invocation; the inserted value
is cloned so caller mutation cannot rewrite history
([transition](https://github.com/lei233/qoder-agent-bridge/blob/38fa06106ba1cf9037691cb9a97bed614a557ff7/packages/core/src/task/commands.ts#L158-L195),
[tests](https://github.com/lei233/qoder-agent-bridge/blob/38fa06106ba1cf9037691cb9a97bed614a557ff7/tests/task_core.test.ts#L120-L139)).

Preserve these rules in Tempera, with the more general names already established
by its architecture:

- `CandidateId` answers “which proposal?” and must remain separate from artifact
  integrity identity.
- Candidate authority commit must bind a succeeded/current producer, immutable
  `ArtifactRef` plus integrity descriptor, frozen base/precondition, and stable
  scope/target evidence.
- Historical Candidates are immutable. Rejection or repair changes the active
  authority path; it never overwrites the old Candidate.
- Executor completion is proposal evidence, not acceptance. Review and Approval
  must bind the exact Candidate independently.

The bridge's repair flow clears the active Candidate while preserving the old
record and later creates a different Candidate
([commands](https://github.com/lei233/qoder-agent-bridge/blob/38fa06106ba1cf9037691cb9a97bed614a557ff7/packages/core/src/task/commands.ts#L197-L238),
[end-to-end test](https://github.com/lei233/qoder-agent-bridge/blob/38fa06106ba1cf9037691cb9a97bed614a557ff7/tests/task_host.test.ts#L110-L149)).
Tempera should preserve the historical behavior, but model repair as its already
agreed **new Stage + new Candidate** with optional `derivedFromCandidateId`, not
as the bridge's `InvocationKind = "repair"`.

### 2. Retry and repair are different semantic continuations

The bridge permits retry only after a failed Invocation and only when no active
Candidate exists. A retry either continues the current workspace or attaches its
immediate successor; the lineage update and new running Invocation are one pure
state mutation
([command](https://github.com/lei233/qoder-agent-bridge/blob/38fa06106ba1cf9037691cb9a97bed614a557ff7/packages/core/src/task/commands.ts#L240-L304),
[invariants](https://github.com/lei233/qoder-agent-bridge/blob/38fa06106ba1cf9037691cb9a97bed614a557ff7/packages/core/src/task/invariants.ts#L156-L201)).
A failed Invocation deliberately leaves the Task open; terminal failure is a
separate policy decision
([test](https://github.com/lei233/qoder-agent-bridge/blob/38fa06106ba1cf9037691cb9a97bed614a557ff7/tests/task_core.test.ts#L225-L233)).

Reusable policy lessons:

- Retry means another realization attempt of unchanged semantic work. In
  Tempera this is the same Stage, a new Invocation, a new execution generation,
  and fencing of older completions.
- Repair means changed semantic work prompted by review. In Tempera this is a
  new Stage and, if successful, a new Candidate.
- A provider's internal transport/model retry is not a Task retry.
- No failed-run retry is automatic. Continuing partial work requires an explicit
  trust decision; restart requires an independently prepared replacement.
- A prepared replacement must be bound to Task/version, predecessor lineage and
  disclosed workspace state, then rejected if any of them changes before launch.
  The bridge demonstrates these staleness/drift checks
  ([Host](https://github.com/lei233/qoder-agent-bridge/blob/38fa06106ba1cf9037691cb9a97bed614a557ff7/packages/cli/src/task-host/host.ts#L796-L915),
  [tests](https://github.com/lei233/qoder-agent-bridge/blob/38fa06106ba1cf9037691cb9a97bed614a557ff7/tests/skill_bridge.test.ts#L138-L247)).

### 3. Exact apply needs identity, bytes, base and current-target checks

Before modifying the source, the Host requires the exact active Candidate,
review-ready workspace, matching baseline, unchanged Candidate digest, and
byte-identical current review patch
([Host preflight](https://github.com/lei233/qoder-agent-bridge/blob/38fa06106ba1cf9037691cb9a97bed614a557ff7/packages/cli/src/task-host/host.ts#L946-L981)).
The Git implementation additionally proves the reviewed patch still equals the
reviewed index, excludes non-transferable included artifacts, and runs
`git apply --check` before `git apply`; target drift returns `apply_conflict`
without changing the source
([provider mechanics](https://github.com/lei233/qoder-agent-bridge/blob/38fa06106ba1cf9037691cb9a97bed614a557ff7/packages/core/src/worktree/coordinator.ts#L379-L441),
[conflict test](https://github.com/lei233/qoder-agent-bridge/blob/38fa06106ba1cf9037691cb9a97bed614a557ff7/tests/qoder_worktree.test.ts#L558-L579)).

Tempera should generalize this into the Candidate/workspace/effect provider
contract:

1. validate effective Approval for the exact `CandidateId`;
2. verify immutable artifact integrity and its frozen base/scope/target binding;
3. verify current target preconditions immediately before dispatch;
4. dispatch under a stable `OperationId`/`effectKey`;
5. bind trustworthy confirmation evidence, or persist `indeterminate` and
   reconcile. Never reinterpret the Candidate against a new base.

The bridge correctly separates successful apply from cleanup failure: source
application can be a successful fact while worktree cleanup remains incomplete
([Host](https://github.com/lei233/qoder-agent-bridge/blob/38fa06106ba1cf9037691cb9a97bed614a557ff7/packages/cli/src/task-host/host.ts#L983-L1015),
[test](https://github.com/lei233/qoder-agent-bridge/blob/38fa06106ba1cf9037691cb9a97bed614a557ff7/tests/task_host.test.ts#L263-L287)).
Tempera should likewise keep effect outcome and resource cleanup as separate
facts.

### 4. Unknown external state must stop authority, preserve evidence, and forbid replay

The Embedded Host distinguishes enumerated safe preflight errors from unknown
post-side-effect failures. Unknown Runner, Candidate-freeze, retry-cleanup, or
apply outcomes preserve an exclusive lock and diagnostic evidence instead of
guessing that the operation failed
([Runner/commit boundary](https://github.com/lei233/qoder-agent-bridge/blob/38fa06106ba1cf9037691cb9a97bed614a557ff7/packages/cli/src/task-host/host.ts#L429-L525),
[apply boundary](https://github.com/lei233/qoder-agent-bridge/blob/38fa06106ba1cf9037691cb9a97bed614a557ff7/packages/cli/src/task-host/host.ts#L983-L1015)).
Locks are deliberately never reclaimed automatically
([lock implementation](https://github.com/lei233/qoder-agent-bridge/blob/38fa06106ba1cf9037691cb9a97bed614a557ff7/packages/cli/src/task-host/lock.ts#L19-L69)).

Preserve the principle, not the mechanism:

- classify failure boundaries by whether external side effects are provably
  absent, confirmed, or indeterminate;
- make evidence locatable and immutable before reporting a terminal result;
- reject new authority-changing work while the state is unresolved;
- permit retry only after fencing ordinary Invocation execution, or after an
  authoritative Operation is reconciled as confirmed-not-applied;
- never turn a generic exception into permission to repeat an authoritative
  effect.

### 5. Versioning and exclusive mutation are useful but insufficient

Every successful bridge Core mutation increments `Task.version` exactly once
([mutation helper](https://github.com/lei233/qoder-agent-bridge/blob/38fa06106ba1cf9037691cb9a97bed614a557ff7/packages/core/src/task/transitions.ts#L4-L10),
[test](https://github.com/lei233/qoder-agent-bridge/blob/38fa06106ba1cf9037691cb9a97bed614a557ff7/tests/task_core.test.ts#L247-L268)).
The file Host serializes mutations with `open(..., "wx")` and atomically replaces
JSON with a temporary file plus rename
([lock](https://github.com/lei233/qoder-agent-bridge/blob/38fa06106ba1cf9037691cb9a97bed614a557ff7/packages/cli/src/task-host/lock.ts#L42-L69),
[store](https://github.com/lei233/qoder-agent-bridge/blob/38fa06106ba1cf9037691cb9a97bed614a557ff7/packages/cli/src/task-host/store.ts#L173-L187)).
This prevents concurrent local mutation and torn JSON, but is not Task-level CAS
or command idempotency:

- commands accept neither caller `requestId` nor `expectedVersion`;
- IDs are generated by the Host, so a repeated request has no durable command
  identity/fingerprint/result to return;
- version is used as a prepared-retry staleness check, not as a general
  compare-and-swap API;
- the file replacement cannot atomically include external effects, immutable
  artifacts, authority journal rows, or request results;
- a stale lock blocks indefinitely and there is no multi-manager protocol.

Therefore Tempera must implement caller-supplied `requestId` with payload
fingerprinting and durable result replay, plus Task-level `expectedVersion` CAS,
in the same transaction as authoritative state and journal changes. The bridge's
lock is only evidence for the desired serialization property.

## Failure windows to carry into the conformance plan

| Boundary | Bridge behavior/evidence | Required Tempera behavior |
| --- | --- | --- |
| Task creation before workspace result is known | Remove state only when no side effect or proven cleanup; otherwise keep root, lock and diagnostic ([tests](https://github.com/lei233/qoder-agent-bridge/blob/38fa06106ba1cf9037691cb9a97bed614a557ff7/tests/task_start_lifecycle.test.ts#L55-L167)) | Write durable intent/ownership before effect; recover or reconcile without producing an unlocatable resource. |
| Invocation recorded running, crash/throw during launch or execution | Leave Invocation running and preserve lock | Persist prepared/launched identity and fence; durable completion or restart scan decides reconnect/supersede. |
| Runner completes, result artifact or Task commit fails | Preserve lock; state may still say running ([Host](https://github.com/lei233/qoder-agent-bridge/blob/38fa06106ba1cf9037691cb9a97bed614a557ff7/packages/cli/src/task-host/host.ts#L496-L524)) | Reconcile durable provider completion; accept only current generation and make proposal disposition idempotent. |
| Artifact prepared, Candidate authority commit fails | Preserve evidence/lock; possible unreferenced artifact | Allow unreferenced immutable artifact, but no half-authoritative Candidate; revalidate or GC later. |
| Prepared restart becomes stale or workspace drifts | Reject before Runner execution | Bind prepared realization to Task version/generation/scope and reject changed disclosure. |
| Target changes before apply | `apply --check` conflict, source unchanged | Conflict/fail closed before dispatch; do not reinterpret Candidate. |
| Apply may have occurred before outcome commit | Preserve lock and forbid automatic replay ([test](https://github.com/lei233/qoder-agent-bridge/blob/38fa06106ba1cf9037691cb9a97bed614a557ff7/tests/task_host.test.ts#L289-L319)) | Persist Operation as dispatched/indeterminate and reconcile with the same `OperationId`/`effectKey`. |
| Apply confirmed but cleanup fails | Applied outcome plus separate cleanup issue | Keep confirmation authoritative; cleanup is retryable maintenance, not a new apply. |

## Test techniques worth reusing

- Pure transition-table tests cover legal sequences, illegal predecessor kinds,
  immutable historical values, one active Invocation, one version increment, and
  malformed rehydrated histories
  ([Task Core tests](https://github.com/lei233/qoder-agent-bridge/blob/38fa06106ba1cf9037691cb9a97bed614a557ff7/tests/task_core.test.ts#L54-L285)).
- Dependency-injected Runner/workspace functions deterministically fail at exact
  boundaries and assert durable state, preserved locks, and evidence. There is no
  timing race in these tests.
- Temporary real Git repositories prove byte-level apply behavior, target drift,
  preserved workspaces on conflict, and corrected-candidate completeness
  ([worktree tests](https://github.com/lei233/qoder-agent-bridge/blob/38fa06106ba1cf9037691cb9a97bed614a557ff7/tests/qoder_worktree.test.ts#L558-L710)).
- Negative assertions matter as much as returned errors: source bytes remain
  unchanged after preflight failure; old Candidate bytes remain unchanged after
  repair; ambiguous state rejects the next mutation; cleanup failure does not
  erase a confirmed outcome.

For Tempera, retain those layers but add transactional fault injection before
and after every journal/state/request-result write, stale/duplicate completion
delivery, competing `expectedVersion` commands, manager process restart, and
effect reconciliation. The bridge does not test those guarantees because it
does not implement them.

## Interfaces and semantics that must not carry into Tempera Core

- Qoder names and payloads: `qodercli`, prompt-file transport, `RunnerEnvelope`,
  `qoderOutput`, model queue errors, timeout/retry environment variables, and
  process-group mechanics.
- Codex Skill mechanics: terminal command orchestration, same-session waiting
  constants, correction-count UX, and the Skill's external-transfer approval
  script. These may inspire adapters/policy, never Domain state.
- Worktree plumbing: absolute `statePath`, `workspace.cwd`, `retryOf`, worktree
  phase, Git index flags, `baselineTree` as a universal type, patch file paths,
  `.qoderinclude`, and binary-patch staging. These belong behind provider-neutral
  artifact/workspace contracts.
- The bridge's persisted `operability = blocked`. Tempera has already decided
  that blocked/waiting are projections over durable facts.
- The bridge's single ordered Invocation/worktree chain and `repair` Invocation
  kind. Tempera's Domain may represent Candidate branching while coding-default
  policy permits one active branch; repair is a new Stage.
- Direct `apply -> Task.closed/applied`. Tempera apply is an authoritative
  `Operation`; Task completion is a separate policy evaluation after confirmed
  effect evidence.
- File-backed `task.json`, stale-lock manual deletion, host-generated command
  IDs, and low-level diagnostic CLIs. None is a durable concurrency/recovery API.
- Host session identity as reviewer/approval authority. Tempera persists frozen
  authority requirements and actor provenance; sessions are transport context.

## Implications for downstream tickets

- **Freeze the implementable Task Domain v1 schema:** include distinct Candidate
  identity/integrity/base bindings, immutable history, current-generation
  Invocation outcome rules, retry versus repair semantics, and Operation
  indeterminate state. Do not include Qoder, Git path, worktree phase, or persisted
  blocked fields.
- **Fix the MVP host command and query contract:** every authority-changing
  command needs caller `requestId`, payload fingerprinting, `expectedVersion`, and
  replayable durable result; do not mistake generated entity IDs for request
  identity.
- **Define the exact Candidate workspace and effect contract:** require opaque
  artifact/base/target descriptors, exact-candidate verification, stable effect
  identity, preflight, confirmation, reconciliation, and separate cleanup facts.
- **Specify the authoritative transaction and recovery protocol:** explicitly
  close every failure window in the table with write-ahead records, fencing,
  restart scans and legal reconciliation actions; a preserved stale lock is not
  a recovery protocol.
- **Design the durability conformance harness:** combine pure model sequences,
  deterministic boundary faults, transaction races/restarts, fake-provider
  completion controls, and real Git end-to-end conflict/apply tests.

## Remaining uncertainties

- The exact generic shape of `ArtifactRef`, integrity descriptor, base/precondition
  and confirmation evidence depends on the DSH capability audit and the later
  Candidate workspace/effect contract.
- The exact Invocation generation/fence and Operation journal schemas belong to
  the transaction/recovery protocol ticket; this archaeology only establishes
  the required behaviors.
- The bridge demonstrates one Git patch provider, not that byte-for-byte patch
  equality is the only valid integrity proof. Tempera should require provider
  verification of an immutable descriptor, with Git bytes/digest as its first
  implementation.
