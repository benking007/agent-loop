import {
  AgentLoopRuntime,
  type TaskState,
  type ToolGateway,
  type ToolRequest,
  type ToolResult,
  type Verifier
} from "./agent-loop-runtime.ts";

const gateway: ToolGateway = {
  async canRun(request: ToolRequest) {
    if (request.category === "DESTRUCTIVE" || request.category === "EXTERNAL_ACTION") {
      return { approved: false, reason: `${request.category} requires explicit approval.` };
    }
    return { approved: true };
  },

  async run(request: ToolRequest): Promise<ToolResult> {
    // Replace this with real shell, browser, source-control, or MCP tool adapters.
    // Try flipping `ok` to false and you will see the loop refuse to report SUCCESS.
    return {
      requestId: request.id,
      ok: true,
      summary: `Simulated ${request.name} completed.`,
      evidenceFor: request.supportsCriteria
    };
  }
};

const testsVerifier: Verifier = {
  name: "coding-tests",
  async verify(state: TaskState) {
    // Check that tests were run AND passed. Presence of a run_tests entry is not
    // enough: a failed test run also produces evidence, so we must inspect `ok`.
    const passingTestEvidence = state.evidence.some(
      (entry) => entry.source === "run_tests" && entry.ok === true
    );
    const failingTestEvidence = state.evidence.some(
      (entry) => entry.source === "run_tests" && entry.ok === false
    );
    return {
      criteria: [
        {
          id: "P0-tests-pass",
          status: passingTestEvidence ? "PASS" : "FAIL",
          evidence: passingTestEvidence ? "run_tests passed" : undefined,
          message: passingTestEvidence
            ? "Tests were run and passed."
            : failingTestEvidence
              ? "Tests were run but failed."
              : "No passing test evidence found."
        }
      ],
      evidence: passingTestEvidence
        ? []
        : [
            {
              id: `ev-${state.evidence.length + 1}`,
              timestamp: new Date().toISOString(),
              source: "coding-tests",
              ok: false,
              summary: failingTestEvidence
                ? "Verifier found failing test evidence."
                : "Verifier did not find passing test evidence.",
              supports: ["P0-tests-pass"],
              risk: "Cannot claim coding task success without passing test evidence."
            }
          ]
    };
  }
};

const runtime = new AgentLoopRuntime(gateway, [testsVerifier], {
  async preDeliver(_state, context) {
    if (context.requestedStatus === "SUCCESS" && context.derivedStatus !== "SUCCESS") {
      throw new Error(`PreDeliver blocked: requested SUCCESS but derived status is ${context.derivedStatus}.`);
    }
  }
});

const initialState: TaskState = {
  taskId: "coding-demo",
  status: "PLANNING",
  goal: "Implement a safe code change and prove it works.",
  acceptanceSpec: {
    goal: "Implement a safe code change and prove it works.",
    deliverable: "Patch plus verification report.",
    criteria: [
      {
        id: "P0-tests-pass",
        priority: "P0",
        statement: "Relevant tests pass after the change.",
        evidenceRequired: ["test output"],
        status: "PENDING"
      }
    ],
    risks: ["Example gateway simulates execution; replace with a real adapter."]
  },
  decisions: [],
  evidence: [],
  openFailures: [],
  budget: { maxTurns: 8, turnsUsed: 0, maxRepairAttempts: 2 },
  nextAction: "Run relevant tests."
};

async function demo() {
  const afterTool = await runtime.runTool(
    {
      id: "tool-1",
      name: "run_tests",
      category: "EXECUTE",
      purpose: "Run relevant tests after implementation.",
      args: { command: "npm test" },
      supportsCriteria: ["P0-tests-pass"]
    },
    initialState
  );

  const judged = await runtime.judge(afterTool);

  try {
    const report = await runtime.deliver(judged, "SUCCESS");
    console.log(JSON.stringify(report, null, 2));
  } catch (err) {
    // The preDeliver gate refused a premature SUCCESS. This is the loop working
    // as intended: a failing or unverified P0 must never be delivered as done.
    console.log(
      JSON.stringify(
        {
          status: judged.status,
          blockedBy: (err as Error).message,
          openFailures: judged.openFailures
        },
        null,
        2
      )
    );
  }
}

demo();
