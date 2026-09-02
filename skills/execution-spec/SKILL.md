---
name: execution-spec
description: Compile a host/planning Agent's resolved understanding of a bounded task into one self-contained Execution Spec that an executor can act on directly. Use when work should be handed to DSH Code mode, a sub-agent, Codex, Qoder, Claude Code, or another executor without requiring it to reconstruct host context, Skill provenance, planning history, or orchestration mechanics.
---

# Execution Spec

Compile one bounded task into a complete executor-facing specification.

The host/planning Agent owns context compilation. It reads user intent, repository state, project instructions, applicable Skills, selected specifications, research, and other relevant material; resolves conflicts and planning decisions; then emits only the task-native instructions the executor needs to execute and verify the work correctly.

An Execution Spec is the executor's complete task interface, not a description of how the host assembled the task.

## Keep These Boundaries

- Produce one primary artifact titled exactly `# Execution Spec`.
- Keep the artifact executor-agnostic. Do not make it depend on DSH Code mode, sub-agents, Codex, Qoder, Claude Code, or another specific realizer.
- Do not ask the executor to discover, invoke, or understand host-side Skills, context systems, planning tools, approval mechanics, or provenance.
- Normalize relevant guidance from project docs, repository instructions, specifications, Skills, research, and host planning into direct task-native `Requirements` or fixed `Decisions`.
- Include only working context the executor genuinely needs to inspect while performing the task.
- Keep the spec self-contained, but do not turn it into a repository or context dump.
- Do not expose planner chain-of-thought, alternatives considered, compilation reports, source manifests, or explanatory provenance unless provenance itself is operationally required by the task.
- Do not introduce a new Tempera Domain concept merely because this Skill exists. The Skill compiles an executor-facing artifact and remains outside the Task Core.

## Required Workflow

1. Resolve the task before writing the spec.
   - Understand the user's bounded objective and explicit scope.
   - Inspect actual repository or working-state facts that materially affect execution.
   - Read relevant project instructions, architecture or specification material, and applicable Skills.
   - Resolve material conflicts and make planning/design decisions that should not be delegated back to the executor.
2. Compile context according to [`references/context-compilation.md`](references/context-compilation.md).
3. Write the Execution Spec according to [`references/spec-contract.md`](references/spec-contract.md).
4. Audit the result for sufficiency and noise.
   - A competent executor must be able to execute and verify the task from the spec plus the explicitly listed working files/materials.
   - Remove any passage whose deletion would not change how a competent executor should perform or verify the task.
5. Deliver the Execution Spec as the primary output. Keep any host-side audit metadata separate rather than appending it to the executor-facing artifact.

## Route to the Authoritative References

Read both references when generating an Execution Spec:

| Reference | Purpose |
| --- | --- |
| `references/context-compilation.md` | Select, resolve, strip, and normalize host-side context into executor-usable instructions. |
| `references/spec-contract.md` | Defines the v1 section contract, section semantics, forbidden leakage, and final audit. |

Do not improvise a competing artifact shape or add provenance-oriented sections such as `Compiled Project Constraints`, `Compiled Skill Rules`, `Context Report`, or `Compilation Manifest`.

## Completion Rule

Return one standard Execution Spec. Optional sections may be omitted when they contain no operationally necessary content. Never emit empty optional sections or placeholder values such as `None`.
