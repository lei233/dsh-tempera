# Authoritative transaction and recovery protocol decision

## Verdict

Freeze one single-manager, snapshot-driven protocol in which every provider call
that could matter after a crash is preceded by a durable grant, every durable
mutation is idempotently coordinated, and restart derives work from current
validated state rather than replaying the authority journal or trusting a
process-local queue.

The protocol has two clocks:

```text
Task.version
  = Task authority serialization and Host CAS

snapshotRevision
  = store-local serialization of every durable aggregate mutation
```

Authority commands advance both clocks and atomically bind the next aggregate
snapshot, one ordered authority-journal commit, and the exact command receipt.
Execution-observation commands advance only `snapshotRevision` and atomically
bind the next snapshot with their exact receipt. They do not append authority
facts or silently obtain authority.

The human validated this model without changes using the logic prototype on
branch `codex/prototype-transaction-recovery-protocol` at commit `e05169c` in
`packages/runtime/prototypes/transaction-recovery-protocol.html`.

## Durable store records

The previously selected three logical store responsibilities remain sufficient;
this decision sharpens their contents rather than adding a durable work queue.

### Current Task snapshot

Each snapshot row contains:

```text
taskId
Task.version
snapshotRevision
Task status
aggregateSchemaVersion
validated TaskAggregate JSON
```

`snapshotRevision` is persistence/runtime coordination metadata, not an eighth
Domain entity and not a Host concurrency token. It increases by exactly one for
every transaction that changes the aggregate snapshot, including Invocation
launch/result observations that do not change authority.

The current authority projection adds one policy-required fact:

```ts
interface AuthorityProjection {
  readonly ineffectiveApprovalIds: readonly ApprovalId[];
  readonly operationDispatchCounts: Readonly<
    Record<OperationId, 0 | 1 | 2>
  >;
}
```

Invocation attempt counts and repair counts remain derivable from immutable
Invocations and Stages. Dispatch count is explicit because redispatch reuses the
same Operation and the coding-default budget must be enforceable from current
state without replaying history. No `OperationAttempt` entity is introduced.

### Authority journal commit

Exactly one immutable journal commit exists for every new `Task.version`. It
records `previousVersion`, `committedVersion`, runtime or Host command identity,
and an ordered batch of semantic facts. The closed MVP fact families are:

```text
Task created / completed / failed / cancelled
Stage materialized / completed / failed / cancelled
Invocation prepared and Stage generation advanced
current-generation proposal accepted or authoritatively rejected
external Review submitted
Approval created / invalidated
Operation prepared / dispatch granted / made indeterminate
Operation proved not-applied / confirmed / aborted
```

One command may emit several ordered facts. For example, accepting a proposal
records Candidate creation, proposal acceptance, and Stage completion in one
commit. Approval invalidation before dispatch records invalidation, Operation
abort, effect Stage failure, and Task failure in one commit under coding-default
v1. Exact serialized fact names are mechanical, but their grouping and order are
part of the protocol.

Pure execution observations such as `Invocation launched` and a provider's
terminal Invocation result live in the current snapshot and receipt ledger, not
the authority journal. A stale result that cannot affect current authority is
also an observation. A current-generation invalid or integrity-rejected proposal
is different: its terminal disposition consumes policy budget, so that decision
is authoritative and journalled.

### Command receipt

Every committed authority or observation command receives a durable receipt
containing:

```text
request identity
canonical payload fingerprint
command class: host | runtime-authority | runtime-observation
exact deterministic result
resulting Task.version, when a Task exists
resulting snapshotRevision, when a snapshot changed
```

Same identity plus the same fingerprint returns the exact durable result. Same
identity plus a different fingerprint is a hard mismatch. A rolled-back
transaction or process death before a deterministic commit creates no receipt.

## Transaction coordinator

All Host and runtime commands pass through one `AuthorityStore` coordinator on
the exclusively owned SQLite connection. No provider callback, recovery scan,
policy evaluator, or process-local worker calls a Domain transition directly.

### Authority transaction

```text
begin immediate transaction
  replay or reject request-id reuse from receipt ledger
  load and strictly validate current snapshot
  check Host expectedVersion or runtime captured authority version
  run synchronous, deterministic, I/O-free Domain/policy decision
  require next Task.version = previous Task.version + 1
  require next snapshotRevision = previous snapshotRevision + 1
  replace current snapshot
  append exactly one ordered authority journal commit
  store exact receipt
commit
```

All identifiers, immutable descriptors, artifact-verification results, and
provider evidence required by the decision are prepared before the transaction.
The transaction never calls a provider, filesystem, Git, clock, logger, hash
service, or artifact store.

### Observation transaction

```text
begin immediate transaction
  replay or reject request-id reuse from receipt ledger
  load and strictly validate current snapshot
  validate exact entity identity, legal current state, and generation/effect fence
  run synchronous, deterministic, I/O-free observation transition
  keep Task.version unchanged
  require next snapshotRevision = previous snapshotRevision + 1
  replace current snapshot
  store exact receipt
commit
```

Observation conflicts do not overwrite authority. A late Invocation result may
be stored as stale historical evidence or deterministically rejected, but cannot
complete a Stage after its generation was fenced or the Task became terminal.

## Stable runtime request identities

Runtime authority request identities use a canonical versioned tuple:

```text
(
  "tempera.runtime-command.v1",
  action,
  taskId,
  semantic identity,
  captured Task.version
)
```

Including the captured authority version prevents a durable version-conflict
receipt from poisoning a later legal retry after authority advances. Domain
uniqueness still prevents duplicates when a fresh-version retry discovers that
the semantic result already exists.

The semantic identities are fixed as follows:

| Runtime authority action | Semantic identity |
| --- | --- |
| materialize Stage | exact `materializationKey` |
| prepare Invocation | `(stageId, nextGeneration)`; Invocation id and `launchKey` are stable inputs |
| decide proposal | `(invocationId, proposal integrity identity, proposed outcome identity)` |
| create Approval | `(policyIdentity, candidateId, preliminaryReviewId, hostReviewId)` |
| invalidate Approval | `(approvalId, invalidation reason identity)` |
| prepare Operation | exact `effectKey` |
| grant dispatch | `(operationId, nextDispatchOrdinal)` |
| record/reconcile effect result | `(operationId, dispatchOrdinal, resolution kind, evidence identity)` |
| complete/fail Task | exact terminal descriptor identity and triggering entity refs |

Runtime observation identities do not include `Task.version`; exact redelivery
must replay even if unrelated authority advanced. Their semantic identities are:

```text
mark Invocation launched: invocationId
record Invocation result: invocationId + immutable provider delivery/result identity
record stale duplicate: invocationId + immutable provider delivery/result identity
```

The Host keeps its already-frozen caller-supplied manager-wide `requestId`. Host
and runtime identities share the receipt ledger but occupy disjoint namespaces;
the `tempera:` prefix remains reserved for runtime identities.

## Invocation launch and fencing protocol

Invocation execution follows this exact order:

1. The policy evaluator derives the next legal generation and stable Invocation
   inputs from the current snapshot.
2. One authority transaction creates the `prepared` Invocation, advances
   `Stage.currentExecutionGeneration`, journals both facts, and commits a receipt.
3. One observation transaction changes that exact Invocation from `prepared` to
   `launched` and commits its receipt.
4. Only after step 3 commits may runtime call `provider.start(launchKey, binding)`.
5. Provider terminal delivery is normalized, immutable artifacts are prepared
   and verified outside SQLite, then one observation transaction records
   `succeeded + unresolved proposal`, `failed`, `indeterminate`, or `cancelled`.
6. Continuation is evaluated from the newly durable snapshot.

The `launched` transition is a write-ahead provider grant, not proof that the
provider received the call. A crash after it commits therefore creates launch
ambiguity even if the process died just before the call.

Recovery handles a `launched` Invocation by capability:

- an idempotent-start provider may receive the same `launchKey` again;
- a reconnectable/queryable provider is queried or reattached by `launchKey`;
- a provider that cannot disambiguate is never blindly restarted: the current
  generation becomes indeterminate and policy may atomically fence it by
  preparing the next generation if budget remains.

Provider cancellation is best effort. Generation fencing, not process
termination, prevents a delayed old result from acquiring authority.

## Durable proposal protocol

Executor completion never creates Candidate, Review, or Stage completion
directly. A successful Invocation first records exactly one immutable proposal
binding with `proposalDisposition = unresolved`.

The proposal decision then:

1. verifies the immutable artifact and normalizes the proposed outcome outside
   the transaction;
2. captures the current Task authority version and constructs the stable proposal
   request identity;
3. reloads the exact snapshot in the authority transaction;
4. checks Task status, current Stage generation, proposal identity, outcome shape,
   integrity, scope, and frozen semantic inputs;
5. either atomically creates the authoritative Candidate or Review, completes the
   Stage, marks the proposal accepted, and journals the ordered facts; or records
   the exact terminal rejection required by fencing/policy.

If immutable artifact preparation succeeds but the authority transaction does
not commit, only an unreferenced artifact exists. If proposal delivery or the
acceptance transaction is interrupted, restart scanning finds the same unresolved
proposal and revalidates it. It never assumes executor success obtained authority.

## Policy continuation protocol

Continuation has no durable queue identity of its own. After every committed
Host command, runtime authority command, runtime observation, and startup scan,
the runtime evaluates the closed coding-default interpreter to a fixed point.

Each proposed authority action carries its stable semantic key and captured
Task version through the coordinator. Materialization uniqueness, exact Review
refs, Approval identity, effect identity, and terminal descriptors make repeated
evaluation convergent. A crash between two legal continuation commits merely
leaves a current snapshot from which the next action is derived again.

In particular:

- the two evaluation Stages may complete in either order, but Approval evaluation
  runs only when both exact Reviews are durable;
- current-generation failure/indeterminate observations cause a new Invocation
  authority command only when the frozen budget permits it;
- materialization, retry generation, Approval, Operation preparation, and Task
  completion are separate idempotent authority commits;
- an already-materialized exact semantic result is returned rather than
  multiplied after a fresh-version retry.

## Operation dispatch and reconciliation protocol

Operation execution uses a stricter write-ahead boundary:

1. One authority transaction creates the exact `prepared` Operation and
   `effectKey` before any external effect machinery receives authority.
2. Runtime prepares and verifies Candidate integrity, target scope, frozen
   precondition, current target condition, Approval effectiveness, and provider
   capability outside SQLite.
3. One authority transaction reloads current state, repeats every pure identity,
   authority, scope, precondition-attestation, uniqueness, and budget check,
   changes the same Operation to `dispatched`, increments its durable dispatch
   count, journals the dispatch grant, and stores the receipt.
4. Only a first-observation successful commit of step 3 may call
   `provider.dispatch(effectKey, exactIntent)`. Receipt replay never calls the
   provider again.
5. A trustworthy provider result is normalized and committed through the same
   Operation-resolution transition used by restart reconciliation.

The dispatch budget is consumed at step 3, before the provider call. A crash
between steps 3 and 4 may therefore consume a slot even if no effect occurred.
This is the deliberate fail-closed cost of never treating missing local evidence
as permission to dispatch.

After any crash or ambiguous provider return, both `dispatched` and
`indeterminate` mean only one legal external action:

```text
provider.reconcile(same effectKey, same exact intent)
```

Resolution is authoritative and uses the same Operation:

- `confirmed` stores immutable evidence, makes the Operation confirmed, and—if
  the Task is still active—completes the effect Stage in the same transaction;
- `not-applied` stores immutable evidence and returns the same Operation to
  `prepared` only when the existing dispatch count is below two;
- `unknown` leaves or moves the Operation to `indeterminate` and schedules no
  dispatch;
- a second proved-not-applied result exhausts the coding-default dispatch budget
  and fails closed;
- a new Operation is legal only for genuinely changed authoritative intent, not
  as a retry of unchanged intent.

Task completion remains a separate stable policy command after an active effect
Stage completes from confirmation. A crash between confirmation and completion
is repaired by fixed-point continuation scanning.

## Approval invalidation and cancellation

Approval invalidation and cancellation evaluate the Operation's side of the
durable dispatch boundary inside their authority transaction.

### Approval invalidation

- If the Operation is `prepared`, the same commit makes the Approval ineffective,
  aborts the Operation, fails the effect Stage, and fails the Task under
  coding-default v1.
- If it is `dispatched` or `indeterminate`, the same commit only makes Approval
  ineffective. The Operation remains subject to reconciliation.
- A later confirmed result may complete the active effect Stage and Task because
  the Approval was effective when dispatch authority was granted.
- A later not-applied result cannot redispatch without a currently effective
  Approval; the Operation aborts/fails closed instead.

### Task cancellation

The Host cancellation transaction terminally cancels the Task, cancels pending
or active Stages, advances/fences current Invocation generations, prevents new
materialization and proposal authority, aborts every still-`prepared` Operation,
and records all ordered facts in one authority commit.

After commit, runtime best-effort cancels live Invocation providers outside the
transaction. A `dispatched` or `indeterminate` Operation is not aborted. Restart
continues to reconcile it because cancellation is not evidence about the target.

Reconciliation may update that existing Operation to `confirmed` after Task
cancellation so durable state tells the truth about the external effect. It does
not reopen the Task, complete the cancelled effect Stage, create new authority,
or change the Task's terminal status.

## Startup and steady-state scans

Startup obtains exclusive database ownership, runs database/aggregate migrations,
strictly validates every non-pruned snapshot, and fails closed before any provider
work if validation fails. It then derives idempotent obligations from current
snapshots in this safety order:

1. `dispatched` or `indeterminate` Operations → reconcile only;
2. `prepared` Operations → abort if authority disappeared, otherwise re-verify
   and consider a dispatch grant;
3. `succeeded + unresolved` Invocation proposals → re-verify and decide;
4. `launched` Invocations → reconnect/query/idempotent redelivery, or fence when
   capability cannot disambiguate and policy permits retry;
5. `prepared` Invocations → commit launch grant, then start provider;
6. active Stage/policy states → derive missing retry, Review aggregation,
   Approval, Operation, failure, or completion authority commands.

The scan runs to a stable fixed point per Task and may schedule provider I/O
concurrently across Tasks, but every resulting mutation re-enters the coordinator.
Duplicate in-memory scheduling is harmless; durable identities, receipts, Domain
invariants, and Task CAS are the correctness mechanisms. Process-local queues,
timers, DSH Jobs, sessions, and telemetry are never the source of recovery truth.

Terminal Tasks are normally skipped after validation, except that their existing
`dispatched` or `indeterminate` Operations remain first-class reconciliation
obligations.

## Required crash-window behavior

| Crash or race | Durable state | Only legal continuation |
| --- | --- | --- |
| command response lost after commit | receipt + committed snapshot | replay exact durable result |
| transaction rolls back before receipt | unchanged store | retry exact request |
| authority version changes before runtime commit | current snapshot + conflict receipt | derive a fresh-version request identity and re-evaluate |
| Invocation prepared before launch grant | `prepared` Invocation | commit launch grant, then start |
| launch grant commits before provider call | `launched` Invocation | reconnect/query/idempotent same-key start, otherwise fence |
| provider finishes before result commit | provider delivery/artifact may exist | redeliver exact observation; never infer authority |
| result commits before proposal decision | unresolved proposal | re-verify and replay proposal decision |
| late old-generation proposal | current generation + old evidence | retain/reject as stale; never complete Stage |
| artifact upload succeeds before failed authority commit | unreferenced immutable artifact | revalidate on redelivery or garbage-collect |
| Operation prepared before dispatch grant | `prepared` Operation | revalidate authority/preconditions, then grant or abort |
| dispatch grant commits before provider call | `dispatched`, count consumed | reconcile same effectKey; never call dispatch directly |
| provider applies before local result commit | `dispatched` or `indeterminate` | reconcile to immutable confirmation |
| reconciliation proves not-applied | same Operation, count retained | return to prepared only if budget/Approval permit |
| Approval invalidates before dispatch | ineffective Approval + prepared Operation | atomically abort/fail closed |
| Approval invalidates after dispatch | ineffective Approval + crossed Operation | continue reconciliation |
| Task cancels after dispatch | cancelled Task + crossed Operation | reconcile Operation; never reopen Task |
| reconciliation remains unknown | indeterminate Operation | remain unresolved and scan again later |

## Consequences for downstream decisions

- “Design the durability conformance harness” now has exact transaction fault
  points, durable before/after states, and legal recovery oracles to exercise.
- “Define the exact Candidate workspace and effect contract” must supply the
  immutable proposal, precondition, dispatch, not-applied, confirmation, and
  unknown evidence required here while preserving `launchKey` and `effectKey`
  semantics.
- “Define the minimum operational projection and inspection surface” can now
  derive provider-neutral waiting and recovery reasons from the exact current
  states, receipts, authority facts, and scan obligations fixed here.
- “Order and gate the MVP vertical slices” must introduce every provider call
  only after its corresponding durable grant and must gate the effect slice on
  reconciliation of the grant-before-call crash window.

## Explicitly rejected alternatives

- Advancing `Task.version` for provider observations: it would turn execution
  telemetry into authority CAS churn and pollute the authority journal.
- Omitting `snapshotRevision`: observation-only snapshot changes would have no
  local serialization/inspection identity.
- A durable generic work queue or outbox as recovery truth: current semantic
  states already encode every obligation; an extra queue can drift and is not
  needed for correctness in the single-manager MVP.
- Calling a provider before persisting `launched` or `dispatched`: a crash could
  leave an external action with no durable grant or stable recovery identity.
- Treating a grant-before-call crash as proof of not-applied: process death cannot
  establish whether the external boundary was crossed.
- Retrying an indeterminate effect with a new Operation or effect key: unknown
  external state is not permission to repeat authoritative mutation.
- Replaying the complete journal to rebuild recovery state: the validated current
  snapshot is authoritative; the journal explains decisions and supports audit.
- Refusing to reconcile after cancellation: terminal authority revocation cannot
  erase or falsify an effect that may already have occurred.
