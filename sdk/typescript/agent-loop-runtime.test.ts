import { test } from "node:test";
import { strict as assert } from "node:assert";

import {
  AgentLoopRuntime,
  type AcceptanceCriterion,
  type EvidenceEntry,
  type Failure,
  type TaskState,
  type ToolGateway,
  type ToolRequest,
  type ToolResult,
  type Verifier,
  PERMISSION_FAILURE_ID,
  appendToolEvidence,
  deriveLoopStatus,
  deriveResultStatus,
  hasUnresolvedBlock,
  hasPositiveEvidenceFor,
  p0AllPass,
  reconcileFailures,
  spendTurn,
  withPermissionBlock
} from "./agent-loop-runtime.ts";

// --- Builders ------------------------------------------------------------

const crit = (
  o: Partial<AcceptanceCriterion> & Pick<AcceptanceCriterion, "id" | "priority" | "status">
): AcceptanceCriterion => ({ statement: "s", evidenceRequired: [], ...o });

const ev = (
  o: Partial<EvidenceEntry> & Pick<EvidenceEntry, "id" | "supports">
): EvidenceEntry => ({ timestamp: "t", source: "x", summary: "s", ...o });

const fail = (o: Partial<Failure> & Pick<Failure, "criterionId" | "attempts">): Failure => ({
  expected: "",
  actual: "",
  evidence: "",
  repairPlan: "",
  ...o
});

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

const denyGateway = (reason = "denied"): ToolGateway => ({
  async canRun() {
    return { approved: false, reason };
  },
  async run(r) {
    return { requestId: r.id, ok: true, summary: "should not run" };
  }
});

// --- p0AllPass -----------------------------------------------------------

test("p0AllPass: PASS with supporting evidence is true", () => {
  const s = baseState({
    acceptanceSpec: { goal: "g", deliverable: "d", criteria: [crit({ id: "P0-1", priority: "P0", status: "PASS" })] },
    evidence: [ev({ id: "ev-1", supports: ["P0-1"], ok: true })]
  });
  assert.equal(p0AllPass(s), true);
});

test("p0AllPass: PASS without evidence is false", () => {
  const s = baseState({
    acceptanceSpec: { goal: "g", deliverable: "d", criteria: [crit({ id: "P0-1", priority: "P0", status: "PASS" })] }
  });
  assert.equal(p0AllPass(s), false);
});

test("p0AllPass: PASS with only negative evidence is false", () => {
  const s = baseState({
    acceptanceSpec: { goal: "g", deliverable: "d", criteria: [crit({ id: "P0-1", priority: "P0", status: "PASS" })] },
    evidence: [ev({ id: "ev-1", supports: ["P0-1"], ok: false })]
  });
  assert.equal(hasPositiveEvidenceFor(s, "P0-1"), false);
  assert.equal(p0AllPass(s), false);
});

test("p0AllPass: spec with no P0 can never pass", () => {
  const s = baseState({
    acceptanceSpec: { goal: "g", deliverable: "d", criteria: [crit({ id: "P1-1", priority: "P1", status: "PASS" })] },
    evidence: [ev({ id: "ev-1", supports: ["P1-1"], ok: true })]
  });
  assert.equal(p0AllPass(s), false);
});

// --- deriveResultStatus --------------------------------------------------

test("deriveResultStatus: P0 pass, no P1 gap -> SUCCESS", () => {
  const s = baseState({
    acceptanceSpec: { goal: "g", deliverable: "d", criteria: [crit({ id: "P0-1", priority: "P0", status: "PASS" })] },
    evidence: [ev({ id: "ev-1", supports: ["P0-1"], ok: true })]
  });
  assert.equal(deriveResultStatus(s), "SUCCESS");
});

test("deriveResultStatus: P0 pass, P1 gap -> PARTIAL", () => {
  const s = baseState({
    acceptanceSpec: {
      goal: "g",
      deliverable: "d",
      criteria: [crit({ id: "P0-1", priority: "P0", status: "PASS" }), crit({ id: "P1-1", priority: "P1", status: "FAIL" })]
    },
    evidence: [ev({ id: "ev-1", supports: ["P0-1"], ok: true })]
  });
  assert.equal(deriveResultStatus(s), "PARTIAL");
});

test("deriveResultStatus: no P0 proof, no evidence -> UNVERIFIED (not PARTIAL)", () => {
  assert.equal(deriveResultStatus(baseState()), "UNVERIFIED");
});

test("deriveResultStatus: no P0 proof but blocking failure -> BLOCKED", () => {
  const s = baseState({ openFailures: [fail({ criterionId: PERMISSION_FAILURE_ID, attempts: 0, blocking: true })] });
  assert.equal(deriveResultStatus(s), "BLOCKED");
});

test("deriveResultStatus: P0 pass overrides a residual block -> SUCCESS", () => {
  const s = baseState({
    acceptanceSpec: { goal: "g", deliverable: "d", criteria: [crit({ id: "P0-1", priority: "P0", status: "PASS" })] },
    evidence: [ev({ id: "ev-1", supports: ["P0-1"], ok: true })],
    openFailures: [fail({ criterionId: PERMISSION_FAILURE_ID, attempts: 0, blocking: true })]
  });
  assert.equal(deriveResultStatus(s), "SUCCESS");
});

test("deriveResultStatus: LIMITED and FAILED pass through", () => {
  assert.equal(deriveResultStatus(baseState({ status: "LIMITED" })), "LIMITED");
  assert.equal(deriveResultStatus(baseState({ status: "FAILED" })), "FAILED");
});

// --- deriveLoopStatus ----------------------------------------------------

test("deriveLoopStatus: repeated failure hits FAILED at maxRepairAttempts", () => {
  const s = baseState({
    acceptanceSpec: { goal: "g", deliverable: "d", criteria: [crit({ id: "P0-1", priority: "P0", status: "FAIL" })] },
    openFailures: [fail({ criterionId: "P0-1", attempts: 2 })],
    budget: { maxTurns: 8, turnsUsed: 0, maxRepairAttempts: 2 }
  });
  assert.equal(deriveLoopStatus(s), "FAILED");
});

test("deriveLoopStatus: failing criterion below limit -> REPAIRING", () => {
  const s = baseState({
    acceptanceSpec: { goal: "g", deliverable: "d", criteria: [crit({ id: "P0-1", priority: "P0", status: "FAIL" })] },
    openFailures: [fail({ criterionId: "P0-1", attempts: 0 })]
  });
  assert.equal(deriveLoopStatus(s), "REPAIRING");
});

test("deriveLoopStatus: only a blocking failure -> REPAIRING (recoverable)", () => {
  const s = baseState({ openFailures: [fail({ criterionId: PERMISSION_FAILURE_ID, attempts: 0, blocking: true })] });
  assert.equal(deriveLoopStatus(s), "REPAIRING");
});

test("deriveLoopStatus: LIMITED is sticky", () => {
  assert.equal(deriveLoopStatus(baseState({ status: "LIMITED" })), "LIMITED");
});

// --- reconcileFailures ---------------------------------------------------

test("reconcileFailures: increments existing, records new, reclaims resolved, keeps blocking", () => {
  const s = baseState({
    acceptanceSpec: {
      goal: "g",
      deliverable: "d",
      criteria: [
        crit({ id: "A", priority: "P0", status: "FAIL" }),
        crit({ id: "B", priority: "P1", status: "PASS" }),
        crit({ id: "C", priority: "P1", status: "FAIL" })
      ]
    },
    openFailures: [
      fail({ criterionId: "A", attempts: 1 }),
      fail({ criterionId: "B", attempts: 0 }),
      fail({ criterionId: PERMISSION_FAILURE_ID, attempts: 0, blocking: true })
    ]
  });
  const out = reconcileFailures(s);
  assert.equal(out.openFailures.find((f) => f.criterionId === "A")!.attempts, 2);
  assert.equal(out.openFailures.some((f) => f.criterionId === "B"), false);
  assert.equal(out.openFailures.find((f) => f.criterionId === "C")!.attempts, 0);
  assert.ok(out.openFailures.some((f) => f.blocking));
});

// --- spendTurn -----------------------------------------------------------

test("spendTurn: turn budget exhausted without P0 -> LIMITED", () => {
  const out = spendTurn(baseState({ budget: { maxTurns: 1, turnsUsed: 0, maxRepairAttempts: 2 } }));
  assert.equal(out.status, "LIMITED");
});

test("spendTurn: budget exhausted but P0 passed -> not LIMITED", () => {
  const s = baseState({
    acceptanceSpec: { goal: "g", deliverable: "d", criteria: [crit({ id: "P0-1", priority: "P0", status: "PASS" })] },
    evidence: [ev({ id: "ev-1", supports: ["P0-1"], ok: true })],
    budget: { maxTurns: 1, turnsUsed: 0, maxRepairAttempts: 2 }
  });
  assert.notEqual(spendTurn(s).status, "LIMITED");
});

test("spendTurn: cost budget exhausted -> LIMITED", () => {
  const s = baseState({ budget: { maxTurns: 100, turnsUsed: 0, maxRepairAttempts: 2, maxCost: 5, costUsed: 0 } });
  const out = spendTurn(s, 5);
  assert.equal(out.status, "LIMITED");
  assert.equal(out.budget.costUsed, 5);
});

// --- appendToolEvidence --------------------------------------------------

test("appendToolEvidence: preserves ok and binds supports", () => {
  const s = appendToolEvidence(baseState(), req({ supportsCriteria: ["P0-1"] }), {
    requestId: "r1",
    ok: false,
    summary: "nope"
  });
  const e = s.evidence.at(-1)!;
  assert.equal(e.ok, false);
  assert.deepEqual(e.supports, ["P0-1"]);
});

// --- withPermissionBlock -------------------------------------------------

test("withPermissionBlock: adds once, then increments attempts on repeat", () => {
  const first = withPermissionBlock(baseState(), req(), "no");
  assert.equal(first.openFailures.filter((f) => f.blocking).length, 1);
  const second = withPermissionBlock(first, req(), "still no");
  assert.equal(second.openFailures.filter((f) => f.blocking).length, 1);
  assert.equal(second.openFailures.find((f) => f.blocking)!.attempts, 1);
});

// --- runTool -------------------------------------------------------------

test("runTool: denied tool is recoverable (REPAIRING), not terminal BLOCKED", async () => {
  const rt = new AgentLoopRuntime(denyGateway("nope"), []);
  const s = await rt.runTool(req({ category: "DESTRUCTIVE" }), baseState());
  assert.equal(s.status, "REPAIRING");
  assert.equal(s.budget.turnsUsed, 1);
  assert.ok(hasUnresolvedBlock(s));
});

test("runTool: success clears a prior block and preserves ok", async () => {
  const rt = new AgentLoopRuntime(allowGateway({ ok: true, summary: "done", evidenceFor: ["P0-1"] }), []);
  const start = withPermissionBlock(baseState(), req(), "earlier deny");
  assert.ok(hasUnresolvedBlock(start));
  const s = await rt.runTool(req(), start);
  assert.equal(hasUnresolvedBlock(s), false);
  assert.equal(s.evidence.at(-1)!.ok, true);
});

test("runTool: cost from tool result is charged", async () => {
  const rt = new AgentLoopRuntime(allowGateway({ cost: 3 }), []);
  const s = await rt.runTool(req(), baseState({ budget: { maxTurns: 8, turnsUsed: 0, maxRepairAttempts: 2, maxCost: 10, costUsed: 0 } }));
  assert.equal(s.budget.costUsed, 3);
});

test("runTool: postToolUse can return extra evidence", async () => {
  const rt = new AgentLoopRuntime(allowGateway(), [], {
    async postToolUse() {
      return [ev({ id: "ev-extra", source: "postToolUse", supports: ["P0-1"], ok: true })];
    }
  });
  const s = await rt.runTool(req(), baseState());
  assert.ok(s.evidence.some((entry) => entry.id === "ev-extra"));
});

// --- judge ---------------------------------------------------------------

test("judge: verifier PASS with evidence -> SUCCESS", async () => {
  const verifier: Verifier = {
    name: "v",
    async verify() {
      return { criteria: [{ id: "P0-1", status: "PASS", message: "" }], evidence: [] };
    }
  };
  const rt = new AgentLoopRuntime(allowGateway(), [verifier]);
  const s = await rt.judge(baseState({ evidence: [ev({ id: "ev-1", supports: ["P0-1"], ok: true })] }));
  assert.equal(s.status, "SUCCESS");
});

// --- compact -------------------------------------------------------------

test("compact: preCompact hook preserves essentials", async () => {
  let called = false;
  const rt = new AgentLoopRuntime(allowGateway(), [], {
    async preCompact(state) {
      called = true;
      return {
        goal: state.goal,
        acceptanceSpec: state.acceptanceSpec,
        evidence: state.evidence,
        openFailures: state.openFailures,
        nextAction: "compacted"
      };
    }
  });
  const out = await rt.compact(baseState());
  assert.ok(called);
  assert.equal(out.nextAction, "compacted");
});

// --- regression: the headline anti-pattern -------------------------------

test("regression: failing tests never deliver SUCCESS", async () => {
  const failGateway: ToolGateway = {
    async canRun() {
      return { approved: true };
    },
    async run(r) {
      return { requestId: r.id, ok: false, summary: "FAILED: 3 tests failed, 2 passed." };
    }
  };
  const verifier: Verifier = {
    name: "coding-tests",
    async verify(state) {
      const pass = state.evidence.some((e) => e.source === "run_tests" && e.ok === true);
      return { criteria: [{ id: "P0-1", status: pass ? "PASS" : "FAIL", message: "" }], evidence: [] };
    }
  };
  const rt = new AgentLoopRuntime(failGateway, [verifier]);
  let s = await rt.runTool(req({ supportsCriteria: ["P0-1"] }), baseState());
  s = await rt.judge(s);
  const report = await rt.deliver(s);
  assert.notEqual(report.status, "SUCCESS");
});

test("deliver: requested SUCCESS is blocked when derived status is not SUCCESS, but normal delivery is allowed", async () => {
  const rt = new AgentLoopRuntime(allowGateway(), [], {
    async preDeliver(_state, context) {
      if (context.requestedStatus === "SUCCESS" && context.derivedStatus !== "SUCCESS") {
        throw new Error(`blocked ${context.derivedStatus}`);
      }
    }
  });
  const state = baseState();
  const report = await rt.deliver(state);
  assert.equal(report.status, "UNVERIFIED");
  await assert.rejects(() => rt.deliver(state, "SUCCESS"), /blocked UNVERIFIED/);
});
