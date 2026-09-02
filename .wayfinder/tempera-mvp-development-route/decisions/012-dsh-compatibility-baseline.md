# DSH compatibility baseline decision

## Verdict

The Tempera coding MVP targets the immutable DeepSeek Harness prerelease
[`dsh-v0.1.2-alpha.3`](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.2-alpha.3),
sourced from commit
[`dd6322d604e00eec1ba5e0c8541159906a21094a`](https://github.com/deepseek-ai/deepseek-harness/commit/dd6322d604e00eec1ba5e0c8541159906a21094a).
Tempera consumes the published npm
artifacts at exact version `0.1.2-alpha.3`; the Git tag and full commit identify
the source reviewed for those artifacts, not an alternate Git dependency.

The baseline is deliberately sticky. A newer DSH developer-preview build is a
candidate until a human DSH compatibility owner approves an atomic upgrade with
the required evidence and that upgrade is merged into the target active
development line. Discovery of a newer release, a green dependency-update bot,
or successful compilation alone does not adopt it.

The baseline governs DSH composition and adapter compatibility. It does not make
DSH Sessions, Jobs, providers, workspaces, or successful executions sources of
Tempera authority.

## Frozen upstream identity

| Property | Frozen value |
| --- | --- |
| Official release | `dsh-v0.1.2-alpha.3` |
| Release kind | immutable GitHub prerelease / developer preview |
| Reviewed source commit | `dd6322d604e00eec1ba5e0c8541159906a21094a` |
| DSH npm package family | `@deepseek-ai/dsh-*` at exact `0.1.2-alpha.3` |
| Cordis compatibility version | exact `@deepseek-ai/cordis@4.0.2` when directly consumed or supplied as a peer |
| Dependency mechanism | public npm artifacts plus committed pnpm lockfile |

This release identity is the initial framework baseline. The actual direct DSH
package inventory remains empty until the DSH-native service-boundary decision
chooses the public capabilities Tempera consumes. Adding a first direct package
does not reopen the version choice: it must join this exact release family and
must register its compatibility profile before its adapter can be accepted.

## Dependency expression and enforcement

The implementation must keep a machine-readable DSH baseline manifest at
`compatibility/dsh/baseline.json`. Its first schema records at least:

```ts
interface DshBaselineManifestV1 {
  readonly schemaVersion: 1;
  readonly releaseTag: "dsh-v0.1.2-alpha.3";
  readonly sourceCommit: "dd6322d604e00eec1ba5e0c8541159906a21094a";
  readonly dshPackageVersion: "0.1.2-alpha.3";
  readonly cordisVersion: "4.0.2";
  readonly directPackages: readonly string[];
  readonly compatibilityProfiles: readonly string[];
}
```

The service-boundary and package-layout decisions may add packages and profile
identities, but they may not change the release, commit, or version fields
without the upgrade procedure below.

Dependency rules are:

- Every direct `@deepseek-ai/dsh-*` dependency uses the exact string
  `0.1.2-alpha.3`. Caret, tilde, tag, wildcard, `latest`, and `next` ranges are
  forbidden.
- If a Tempera package directly imports Cordis or must supply the DSH peer, it
  declares exact `@deepseek-ai/cordis@4.0.2`.
- The committed pnpm lockfile fixes package tarball integrity and all transitive
  resolution. Frozen CI installation must reject lockfile drift.
- A repository compatibility check enumerates every resolved
  `@deepseek-ai/dsh-*` package and fails if any version differs from the manifest
  or if more than one DSH release family is present. It also verifies the direct
  package list and Cordis resolution.
- Ordinary third-party transitive packages are lockfile-controlled; they do not
  become manually enumerated compatibility-baseline members unless Tempera
  imports their public API directly as part of the DSH adapter.
- Git dependencies, vendored DSH source, monorepo workspace aliases, DSH source
  paths, and undocumented deep imports are forbidden compatibility mechanisms.
- The Task Domain remains DSH-free. DSH dependencies belong only to the thin
  integration packages selected by the service-boundary and package-layout
  decisions; provider-neutral runtime APIs must not leak DSH types.

The manifest is a verification input, not an alternate package manager and not a
claim that an unlisted DSH capability is compatible.

## Compatibility profile model

Each Tempera adapter or real provider admitted to the MVP registers one named
compatibility profile in the baseline manifest. A profile identifies:

- the Tempera adapter and DSH package entrypoints it consumes;
- the public compile fixture that describes the expected type surface;
- the deterministic framework behavior suite it must pass;
- any real-provider conformance suite required for adoption and release;
- platform, credential, and sandbox prerequisites for that provider suite; and
- the upstream behavioral guarantees on which the adapter relies.

Compatibility is positive and scoped: a passing profile proves only the public
entrypoints and behaviors that profile exercises. It does not certify all DSH
packages or all transports.

## Compile-time compatibility contract

Every DSH-consuming integration package owns a small consumer fixture that is
compiled as an external consumer rather than as privileged monorepo source. The
fixture must:

1. import every DSH and Cordis type or runtime symbol used by the adapter through
   its documented public package export;
2. instantiate the real service/plugin composition shape expected by the
   adapter, including required service injection and provider registration;
3. type-check the adapter's inbound and outbound contracts without casting away
   incompatibilities;
4. compile with the repository's supported Node/TypeScript module settings;
5. build against the installed npm artifacts and smoke-import the built Tempera
   package through its public export; and
6. remain independent of DSH repository source, path aliases, generated files
   not shipped in npm, and `@deepseek-ai/dsh-*/src/*` entrypoints.

The required compile gate is `tsc --noEmit` for the fixture plus build and export
smokes for the consuming package. Merely compiling whatever paths the main
application happens to reach is insufficient. Full upstream declaration-file
snapshots are also rejected: they create noise from APIs Tempera does not use and
do not express the semantic contract.

A changed public signature is compatible only after the fixture and adapter are
updated together and the behavioral meaning remains unchanged or has passed the
semantic-change procedure below.

## Deterministic framework behavior contract

The always-required suite runs the exact DSH/Cordis npm artifacts with a
deterministic Tempera test provider registered through the real public DSH
service seam. It is not a mocked replacement for the DSH registry or Cordis
lifecycle. As profiles are introduced, the suite must cover every relied-upon
upstream guarantee, with this minimum core:

- required Cordis service injection waits while unavailable, activates once,
  and disposes/reloads dependents when the service is removed and restored;
- provider registration and removal use the real named registry and cleanup
  lifecycle rather than a Tempera-only fake registry;
- unsupported requested capabilities fail before provider start;
- one-shot start exposes the expected run identity, terminal result, and
  idempotent disposal behavior;
- removing a provider prevents new starts without rewriting the disposition of
  a run already accepted by that provider;
- adapter failures distinguish unavailable, rejected, failed, cancelled, and
  indeterminate observations without inventing Task authority;
- successful provider completion produces only a proposal or observation for a
  fenced Tempera command; it cannot directly complete a Stage, accept a
  Candidate, approve a Candidate, dispatch an Operation, or complete a Task;
- missing DSH Job or Session state after restart never overrides Tempera's
  durable Invocation or Operation truth; and
- unload, reload, duplicate delivery, and late-result cases preserve the stable
  Invocation identity and generation fence owned by Tempera.

When an adapter starts consuming another DSH seam, the relevant documented
behavior becomes part of its profile before the import merges. Examples include
sandbox fail-closed enforcement, workspace canonical identity, storage
single-call durability, or live Jobs observation. An untested imported seam is a
compatibility failure.

This suite runs on every pull request and in the normal repository check. It may
use deterministic clocks, outputs, and transport fixtures, but it must execute
the real pinned DSH framework packages.

## Real-provider conformance contract

The first golden-path provider selected later must add a provider-specific
profile that exercises its real DSH registration and transport. A Tempera fake
cannot satisfy this layer. Where supported, the test may use a deterministic
backend behind the real transport; otherwise it runs in a controlled environment
with the required credentials.

Each real-provider profile verifies every claimed property relevant to its
binding, including:

- stable provider name, observed capabilities, route/config provenance, and
  refusal of unsupported requirements;
- launch, terminal result, cancellation, disposal, and provider disappearance;
- the provider's actual reconnect, continuation, or non-enumerability behavior;
- error and disconnect mapping into Tempera observations;
- the effective sandbox enforcement level and fail-closed behavior when the
  Task requires stronger confinement than the provider can supply;
- workspace/scope identity and absence of provider handles or mutable paths in
  Task Domain state; and
- proposal durability and fencing across the adapter boundary.

The deterministic framework suite blocks every pull request. Real-provider
profiles block adoption of a new DSH baseline and the release milestone that
uses that provider. They need not run on every ordinary pull request when they
require credentials, network, or a specific platform, but their results must be
captured in the adoption evidence.

Before the first real provider is selected, passing the core profile establishes
only framework compatibility. It must not be reported as golden-path provider
compatibility. Once a provider profile is registered, a baseline cannot be
adopted while that required profile is skipped or unavailable.

## Upgrade triggers and candidate isolation

The baseline is not automatically refreshed. An upgrade begins only for an
explicitly recorded reason such as a needed capability, a relevant defect fix, a
security correction, or a deliberate maintenance window. Release availability
alone is not a reason.

Every proposal starts in a dedicated worktree and branch based on the target
active development line. Until adoption, that line continues to use the old
manifest, exact dependencies, lockfile, and profiles. The candidate must not
create a mixed-version active line or silently widen dependency ranges.

Security urgency may pause feature work and prioritize the candidate, but it
does not waive compatibility evidence or human approval.

## Required revalidation report

Each candidate adds a versioned report under `compatibility/dsh/reviews/`. The
report is part of the atomic upgrade and contains:

1. the old and proposed release tags, full source commits, exact direct package
   versions, npm artifact integrity changes, and lockfile diff summary;
2. the official changelog range and a focused source/API diff for every public
   entrypoint named by an active compatibility profile;
3. changes to Node, Cordis, peer dependencies, supported platforms, native
   requirements, and package exports;
4. results and reproducible commands for every compile fixture, deterministic
   framework suite, and registered real-provider profile;
5. a delta review of every DSH capability-audit statement on which Tempera still
   relies, classified as unchanged, modified, or invalidated;
6. the adapter, manifest, test, and documentation changes required by the new
   release; and
7. the named human compatibility owner, review outcome, and any explicitly
   blocked downstream work.

The candidate's manifest, exact package declarations, lockfile, necessary
adapter changes, compatibility tests, and report form one review unit. Splitting
the pin from the adaptation or evidence is forbidden because it would briefly
make the active line claim an unproven baseline.

## Semantic-change procedure

Green compilation and behavior tests do not authorize adoption when an upstream
guarantee changes meaning. A change to any relied-upon lifecycle, subagent,
recovery, sandbox, workspace, storage, or authority-boundary assumption requires
a new named Wayfinder decision that:

- identifies the invalidated capability-audit and compatibility-profile claims;
- decides whether Tempera adapts, narrows the profile, changes provider, or stays
  on the old baseline;
- updates every affected closed decision through explicit context pointers
  rather than silently rewriting its historical answer; and
- adds or changes tests that distinguish the old and new semantics.

That decision must close before the upgrade can be approved. A public signature
change with unchanged semantics may be adapted within the candidate review unit
without opening a new decision.

This rule is impact-scoped: an unrelated DSH change does not reopen the entire
architecture, while a passing test cannot conceal a changed guarantee.

## Approval and adoption

An agent may discover the release, prepare the candidate, run tests, and write
the evidence. It cannot approve its own upgrade. The candidate must name one
human **DSH compatibility owner** who reviews the report and explicitly approves
or rejects adoption.

Adoption occurs only when all of the following are true:

- the compile fixture and deterministic framework profile pass;
- every registered required real-provider profile passes in its declared
  environment;
- no relied-upon capability-audit claim remains unresolved or silently
  invalidated;
- every semantic-change decision is closed;
- the human compatibility owner approves the complete review unit; and
- that unit is merged atomically into the target active development line.

Before merge, the build remains a candidate even if CI is green. A missing
credential, unavailable provider environment, unrun required profile, or pending
human review blocks adoption; it is not an accepted exception.

If an adopted upgrade later proves incompatible, the safe default is to revert
the complete upgrade unit to the last approved baseline. Mixing old and new DSH
packages or applying an undocumented partial downgrade is not a recovery path.

## Consequences for downstream decisions

- **Define the DSH-native service and plugin boundaries** is now unblocked. It
  must choose only documented public entrypoints from this release, populate the
  direct-package inventory, and define the first core compatibility profiles.
- **Define the exact Candidate workspace and effect contract** must attach any
  DSH workspace, sandbox, artifact, or provider assumptions to named profiles
  rather than treating the release as globally compatible.
- **Design the durability conformance harness** must include the deterministic
  framework suite in normal CI and define the secure environments that execute
  registered real-provider profiles.
- **Order and gate the MVP vertical slices** must place provider-profile success
  before the first slice that claims a real DSH golden path.
- The future package-layout decision owns physical adapter and fixture packages,
  but cannot move DSH types into Task Domain or weaken exact dependency closure.

## Explicitly rejected alternatives

- Git-commit dependencies: the reviewed commit remains provenance, while the
  published npm artifact is the actual install and compatibility unit.
- Vendoring DSH: it would make Tempera responsible for an upstream fork and
  obscure whether the tested code matches an official release.
- Semver ranges, dist-tags, or mixed alpha versions: they allow the active line
  to adopt upstream changes without review.
- Main-project compilation as the only contract: it does not deliberately cover
  every imported DSH surface.
- Full upstream declaration snapshots: they block on unrelated API churn while
  saying nothing about runtime meaning.
- Fake-provider-only compatibility: it cannot establish that the actual
  golden-path transport, sandbox, or lifecycle behaves as required.
- Live-provider calls on every ordinary pull request: external variance and
  credentials would make the fast compatibility signal unreliable.
- CI-green automatic upgrades or agent self-approval: developer-preview semantic
  changes require accountable human review.
- Skipping a registered provider profile because its environment is unavailable:
  absence of evidence leaves the build a candidate, not an adopted baseline.
