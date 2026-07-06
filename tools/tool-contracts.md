# Agent Loop Tool Contracts

These contracts define how tools should integrate with the Agent Loop Runtime.

## Tool Categories

| Category | Examples | Default Policy |
|---|---|---|
| `READ` | file read, search, log query, source lookup | allow, parallelizable |
| `WRITE` | file edit, document generation, config write | allow only within scope, serialize |
| `EXECUTE` | test, build, script, browser run | allow with budget and sandbox |
| `EXTERNAL_ACTION` | deploy, publish, send message, payment, trade | approval required |
| `DESTRUCTIVE` | delete, reset, overwrite irreversible data | explicit approval required or deny |

## Tool Request Shape

```ts
type ToolRequest = {
  id: string;
  name: string;
  category: "READ" | "WRITE" | "EXECUTE" | "EXTERNAL_ACTION" | "DESTRUCTIVE";
  purpose: string;
  args: unknown;
  supportsCriteria?: string[];
  approvalRequired?: boolean;
};
```

## Tool Result Shape

```ts
type ToolResult = {
  requestId: string;
  ok: boolean;
  summary: string;
  artifact?: string;
  raw?: unknown;
  evidenceFor?: string[];
  risk?: string;
};
```

## Required Runtime Behavior

- Run `preToolUse` before execution.
- If approval is required, pause and request approval with impact and rollback notes.
- Run `postToolUse` after execution; it may return derived evidence.
- Convert meaningful tool output into an evidence ledger entry, preserving `ok` so failed executions cannot be mistaken for success evidence.
- Do not allow final `SUCCESS` unless P0 criteria have evidence and pass.
