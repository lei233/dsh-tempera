# Tempera Task Domain

Tempera owns the durable lifecycle and authority of delegated work. Harnesses and providers perform work, but they do not decide which results become authoritative.

## Language

**Task**:
The durable owner of one delegated-work intent and its authoritative lifecycle.
_Avoid_: Job, run, session

**Stage**:
A durable semantic work unit materialized under a Task's frozen policy.
_Avoid_: Workflow node, step, DAG node

**Invocation**:
One non-authoritative realization attempt for a Stage.
_Avoid_: Task, execution authority decision

**Candidate**:
An immutable proposed Task outcome whose identity matters to acceptance.
_Avoid_: Patch, workspace, generic output

**Review**:
Immutable acceptance evidence containing one judgment about an exact Candidate.
_Avoid_: Approval, mutable review status

**Approval**:
An immutable acceptance-authority decision for an exact Candidate under frozen policy and evidence.
_Avoid_: Review result, Stage

**Operation**:
The durable authoritative intent for an external effect that requires crash-safe coordination.
_Avoid_: Invocation, command log, provider attempt

**Execution authority**:
Permission to attempt realization of a Stage; it never implies acceptance of the result.
_Avoid_: Approval

**Acceptance authority**:
Permission to make an exact Candidate authoritative under policy.
_Avoid_: Executor success

**Effect authority**:
Permission to dispatch an already-prepared authoritative Operation.
_Avoid_: Execution authority

**AuthorityScope**:
The finite capability boundary frozen for a Task and only narrowed downstream.
_Avoid_: Full IAM policy, provider permissions

**Retry**:
A new Invocation attempting the same semantic Stage.
_Avoid_: Repair, provider-internal retry

**Repair**:
A new Stage representing changed semantic work, potentially producing a new Candidate derived from an earlier one.
_Avoid_: Retry

**Reconciliation**:
The evidence-driven resolution of an Operation whose external outcome is unknown.
_Avoid_: Speculative retry

**Materialization**:
The authoritative creation of a Stage as a legal continuation under frozen policy.
_Avoid_: Scheduling, plugin continuation
