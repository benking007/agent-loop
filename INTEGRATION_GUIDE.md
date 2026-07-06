# Agent Loop Runtime Integration Guide

This guide explains how to integrate the starter kit into a general-purpose agent.

## 1. Architecture

```text
User Task
  -> Skill Loader
  -> Loop Orchestrator
  -> Tool Gateway
  -> Hooks
  -> Verifiers
  -> Evidence Ledger
  -> Task State Store / Audit Sink
  -> Result Report
```

## 2. What Runs Where

| Concern | Best Place | Why |
|---|---|---|
| Work principles | Skill / system instruction | The model needs the protocol |
| Task state | SDK runtime | Must persist across turns |
| Durable task state | `TaskStateStore` | Needed for recovery and multi-turn agents |
| Tool permission | Tool gateway / sandbox | Must be enforceable |
| Policy config | `PolicyToolGateway` | Tool decisions should be configurable |
| Approval | Host app / runtime | Human needs to review impact |
| Audit | `AuditSink` | Needed for replay, accountability, and incident review |
| Evidence capture | Post-tool hook | Should not rely on model memory |
| P0 delivery gate | Pre-deliver hook | Prevents false success |
| Verification | External tools | Must touch real environment |
| Final status | Runtime state machine | Avoids vague "done" |

## 3. Minimal Runtime Loop

The runtime exposes four methods: `runTool`, `judge`, `compact`, and `deliver`.
Note that `runTool` already records evidence (there is no separate `observe`), and
`judge` already runs the verifiers (there is no separate `verify`).

```ts
let state = initializeTaskState(userTask);
state.acceptanceSpec = buildOrInferAcceptanceSpec(userTask);

while (!isTerminal(state)) {
  const action = model.chooseNextAction(state);
  state = await runtime.runTool(action, state); // permission + evidence + hook evidence + budget
  state = await runtime.judge(state);           // verifiers + failure counting

  if (needsRepair(state)) {
    state = await model.repair(state);          // model-side fix only
    state = await runtime.judge(state);         // re-verify after repair
  }

  if (shouldCompact(state)) {
    state = await runtime.compact(state);       // preserve essential state
  }
}

return runtime.deliver(state);

// isTerminal(state) := state.status is one of
//   SUCCESS | PARTIAL | UNVERIFIED | BLOCKED | LIMITED | FAILED
```

The runtime owns budget accounting (`maxTurns` and `maxCost`), repair-attempt
counting, and failure cleanup, so the loop above cannot spin forever even if the
model never voluntarily stops.

## 4. Required Hooks

### `preToolUse`

Block unsafe or out-of-scope actions.

```text
Input: ToolRequest, TaskState
Output: allow / deny / approval required
```

### `postToolUse`

Optionally return extra evidence after tool execution. The runtime already records the primary tool result; this hook is for derived evidence such as parsed logs, screenshot summaries, trace IDs, or normalized metrics.

```text
Input: ToolRequest, ToolResult, TaskState
Output: EvidenceEntry[] | void
```

### `preDeliver`

Prevent premature completion.

```text
Rules:
- requested SUCCESS and P0 not pass -> block
- no evidence -> no verified claim
- budget exhausted -> LIMITED
- permission/data missing -> BLOCKED
```

The hook should not block all non-success delivery. It should allow honest statuses
such as `UNVERIFIED`, `BLOCKED`, `LIMITED`, and `FAILED` so the agent can report
truthfully instead of crashing before producing a statused result.

### `preCompact`

Preserve essential state before context compression. Triggered by
`runtime.compact(state)`, which merges the preserved fields back into the state.

```text
Keep:
- Goal
- Acceptance Spec
- Decisions
- Evidence
- Open Failures
- Next Action
```

## 5. Verifier Interface

Each task domain should provide verifiers.

Coding:

```text
run_tests
typecheck
lint
browser_check
diff_risk_check
```

Research:

```text
source_freshness
source_reliability
cross_source_consistency
fact_claim_mapping
```

Data:

```text
query_reproducibility
schema_check
sample_size_check
outlier_check
metric_recompute
```

Product:

```text
user_path_coverage
edge_case_coverage
dependency_check
acceptance_test_check
```

## 6. Recommended Plugin Shape

For Codex-like environments, package the runtime as a plugin:

```text
agent-loop-runtime-plugin/
  .codex-plugin/plugin.json
  skills/
    agent-loop/SKILL.md
  hooks/
    pre-tool-use.*
    post-tool-use.*
    pre-deliver.*
    pre-compact.*
  mcp/
    agent-loop-server.*
  templates/
    acceptance-spec.md
    task-state.md
    evidence-ledger.md
  sdk/
    typescript/
    python/
```

## 7. Runtime Extensions

The TypeScript SDK includes optional extension points in `runtime-extensions.ts`:

```text
TaskStateStore           durable state interface
InMemoryTaskStateStore   test/dev implementation with optimistic versions
FileTaskStateStore       local JSON-file implementation for dogfood/single-agent pilots
AuditedTaskStateStore    emits state.saved events
JsonlAuditSink           local JSONL audit log sink
PolicyToolGateway        configurable allow/deny/approvalRequired decisions
AuditedToolGateway       emits tool audit events
VerifierRegistry         selects task-specific verifiers by name
CommandVerifier          wraps command-backed checks via an injected runner
mergeTaskStates          merges parallel read/tool evidence without losing entries
```

Recommended production composition:

```ts
const store = new AuditedTaskStateStore(realStore, audit);
const gateway = new AuditedToolGateway(
  new PolicyToolGateway(realGateway, policy),
  audit
);
const verifiers = registry.select(taskVerifierNames);
const runtime = new AgentLoopRuntime(gateway, verifiers, hooks);
```

Local dogfood composition:

```ts
const audit = new JsonlAuditSink(".agent-loop/audit.jsonl");
const store = new AuditedTaskStateStore(new FileTaskStateStore(".agent-loop/tasks"), audit);
const verifier = new CommandVerifier(
  { name: "typecheck", criterionId: "P0-typecheck", command: "npm", args: ["run", "typecheck"] },
  commandRunner,
  audit
);
```

## 8. Recommended MCP Tools

Expose runtime functions as tools:

```text
agent_loop.initialize_task
agent_loop.upsert_acceptance_spec
agent_loop.record_evidence
agent_loop.mark_criterion
agent_loop.record_failure
agent_loop.check_pre_deliver
agent_loop.emit_result_report
agent_loop.compact_state
agent_loop.load_task_state
agent_loop.save_task_state
agent_loop.record_audit_event
agent_loop.list_verifiers
```

This lets any agent keep state and evidence outside the model context.

## 9. Adoption Checklist

- [ ] Add the `agent-loop` skill.
- [ ] Add a persistent `TaskState` store.
- [ ] Route all tools through a `ToolGateway`.
- [ ] Add `preToolUse`, `postToolUse`, `preDeliver`, and `preCompact` hooks.
- [ ] Add at least one verifier per task type.
- [ ] Enforce result statuses.
- [ ] Require P0 evidence before `SUCCESS`.
- [ ] Add approval points for destructive or external actions.
- [ ] Add budget limits and repair attempt limits.
- [ ] Test with tasks that fail on first attempt.
- [ ] Persist `TaskState` with optimistic version checks.
- [ ] Record audit events for tool requests, decisions, executions, and state saves.
- [ ] Configure tool policy outside the prompt.
- [ ] Select verifiers through a registry instead of hardcoding every task.
- [ ] Use local file/jsonl adapters for dogfood before replacing them with production storage/logging.
- [ ] Wrap tests, lint, typecheck, browser checks, or data checks as verifiers.
