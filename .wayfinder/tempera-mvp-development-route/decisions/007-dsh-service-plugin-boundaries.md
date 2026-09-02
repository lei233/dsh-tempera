# DSH-native service and plugin boundaries decision

## Verdict

Tempera is composed into DSH as one Cordis application service, logically
available as `ctx.tempera`, over four independent provider-neutral capability
families:

```text
DSH tools / Host adapters
            |
            v
       ctx.tempera
  Host commands + queries only
            |
            v
Tempera manager / coordinator / AuthorityStore
            |
            +------------------+------------------+------------------+
            v                  v                  v                  v
     Realizer registry   Artifact registry  Workspace/Candidate  Effect registry
            |                  registry             registry             |
            v                     |                    |                  v
   DSH subagent adapter           +---------- concrete plugins ----------+
```

The application service owns Task Manager process coordination, but it does not
make Cordis, a DSH provider, a Session, a Job, or a plugin lifecycle into durable
Task authority. All Domain decisions, continuation, proposal acceptance,
Approval, dispatch authority, reconciliation, and completion remain inside the
Tempera manager and re-enter the frozen runtime-command and `AuthorityStore`
protocol.

The four capability families are separate strong contracts. A concrete plugin
may implement several of them, but it registers each capability independently.
There is no generic capability bus and no provider-facing escape hatch into
Domain transitions or the authority store.

## Application service boundary

The DSH-facing application service exposes exactly the already-frozen Host
surface:

```text
commands
  create-task
  submit-external-review
  cancel-task
  request-operation-reconciliation

queries
  get-task
  list-tasks
  get-authority-history
```

DSH tools, Sessions, or other Host adapters may normalize an authenticated
caller and translate delivery into this surface. They receive no public method
for runtime authority commands, direct Domain transitions, continuation,
provider registration, SQLite access, dispatch, confirmation, or Task
completion. A transient DSH Session, Job, connection, or tool-call identity does
not become a Host request identity or Review authority.

The manager behind this service owns:

- startup validation, exclusive authority-store ownership, and recovery scans;
- fixed-point coding-default continuation;
- stable runtime-command construction and receipt handling;
- orchestration of provider I/O outside SQLite transactions;
- normalized provider observation ingress;
- ordered process shutdown; and
- the only calls into the authority transaction coordinator.

Exact TypeScript class and method spellings remain mechanical. The single
application-service boundary and its authority exclusions are frozen.

## Dependency and package direction

The logical dependency direction is:

```text
@dsh-tempera/domain
        ^
        |
provider-neutral runtime ports and manager/coordinator
        ^
        |
Tempera DSH/Cordis adapter and service-definition layer
        ^
        |
concrete DSH-native provider plugins
```

Rules are:

- Domain remains independent of DSH, Cordis, providers, Node.js, Git,
  workspaces, sandboxes, and concrete artifact storage.
- Provider-neutral runtime contracts contain only Tempera data and closed
  normalized outcomes. They expose no DSH `Context`, provider, run, Session,
  Job, disposer, or error types.
- The DSH adapter translates documented public DSH/Cordis APIs into those
  contracts. It does not implement Task semantics.
- Concrete provider plugins depend on the capability service definitions and
  the documented DSH packages they actually use. They do not import runtime
  internals or the `AuthorityStore` adapter.
- Compatibility fixtures consume the built public package exports as external
  consumers. They do not use monorepo path privileges or source/deep imports.

The exact physical package names, directories, export maps, and whether adjacent
service definitions share a package remain owned by the later repository/package
layout decision. That decision may combine packaging for convenience but may not
reverse these logical dependencies or merge the four capability contracts.

## Initial DSH dependency inventory

The first DSH-facing layer consumes only:

| Package | Exact version | Public surface used |
| --- | --- | --- |
| `@deepseek-ai/cordis` | `4.0.2` | Service, plugin, required injection, reversible effect, and disposer lifecycle |
| `@deepseek-ai/dsh-subagent` | `0.1.2-alpha.3` | named provider registry, capability inspection/rejection, one-shot start/run/dispose, and registration lifecycle |

These are the first direct entries for
`compatibility/dsh/baseline.json`. Only public npm exports shipped in the
tarballs are admissible. A manifest entry that names `./src/*` is not sufficient
because the frozen DSH packages do not publish their source trees.

The MVP adapter does not initially import DSH Jobs, workspace, sandbox, storage,
continuable-subagent control, subagent tool packages, or a concrete subagent
provider package. In particular:

- `ctx.jobs` may later mirror live telemetry, but it is not an Invocation store
  or recovery source;
- `ctx.workspaceRegistry` groups canonical directories and Sessions, but is not
  the Candidate/workspace contract;
- `ctx.sandbox` covers a documented filesystem-confinement seam only when a
  chosen provider actually uses it;
- DSH storage and `storageDomain` are not the authority store; and
- DSH continuable child Sessions are not Tempera Stage continuation.

Importing any of those public seams later requires a named compatibility profile
before the import merges. Provider selection may add one exact concrete provider
package and its conformance profile; this decision does not preselect it.

## Realizer registry and resolver profile

A Stage freezes a provider-neutral realization requirement. That requirement
references a versioned **resolver profile identity** compiled into the frozen
Task policy. The profile fixes:

- the semantic capability constraints for the Stage role;
- the admissible adapter/provider binding set or rules;
- deterministic selection and tie-breaking;
- required route, model, output, sandbox, workspace, and recovery properties;
- which substitutions are authorized for a later Invocation generation; and
- the configuration identity whose meaning was accepted at Task creation.

The registry never uses registration order or “first match wins.” Preparing an
Invocation resolves exactly once against its frozen resolver profile and stores
the resulting `realizer-binding` descriptor with that Invocation. The same
Invocation is never rebound or silently failed over.

A later retry is a new Invocation and may select a different binding only when
that alternative was authorized by the frozen resolver profile. A provider that
appears after Task creation is not eligible merely because it satisfies the same
runtime predicate. Changing the admissible set requires changed Task intent,
policy migration, or another explicitly authorized future mechanism; hot reload
alone cannot change active Task meaning.

## Frozen RealizerBinding

The provider-neutral binding records enough stable provenance to reproduce and
explain the launch authorization, including at least:

```text
binding contract version and identity
resolver profile identity
Tempera adapter identity and contract version
DSH release/baseline identity
DSH provider name
provider implementation identity
provider configuration identity/digest
requested and effective capability set
normalized route/model/output configuration
declared recovery capability
declared sandbox/workspace capability identities when required
```

Provider implementation and configuration identity are adapter-supplied because
the generic DSH subagent descriptor does not standardize either one. If an
adapter cannot supply the provenance required by the resolver profile, it cannot
produce an admissible binding.

Run id, child Session id, process id, live Job id, provider handle, mutable
workspace path, trace id, and timestamps observed after launch are execution
observations. They do not alter the frozen binding and do not enter Task policy
semantics.

## Realizer execution contract

The logical realizer surface is narrow:

```text
resolve(requirement, resolverProfile) -> frozen RealizerBinding
start(launchKey, binding, input) -> accepted run observation
recover/query/reattach(launchKey, binding) -> normalized observation, when declared
cancel(launchKey, binding) -> best-effort observation
```

Exact method grouping is mechanical, but the responsibilities are not. The
binding declares one closed recovery capability such as:

```text
none
idempotent-start
queryable
reconnectable
```

An adapter may declare a narrower future refinement, but it cannot claim a
stronger behavior than its real provider profile proves. Runtime calls `start`
only after the durable Invocation launch grant commits. It repeats the same
`launchKey` only when the frozen binding proves idempotent start. It queries or
reattaches only when that behavior is declared. With `none`, launch ambiguity is
not permission to start again; the recovery protocol fences or leaves the
Invocation indeterminate according to frozen policy.

Cancellation is always best effort. Completion authority comes from generation
fencing and a later proposal decision, never from successful process
termination or provider disposal.

## DSH one-shot adapter boundary

The initial generic DSH adapter uses the root public
`@deepseek-ai/dsh-subagent` registry and its one-shot provider contract. Its
compatibility surface is limited to provider registration/inspection,
capability validation, `start`, the returned run identity and result, and
idempotent `dispose`/quiescence.

It does not consume `startContinuable`, follow-up, interrupt, reporting,
continuable child enumeration, or the DSH subagent tool/control packages. A DSH
continuable child Session has its own inbox and activation lifecycle; it does not
become a durable Tempera Invocation, Stage continuation, recovery queue, or
authority record.

If a future golden-path provider genuinely requires a continuable or control
surface, that change needs a new scoped compatibility profile and an explicit
semantic review. It cannot be smuggled into the one-shot profile.

## Observation and proposal delivery

DSH and provider-specific results are normalized before entering runtime. The
closed application-level classification is:

| Observation | Meaning |
| --- | --- |
| `unavailable` | the required registered implementation is temporarily absent before a provider call; the Task waits and no speculative attempt is consumed |
| `rejected` | the selected implementation deterministically cannot honor the frozen binding or request; this is a fail-closed terminal observation for that Invocation |
| `succeeded` | provider work returned a proposed result; it grants no Task authority |
| `failed` | provider work terminated with a known failure |
| `cancelled` | provider work reported cancellation/controlled termination |
| `indeterminate` | whether or how provider work completed cannot be established |

Raw DSH stop reasons, thrown errors, remote payloads, and provider objects are
diagnostic inputs to this normalization; they are not durable Domain unions.
The distinction between unavailable, rejected, failed, cancelled, and
indeterminate must not be collapsed.

Every accepted provider delivery receives an immutable delivery identity. Exact
redelivery for the same Invocation and delivery identity replays the same
runtime observation receipt. A different delivery for a fenced or terminal
Invocation remains non-authoritative evidence and cannot overwrite the first
accepted disposition.

A `succeeded` provider result is not submitted directly to the authority store.
The manager first asks the artifact capability to take immutable custody or bind
the exact payload, verifies the returned binding outside SQLite, and only then
constructs the stable runtime observation/authority inputs. The resulting
`ArtifactBinding` is still only an unresolved proposal until the fenced proposal
decision commits Candidate or Review authority.

## Artifact capability boundary

The artifact family supplies two semantic responsibilities:

```text
take immutable custody or bind exact content -> ArtifactBinding
verify(ArtifactBinding) -> verified attestation | mismatch | unavailable
```

An implementation returns `ref + integrity` only after it owns or can prove the
immutable content named by the binding. `verify` checks the complete integrity
identity and any declared media/schema identity; locator readability alone is
not verification. A mutable path, DSH Spill locator, Session log, or provider
handle is not an admissible trust-chain binding without an implementation that
adds the required immutable custody and verification semantics.

Verification is I/O and occurs outside the authority transaction. The manager
freezes the verified result used by the pure decision and revalidates identities
inside the transaction. A mismatch fails closed. Temporary provider absence is
`unavailable`, never an assumed match.

Artifacts referenced by durable Task state, authority history, Reviews,
Candidates, proposals, or Operation evidence are not deleted during the MVP
lifetime of that authority database. Unreferenced content created before a
rolled-back or rejected commit may be garbage-collected under an implementation
policy that cannot invalidate referenced bindings.

## Workspace/Candidate capability boundary

The Workspace/Candidate family owns only provider machinery needed to:

- prepare or resolve an isolated realization area under an allowed ScopeRef;
- materialize the exact immutable Candidate representation;
- supply the artifact binding and base/precondition observations needed by the
  later authority decision;
- verify provider-side workspace facts requested by the manager; and
- clean up non-authoritative workspace resources without deleting durable
  trust-chain artifacts.

It does not accept a Candidate, create a Review or Approval, dispatch an
Operation, apply an authoritative effect, or complete a Task. It may internally
use Git, worktrees, filesystem snapshots, remote workspaces, or DSH workspace
identity, but none of those types enters Task Core.

The exact Candidate artifact, digest, frozen base/precondition, target-drift,
lease, cleanup, and first Git/worktree implementation contracts remain owned by
“Define the exact Candidate workspace and effect contract.”

## Effect capability boundary

The Effect family consumes an exact provider-neutral intent only after the
manager has committed the durable dispatch grant. Its minimum surface is:

```text
dispatch(effectKey, exactIntent)
reconcile(effectKey, sameExactIntent)
```

It normalizes only trustworthy `confirmed`, `not-applied`, or `unknown`
observations with immutable evidence where required. It does not decide whether
the Approval is effective, whether Candidate identity or scope matches, whether
the precondition is legal, whether dispatch budget remains, or whether a Task
may complete.

The same plugin may implement Workspace/Candidate preparation and Candidate
apply, but apply is registered and invoked through the Effect contract, never a
workspace convenience method. A generic arbitrary-command or action-string
provider is not an admissible replacement for the exact-intent effect seam.

The concrete intent, precondition, confirmation, not-applied, unknown, target,
and reconciliation evidence schemas remain owned by “Define the exact Candidate
workspace and effect contract.”

## Registration, removal, and hot reload

Each capability registration has a stable provider key plus contract,
implementation, configuration, and capability identities. An active duplicate
key with a different identity fails loudly; registration order and last-writer
wins are forbidden selection mechanisms.

Registration is a reversible Cordis effect. Disposing it immediately prevents
new resolutions. It does not revoke an already accepted provider run, rewrite an
Invocation, reinterpret an artifact binding, change an Operation, or grant a
replacement implementation authority over an existing binding.

An existing binding can be served after reload only by a registration that
proves the exact identities and contract required by that binding. Otherwise the
capability is unavailable. Runtime then follows the already-frozen recovery and
policy protocol: it waits, queries an admissible provider, or records an
indeterminate/rejected result as appropriate. It never silently substitutes a
different implementation for the same Invocation or Operation.

The manager uses required Cordis injection for the stable application-level
registry services and other correctness-critical process services. Individual
providers are dynamic registrations, not required injections of the entire Task
Manager. A missing provider makes only the affected work unavailable; it does
not dispose durable Task management or turn provider absence into Task failure.

## Ordered startup and shutdown

Cordis coordinates service availability, but one manager-owned lifecycle effect
controls correctness-sensitive order. Startup opens and validates the exclusive
authority store before recovery or provider work and activates recovery only
after the required registry services are ready.

Shutdown proceeds in this order:

1. stop accepting new Host work and stop deriving new continuation work;
2. stop granting or issuing new provider launches and effect dispatches;
3. while the authority store remains open, best-effort cancel/drain live
   realizers and commit any already-arrived normalized observations;
4. dispose capability registrations, provider resources, observers, artifact
   and workspace resources in their owned order; and
5. close the authority store last.

DSH providers may perform their own idempotent cleanup, but concurrent Cordis
disposers are not relied on to establish this global ordering. A timeout or
provider that cannot quiesce does not invent completion; durable grants and
restart recovery remain the truth.

## Compatibility profiles

The initial baseline manifest registers exactly these framework profiles:

### `dsh-cordis-composition.v1`

This profile compiles and behavior-tests the documented public Cordis service
and plugin shape relied upon by `ctx.tempera` and the four registries. It covers:

- required injection pending, activation, disposal, and reload;
- reversible registration effects and duplicate cleanup;
- dependent teardown without treating it as durable Task cancellation; and
- the manager-owned disposer preserving its ordered shutdown contract.

### `dsh-subagent-realizer.v1`

This profile compiles and behavior-tests the public root
`@deepseek-ai/dsh-subagent` one-shot surface. It covers:

- named provider registration, inspection, and removal;
- capability rejection before provider start;
- accepted run identity, result, cancellation, disposal, and quiescence;
- provider removal blocking new starts without rewriting an accepted run;
- normalization into unavailable, rejected, succeeded, failed, cancelled, and
  indeterminate observations;
- immutable proposal preparation before runtime ingress;
- duplicate and late delivery fencing; and
- proof that provider success cannot directly create Candidate, Review,
  Approval, Operation, Stage completion, or Task completion authority.

These profiles run with the exact frozen public npm artifacts and external
consumer fixtures required by the DSH compatibility-baseline decision. They do
not certify a real golden-path provider. Selecting that provider creates a named
provider-specific profile and may add one exact provider package.

Artifact, Workspace/Candidate, and Effect implementations begin as Tempera
conformance contracts. They become DSH compatibility profiles only if their
implementation imports another DSH public seam. Potential Jobs, workspace,
sandbox, storage, or continuable-subagent use is untested and incompatible until
such a profile exists.

## Extension ownership

The service definitions, DSH adapter, and concrete capability providers are
Tempera-oriented, out-of-tree DSH-native extensions for the MVP. DSH-native means
they obey documented Cordis/DSH composition, public exports, lifecycle, and
compatibility contracts. It does not mean they must be merged into DSH core.

Whether any abstraction later belongs upstream is a separate decision based on
reuse evidence and upstream acceptance. The MVP does not wait for or assume an
upstream contribution.

## Consequences for downstream decisions

- “Define the exact Candidate workspace and effect contract” now owns concrete
  Candidate, Git/worktree, artifact-integrity, precondition, exact apply,
  confirmation, and reconciliation schemas behind the frozen capability split.
- “Select the first DSH realizer/provider composition” is now a precise decision:
  choose one provider permitted by the one-shot adapter boundary, freeze its
  resolver binding and environment requirements, and register its real-provider
  compatibility profile.
- “Design the durability conformance harness” must exercise manager shutdown,
  provider unload/reload, binding mismatch, duplicate/late delivery, proposal
  custody before authority, and effect-provider absence alongside the already
  frozen transaction crash windows.
- “Order and gate the MVP vertical slices” must build provider-neutral runtime
  authority first, then the Cordis composition and deterministic subagent
  profile, and require the selected real-provider profile before claiming a real
  DSH golden path.
- The repository/package-layout decision may now place the logical service
  definitions and adapter, but must wait for the concrete Candidate/effect and
  first-provider dependencies before freezing all physical packages and exports.

## Explicitly rejected alternatives

- Direct DSH types in Domain or provider-neutral runtime APIs: this couples Task
  authority to a developer-preview Harness surface.
- A generic capability bus or `execute(action, payload)`: it hides materially
  different realization, artifact, workspace, and effect trust contracts.
- Direct Host access to Domain transitions, runtime commands, provider
  registries, or `AuthorityStore`: it bypasses frozen policy and the narrow Host
  authority boundary.
- Registration-order or last-writer-wins provider selection: process timing
  would change durable execution meaning.
- Re-resolving an existing Invocation after unload: it rewrites the frozen
  binding and defeats provenance and fencing.
- Treating DSH continuable Sessions as Tempera continuation: Session activation
  is not durable Stage policy or Invocation authority.
- Treating DSH Jobs as Invocation storage or recovery truth: the shipped registry
  is process-local and owner disposal cancels work.
- Treating `ctx.workspaceRegistry` as a Candidate provider: it groups canonical
  directories and Sessions but supplies no isolation, immutable Candidate,
  precondition, or exact apply contract.
- Treating DSH storage as the authority store: it does not supply the frozen
  multi-record Task transaction and receipt boundary.
- Provider callback directly into Domain or SQLite: it lets executor delivery
  bypass normalization, immutable proposal custody, receipts, and fencing.
- Workspace-owned authoritative apply: convenience composition cannot bypass a
  durable Operation dispatch grant and reconciliation contract.
- Mutable paths or DSH Spill locators as trust-chain artifacts: locator
  availability is not immutable integrity.
- Automatic retry after unknown provider or effect outcome: ambiguity is not
  permission to repeat external work.
- Depending on every potentially useful DSH package up front: compatibility is
  proven per imported public seam, not inferred from a release-wide version pin.
- Requiring a concrete provider as a Cordis dependency of the whole manager:
  provider absence is waiting for affected work, not disposal of Task management.
- Moving the MVP extensions into DSH core first: DSH-native composition does not
  require upstream ownership.
