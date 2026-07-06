# Agent Loop MCP Tool Spec

These tools can be implemented by an MCP server or equivalent connector so that any agent can persist and enforce loop state outside model memory.

## `agent_loop.initialize_task`

Input:

```json
{
  "taskId": "string",
  "goal": "string",
  "deliverable": "string",
  "budget": {
    "maxTurns": 12,
    "maxRepairAttempts": 2
  }
}
```

Output:

```json
{
  "taskState": {}
}
```

## `agent_loop.upsert_acceptance_spec`

Input:

```json
{
  "taskId": "string",
  "acceptanceSpec": {}
}
```

Output:

```json
{
  "ok": true
}
```

## `agent_loop.record_evidence`

Input:

```json
{
  "taskId": "string",
  "source": "run_tests",
  "summary": "All relevant tests passed.",
  "artifact": "path-or-url",
  "supports": ["P0-tests-pass"]
}
```

Output:

```json
{
  "evidenceId": "ev-1"
}
```

## `agent_loop.mark_criterion`

Input:

```json
{
  "taskId": "string",
  "criterionId": "P0-tests-pass",
  "status": "PASS",
  "message": "Test evidence found."
}
```

Output:

```json
{
  "ok": true
}
```

## `agent_loop.record_failure`

Input:

```json
{
  "taskId": "string",
  "criterionId": "P0-tests-pass",
  "expected": "Tests pass",
  "actual": "One test failed",
  "evidence": "test-output.log",
  "repairPlan": "Fix failing assertion and rerun tests"
}
```

Output:

```json
{
  "failureId": "fail-1"
}
```

## `agent_loop.check_pre_deliver`

Input:

```json
{
  "taskId": "string",
  "requestedStatus": "SUCCESS"
}
```

Output:

```json
{
  "allowed": false,
  "requiredStatus": "UNVERIFIED",
  "reason": "P0 criteria have no supporting evidence."
}
```

Behavior:

- If `requestedStatus` is omitted, the server should return the derived status and allow honest non-success reporting.
- If `requestedStatus` is `SUCCESS` but the derived status is not `SUCCESS`, the server must reject the request.
- Negative evidence, such as an evidence entry with `ok: false`, must not count as P0 success evidence.

## `agent_loop.emit_result_report`

Input:

```json
{
  "taskId": "string"
}
```

Output:

```json
{
  "status": "SUCCESS",
  "completed": [],
  "evidence": [],
  "verification": [],
  "remainingRisks": [],
  "nextStep": ""
}
```

## `agent_loop.load_task_state`

Input:

```json
{
  "taskId": "string"
}
```

Output:

```json
{
  "taskState": {},
  "version": 3,
  "updatedAt": "2026-07-06T00:00:00.000Z"
}
```

## `agent_loop.save_task_state`

Input:

```json
{
  "taskState": {},
  "expectedVersion": 3
}
```

Output:

```json
{
  "version": 4,
  "updatedAt": "2026-07-06T00:00:00.000Z"
}
```

Behavior:

- Must reject stale writes when `expectedVersion` does not match current version.
- Must persist state outside model context.

## `agent_loop.record_audit_event`

Input:

```json
{
  "taskId": "string",
  "type": "tool.completed",
  "summary": "Tool completed.",
  "metadata": {}
}
```

Output:

```json
{
  "auditId": "audit-1"
}
```

## `agent_loop.list_verifiers`

Input:

```json
{
  "taskType": "coding"
}
```

Output:

```json
{
  "verifiers": ["run_tests", "typecheck", "lint"]
}
```
