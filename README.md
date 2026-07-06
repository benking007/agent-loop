# Agent Loop Runtime Starter Kit

This starter kit turns the Agent Loop methodology into reusable artifacts that a general-purpose agent can connect to.

It is designed around one principle:

```text
Do not rely on the model remembering to be careful.
Put the loop into runtime state, hooks, permissions, verifiers, and result statuses.
```

For a deep dive on how it works (principles, working mode, pros/cons), see
[`ARCHITECTURE.md`](./ARCHITECTURE.md).

## Contents

```text
ARCHITECTURE.md            deep-dive design doc

skill/
  agent-loop/SKILL.md

schemas/
  acceptance-spec.schema.json
  audit-event.schema.json
  command-verifier.schema.json
  task-state.schema.json
  evidence-ledger.schema.json
  result-report.schema.json
  tool-policy.schema.json

templates/
  acceptance-spec.md
  task-state.md
  evidence-ledger.md
  failure-report.md
  delivery-report.md

sdk/typescript/
  agent-loop-runtime.ts
  agent-loop-runtime.test.ts
  runtime-extensions.ts
  runtime-extensions.test.ts
  example-coding-agent.ts

tools/
  tool-contracts.md

package.json               scripts: test / typecheck / example
tsconfig.json
```

## Quickstart

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # 25 runtime/pure-function unit tests
npm run example     # run the minimal coding-agent demo
```

## Integration Model

Use the artifacts in layers:

```text
Skill          -> teaches the model the loop protocol
SDK Runtime    -> controls state transitions and result status
Tool Gateway   -> enforces tool permissions and approvals
Hooks          -> blocks unsafe or premature actions
Verifiers      -> prove whether the work is actually done
Templates      -> standardize specs, evidence, failures, and delivery
```

## Minimal Adoption Path

1. Add `skill/agent-loop/SKILL.md` to the agent's skill system.
2. Use `schemas/task-state.schema.json` as the persistent loop state shape.
3. Route every tool call through a `ToolGateway`.
4. Register at least these hooks:
   - `preToolUse`
   - `postToolUse`
   - `preDeliver`
   - `preCompact`
5. Attach domain verifiers, such as tests for coding or source checks for research.
6. Require final output to use a result status:
   - `SUCCESS`
   - `PARTIAL`
   - `UNVERIFIED`
   - `BLOCKED`
   - `LIMITED`
   - `FAILED`
7. For production-like pilots, add:
   - `TaskStateStore` for persistence and optimistic locking
   - `AuditSink` for replayable tool/state events
   - `PolicyToolGateway` for configurable tool permissions
   - `VerifierRegistry` for task-specific verifier selection
   - `FileTaskStateStore` / `JsonlAuditSink` for local dogfood
   - `CommandVerifier` for command-backed checks such as tests and typechecks

## Hard Rules

- No `SUCCESS` without P0 acceptance evidence.
- No claim of verification without verifier output or explicit evidence.
- No high-risk external action without approval.
- No infinite repair loop; repeated failure must become `FAILED`, `BLOCKED`, or `LIMITED`.
- No context compaction without preserving `Goal`, `Acceptance Spec`, `Evidence`, `Open Failures`, and `Next Action`.

These are enforced in `agent-loop-runtime.ts`, not left to the model:
`deriveResultStatus` / `p0AllPass` gate `SUCCESS` on P0 positive evidence, `reconcileFailures`
counts repair attempts toward `FAILED`, `spendTurn` enforces turn/cost budgets
(`LIMITED`), the `ToolGateway` gates high-risk actions, and `compact` runs
`preCompact` to preserve essential state.

`runtime-extensions.ts` adds production-facing extension points without making the
core runtime heavier: `TaskStateStore`, `AuditSink`, `PolicyToolGateway`,
`AuditedToolGateway`, `VerifierRegistry`, `CommandVerifier`, local file/jsonl
adapters, and `mergeTaskStates`.
