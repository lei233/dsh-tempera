# Execution Spec Context Compilation

This reference defines how the host/planning Agent turns resolved task context into executor-facing instructions before writing an Execution Spec.

The host owns selection, interpretation, conflict resolution, and normalization. The executor should receive the resolved task, not the host's context-processing workflow.

## 1. Select Only Task-Relevant Sources

Start from the bounded objective and inspect only material that can change implementation or verification.

Possible sources include:

- explicit user instructions;
- current repository state;
- applicable repository instructions;
- architecture and project documentation;
- selected specifications, issues, or design artifacts;
- applicable Skills;
- relevant research or external facts;
- host-side planning decisions needed to make the task executable.

Do not include a source merely because it exists or appears authoritative. Include or compile only the parts that affect the bounded task.

## 2. Inspect Actual Working State

When execution depends on a repository or workspace, inspect the current state before compiling the spec.

Confirm facts such as:

- current files and package boundaries;
- existing implementations or abstractions;
- relevant tests and validation commands;
- repository-local instructions;
- material changes from stale design notes or handoffs.

Prefer current repository facts over outdated summaries when they conflict.

## 3. Verify Material Facts

Verify material facts before encoding them as `Requirements` or `Decisions`.

Do not convert unresolved factual assumptions into fixed executor instructions. Distinguish between a planning choice the host is authorized and informed enough to make and a factual claim about the target that has not been established.

If a material fact cannot be established before execution, resolve it host-side when possible. When the fact can only be established during execution, encode only the narrow execution-time condition needed to detect it rather than presenting the assumption as settled.

For example, `Reuse the existing validation pipeline` can be a fixed decision only after the host has established that the relevant pipeline exists and is applicable to the task.

## 4. Read Applicable Skills Host-Side

The host may use other Skills to plan or constrain implementation. Read those Skills before emitting the Execution Spec when they apply.

Extract only guidance the executor can directly act on for this task. Remove:

- Skill discovery or activation instructions;
- host-only tool calls;
- channel or UI mechanics;
- host approval and permission flows;
- unavailable external-tool workflows;
- instructions whose purpose is to govern the planner rather than the implementation.

Never tell the executor to invoke the original host-side Skill merely to recover implementation guidance the host could have compiled.

## 5. Resolve Conflicts Before Execution

Resolve material conflicts before writing the spec whenever possible.

Use explicit task authority and the applicable project's own precedence rules when available. In the absence of a project-specific precedence rule, reason from the concrete task boundary:

1. explicit user objective and scope;
2. selected task specification or acceptance contract;
3. applicable repository/project instructions and architecture boundaries;
4. portable implementation guidance from applicable Skills or research;
5. host defaults and general preferences.

Do not preserve competing instructions in the final spec and ask the executor to choose between them.

If a conflict cannot be resolved without changing task semantics, violating an architectural boundary, or inventing missing authority, emit a narrow `Stop Conditions` trigger or stop before producing an underspecified spec.

## 6. Make Required Planning Decisions

Resolve non-trivial choices that the executor should not have to rediscover when the host already has enough information to decide them.

Examples include:

- which existing abstraction should be extended;
- which package owns the responsibility;
- whether a compatibility path must be preserved;
- which implementation files are actually relevant;
- which verification commands establish completion.

Encode the result as a direct `Requirement` or, when clearer as a fixed choice, a `Decision`.

Do not include the alternatives considered or the reasoning history that led to the choice.

## 7. Normalize Guidance Into Task-Native Instructions

Requirements should describe what is true for the task, not where the rule came from.

Convert source-specific guidance such as:

```text
Project instruction: Existing public APIs must remain backward compatible.
Testing guidance: Prefer externally observable behavior.
```

into direct instructions such as:

```markdown
- Preserve backward compatibility for existing public APIs.
- Test externally observable behavior rather than implementation details.
```

Preserve provenance only when the executor operationally needs it, for example when a task explicitly requires editing or reconciling a named specification or when a source must be cited in an externally governed deliverable.

## 8. Choose Executor-Readable Working Context

The optional `Context` section is for materials the executor must genuinely inspect while doing the work.

Include a file or artifact when the executor needs its full or evolving contents to implement correctly, such as:

- an affected type definition;
- an existing implementation being extended;
- tests that establish current behavior;
- a selected issue or specification that is itself part of the task interface.

For each item, explain briefly why it matters.

Do not list meta-context merely to avoid compiling it. In particular, do not make the executor reread broad files such as `CONTEXT.md`, architecture overviews, planning artifacts, or Skills when the relevant requirements can be stated directly.

`Context` identifies important working anchors known to the host; it is not an exhaustive read allowlist. The executor may discover and inspect additional in-scope implementation files as part of ordinary code navigation.

A useful test is: if the executor only needs one rule from a source, inline the resolved rule; if the executor needs to inspect the source's concrete code/data/details while editing, list it in `Context`.

## 9. Keep the Spec Self-Contained Without Dumping Context

Self-contained means the executor does not need the host's hidden planning context to understand the task.

It does not mean embedding the entire repository, every source document, or all applicable Skills into the prompt.

The host should name important working anchors it already knows are material to the task and compile host-side context into direct requirements. The executor may discover and inspect additional in-scope implementation files as part of ordinary execution work.

## 10. Bound Stop Conditions

The host should absorb normal uncertainty and clarification work before execution.

Use a stop condition only if new information encountered during execution could force a semantically different task or make correctness unverifiable. Examples:

- an abstraction named in a fixed decision does not exist on the actual target branch;
- the required change would violate an explicit package or dependency boundary;
- a requested migration cannot preserve an explicit compatibility requirement;
- the specified verification command is unavailable and no equivalent check can demonstrate the acceptance criteria.

Do not use generic stop conditions for routine implementation judgment.

## 11. Perform the Sufficiency/Noise Audit

Before handing the spec to an executor, ask two questions for every important instruction:

1. If this information were missing, could a competent executor implement or verify the task incorrectly?
2. If this information were removed, would execution behavior remain unchanged?

Add what is required by the first question. Remove what fails the second.

The final artifact should be minimal but sufficient: one complete task interface with no dependency on host-side provenance, orchestration concepts, or rediscovery work.
