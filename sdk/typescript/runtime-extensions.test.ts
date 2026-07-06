import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  AgentLoopRuntime,
  type AcceptanceCriterion,
  type TaskState,
  type ToolGateway,
  type ToolRequest,
  type ToolResult,
  type Verifier
} from "./agent-loop-runtime.ts";
import {
  AuditedTaskStateStore,
  AuditedToolGateway,
  CommandVerifier,
  FileTaskStateStore,
  InMemoryAuditSink,
  InMemoryTaskStateStore,
  JsonlAuditSink,
  PolicyToolGateway,
  VerifierRegistry,
  VersionConflictError,
  decideToolPolicy,
  mergeTaskStates
} from "./runtime-extensions.ts";

const crit = (
  o: Partial<AcceptanceCriterion> & Pick<AcceptanceCriterion, "id" | "priority" | "status">
): AcceptanceCriterion => ({ statement: "s", evidenceRequired: [], ...o });

function baseState(overrides: Partial<TaskState> = {}): TaskState {
  return {
    taskId: "t",
    status: "PLANNING",
    goal: "g",
    acceptanceSpec: {
      goal: "g",
      deliverable: "d",
      criteria: [crit({ id: "P0-1", priority: "P0", status: "PENDING" })]
    },
    decisions: [],
    evidence: [],
    openFailures: [],
    budget: { maxTurns: 8, turnsUsed: 0, maxRepairAttempts: 2 },
    nextAction: "n",
    ...overrides
  };
}

const req = (over: Partial<ToolRequest> = {}): ToolRequest => ({
  id: "r1",
  name: "run_tests",
  category: "EXECUTE",
  purpose: "p",
  args: {},
  ...over
});

const allowGateway = (result: Partial<ToolResult> = {}): ToolGateway => ({
  async canRun() {
    return { approved: true };
  },
  async run(r) {
    return { requestId: r.id, ok: true, summary: "ok", ...result };
  }
});

test("InMemoryTaskStateStore: saves versions and detects conflicts", async () => {
  const store = new InMemoryTaskStateStore();
  const first = await store.save(baseState());
  assert.equal(first.version, 1);
  const second = await store.save({ ...first.state, nextAction: "next" }, 1);
  assert.equal(second.version, 2);
  await assert.rejects(() => store.save(second.state, 1), VersionConflictError);
});

test("FileTaskStateStore: persists state across instances with optimistic versions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-loop-store-"));
  const firstStore = new FileTaskStateStore(dir);
  const saved = await firstStore.save(baseState({ taskId: "file-task" }));
  assert.equal(saved.version, 1);

  const secondStore = new FileTaskStateStore(dir);
  const loaded = await secondStore.load("file-task");
  assert.equal(loaded?.state.taskId, "file-task");
  assert.equal(loaded?.version, 1);
  await assert.rejects(() => secondStore.save(saved.state, 2), VersionConflictError);
});

test("AuditedTaskStateStore: records state save events", async () => {
  const audit = new InMemoryAuditSink();
  const store = new AuditedTaskStateStore(new InMemoryTaskStateStore(), audit);
  await store.save(baseState());
  assert.equal(audit.events.length, 1);
  assert.equal(audit.events[0].type, "state.saved");
});

test("JsonlAuditSink: appends audit events as JSON lines", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-loop-audit-"));
  const file = join(dir, "audit.jsonl");
  const sink = new JsonlAuditSink(file);
  await sink.record({ id: "a1", timestamp: "t", type: "tool.requested", summary: "one" });
  await sink.record({ id: "a2", timestamp: "t", type: "tool.completed", summary: "two" });
  const lines = (await readFile(file, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(lines.map((line) => line.id), ["a1", "a2"]);
});

test("decideToolPolicy: tool-specific rules override category/default", () => {
  assert.equal(
    decideToolPolicy(req({ name: "safe_read", category: "READ" }), {
      defaultDecision: "deny",
      allowedTools: ["safe_read"]
    }),
    "allow"
  );
  assert.equal(
    decideToolPolicy(req({ name: "deploy", category: "EXTERNAL_ACTION" }), {
      defaultDecision: "allow",
      approvalRequiredTools: ["deploy"]
    }),
    "approvalRequired"
  );
  assert.equal(
    decideToolPolicy(req({ name: "delete_all", category: "DESTRUCTIVE" }), {
      defaultDecision: "allow",
      categoryDecisions: { DESTRUCTIVE: "deny" }
    }),
    "deny"
  );
});

test("PolicyToolGateway: denies policy-blocked tools before inner gateway", async () => {
  let innerCalled = false;
  const inner: ToolGateway = {
    async canRun() {
      innerCalled = true;
      return { approved: true };
    },
    async run(r) {
      return { requestId: r.id, ok: true, summary: "ok" };
    }
  };
  const gateway = new PolicyToolGateway(inner, {
    defaultDecision: "allow",
    categoryDecisions: { DESTRUCTIVE: "deny" }
  });
  const decision = await gateway.canRun(req({ category: "DESTRUCTIVE" }), baseState());
  assert.equal(decision.approved, false);
  assert.equal(innerCalled, false);
});

test("AuditedToolGateway: records requested, allowed, and completed events", async () => {
  const audit = new InMemoryAuditSink();
  const gateway = new AuditedToolGateway(allowGateway(), audit);
  const state = baseState();
  const decision = await gateway.canRun(req(), state);
  assert.equal(decision.approved, true);
  await gateway.run(req(), state);
  assert.deepEqual(
    audit.events.map((event) => event.type),
    ["tool.requested", "tool.allowed", "tool.completed"]
  );
});

test("VerifierRegistry: registers, selects, and rejects duplicate verifiers", async () => {
  const audit = new InMemoryAuditSink();
  const registry = new VerifierRegistry(audit);
  const verifier: Verifier = {
    name: "tests",
    async verify() {
      return { criteria: [], evidence: [] };
    }
  };
  await registry.register(verifier);
  assert.equal(registry.get("tests"), verifier);
  assert.deepEqual(registry.select(["tests"]), [verifier]);
  await assert.rejects(() => registry.register(verifier), /already registered/);
  assert.equal(audit.events[0].type, "verifier.registered");
});

test("CommandVerifier: maps runner success and failure to criteria and evidence", async () => {
  const audit = new InMemoryAuditSink();
  const passing = new CommandVerifier(
    { name: "test-command", criterionId: "P0-1", command: "npm", args: ["test"] },
    {
      async run() {
        return { ok: true, stdout: "all green", stderr: "", exitCode: 0 };
      }
    },
    audit
  );
  const passReport = await passing.verify(baseState());
  assert.equal(passReport.criteria[0].status, "PASS");
  assert.equal(passReport.evidence[0].ok, true);

  const failing = new CommandVerifier(
    { name: "test-command-fail", criterionId: "P0-1", command: "npm", args: ["test"] },
    {
      async run() {
        return { ok: false, stdout: "", stderr: "boom", exitCode: 1 };
      }
    }
  );
  const failReport = await failing.verify(baseState());
  assert.equal(failReport.criteria[0].status, "FAIL");
  assert.equal(failReport.evidence[0].ok, false);
  assert.ok(audit.events.some((event) => event.type === "verifier.completed"));
});

test("mergeTaskStates: merges decisions, evidence, and failures without duplicates", () => {
  const base = baseState({
    decisions: ["a"],
    evidence: [{ id: "ev-1", timestamp: "t", source: "x", summary: "s", supports: ["P0-1"] }],
    openFailures: [
      { criterionId: "P0-1", expected: "e", actual: "a", evidence: "ev", repairPlan: "r", attempts: 0 }
    ]
  });
  const incoming = baseState({
    decisions: ["a", "b"],
    evidence: [
      { id: "ev-1", timestamp: "t2", source: "y", summary: "new", supports: ["P0-1"] },
      { id: "ev-2", timestamp: "t", source: "z", summary: "s", supports: ["P1-1"] }
    ],
    openFailures: [
      { criterionId: "P0-1", expected: "e", actual: "new", evidence: "ev", repairPlan: "r", attempts: 1 }
    ]
  });
  const merged = mergeTaskStates(base, incoming);
  assert.deepEqual(merged.decisions, ["a", "b"]);
  assert.equal(merged.evidence.length, 2);
  assert.equal(merged.evidence.find((entry) => entry.id === "ev-1")!.summary, "new");
  assert.equal(merged.openFailures.length, 1);
  assert.equal(merged.openFailures[0].attempts, 1);
});

test("extensions compose with AgentLoopRuntime", async () => {
  const audit = new InMemoryAuditSink();
  const policy = new PolicyToolGateway(allowGateway({ evidenceFor: ["P0-1"] }), {
    defaultDecision: "allow",
    categoryDecisions: { DESTRUCTIVE: "deny" }
  });
  const gateway = new AuditedToolGateway(policy, audit);
  const verifier: Verifier = {
    name: "tests",
    async verify(state) {
      const pass = state.evidence.some((entry) => entry.supports.includes("P0-1") && entry.ok === true);
      return { criteria: [{ id: "P0-1", status: pass ? "PASS" : "FAIL", message: "" }], evidence: [] };
    }
  };
  const runtime = new AgentLoopRuntime(gateway, [verifier]);
  let state = await runtime.runTool(req({ supportsCriteria: ["P0-1"] }), baseState());
  state = await runtime.judge(state);
  const report = await runtime.deliver(state, "SUCCESS");
  assert.equal(report.status, "SUCCESS");
  assert.ok(audit.events.some((event) => event.type === "tool.completed"));
});
