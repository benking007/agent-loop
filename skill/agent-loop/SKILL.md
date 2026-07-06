---
name: agent-loop
description: Use when an AI agent must complete a task reliably through a loop of goal definition, acceptance criteria, tool execution, evidence collection, judging, repair, verification, and statused delivery. Applies to coding, research, data, product, design, operations, and any high-stakes or multi-step agent workflow where "done" must mean verified, not merely output produced.
---

# Agent Loop

Use this skill to run tasks through a reliable loop:

```text
Configure -> Goal -> Spec -> Plan -> Act -> Observe -> Judge -> Repair -> Verify -> Deliver
```

## Core Rule

Do not claim a task is complete just because an output exists. Completion requires evidence against acceptance criteria.

## Start Every Non-Trivial Task

For L2/L3 tasks, create or infer:

```text
Goal:
Deliverable:
P0 acceptance:
P1 acceptance:
Evidence required:
Risks:
Stop conditions:
```

Use L1 only for simple answers, small edits, or format transforms.

## Runtime Status

Final delivery must use one status:

- `SUCCESS`: P0 acceptance passed with evidence.
- `PARTIAL`: usable output exists, but known non-P0 gaps remain.
- `UNVERIFIED`: output exists, but required verification was not completed.
- `BLOCKED`: external permission, data, environment, or decision is missing.
- `LIMITED`: budget, time, turns, or context limit stopped progress.
- `FAILED`: repair was attempted but P0 still fails.

Never output `SUCCESS` if P0 is unverified or failing.

## Loop Protocol

1. **Configure**: identify allowed tools, approval points, budget, context strategy, and stop conditions.
2. **Goal**: restate the user's real objective and intended use.
3. **Spec**: convert the goal into P0/P1 acceptance criteria.
4. **Plan**: choose the shortest evidence-producing path.
5. **Act**: use tools and produce artifacts.
6. **Observe**: capture tool results, logs, screenshots, sources, data, or test output.
7. **Judge**: compare evidence to acceptance criteria.
8. **Repair**: fix only evidence-backed failures.
9. **Verify**: rerun relevant checks after repair.
10. **Deliver**: report status, result, evidence, verification, and residual risk.

## Tool Discipline

- Read/search tools may be parallelized.
- Write/execute/external-action tools should be serialized unless the runtime proves independence.
- Destructive, irreversible, production, financial, publishing, or external messaging actions require approval.
- Every tool result that affects completion must be recorded as evidence.

## Required Failure Report

When a P0 item fails, record:

```text
Failed item:
Expected:
Actual:
Evidence:
Likely cause:
Repair plan:
Re-verify method:
```

## Required Delivery Shape

```text
Status:
Completed:
Evidence:
Verification:
Remaining risks:
Next step:
```

