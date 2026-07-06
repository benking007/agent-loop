export type ResultStatus =
  | "SUCCESS"
  | "PARTIAL"
  | "UNVERIFIED"
  | "BLOCKED"
  | "LIMITED"
  | "FAILED";

export type LoopStatus =
  | "PLANNING"
  | "ACTING"
  | "JUDGING"
  | "REPAIRING"
  | "VERIFYING"
  | ResultStatus;

export type Priority = "P0" | "P1" | "P2";
export type CriterionStatus = "PENDING" | "PASS" | "WARNING" | "FAIL" | "BLOCKED";
export type ToolCategory = "READ" | "WRITE" | "EXECUTE" | "EXTERNAL_ACTION" | "DESTRUCTIVE";

export const PERMISSION_FAILURE_ID = "runtime-permission";

export interface AcceptanceCriterion {
  id: string;
  priority: Priority;
  statement: string;
  evidenceRequired: string[];
  status: CriterionStatus;
}

export interface AcceptanceSpec {
  goal: string;
  deliverable: string;
  scope?: { in?: string[]; out?: string[] };
  criteria: AcceptanceCriterion[];
  risks?: string[];
  stopConditions?: Partial<Record<Lowercase<ResultStatus>, string>>;
}

export interface EvidenceEntry {
  id: string;
  timestamp: string;
  source: string;
  action?: string;
  /** Whether the underlying tool call succeeded. Preserved so verifiers can tell pass from fail. */
  ok?: boolean;
  summary: string;
  artifact?: string;
  supports: string[];
  risk?: string;
}

export interface Failure {
  criterionId: string;
  expected: string;
  actual: string;
  evidence: string;
  likelyCause?: string;
  repairPlan: string;
  attempts: number;
  /** A blocking failure (e.g. denied tool, missing approval) maps to BLOCKED, not FAILED. */
  blocking?: boolean;
}

export interface Budget {
  maxTurns: number;
  turnsUsed: number;
  maxRepairAttempts: number;
  maxCost?: number;
  costUsed?: number;
}

export interface TaskState {
  taskId: string;
  status: LoopStatus;
  goal: string;
  acceptanceSpec: AcceptanceSpec;
  decisions: string[];
  evidence: EvidenceEntry[];
  openFailures: Failure[];
  budget: Budget;
  nextAction: string;
}

export interface ToolRequest {
  id: string;
  name: string;
  category: ToolCategory;
  purpose: string;
  args: unknown;
  supportsCriteria?: string[];
  approvalRequired?: boolean;
}

export interface ToolResult {
  requestId: string;
  ok: boolean;
  summary: string;
  artifact?: string;
  raw?: unknown;
  evidenceFor?: string[];
  risk?: string;
  /** Optional cost of this tool call, charged against Budget.maxCost. */
  cost?: number;
}

export interface ApprovalDecision {
  approved: boolean;
  reason?: string;
}

export interface ToolGateway {
  canRun(request: ToolRequest, state: TaskState): Promise<ApprovalDecision>;
  run(request: ToolRequest, state: TaskState): Promise<ToolResult>;
}

export interface Verifier {
  name: string;
  verify(state: TaskState): Promise<{
    criteria: Array<{ id: string; status: CriterionStatus; evidence?: string; message: string }>;
    evidence: EvidenceEntry[];
  }>;
}

export interface Hooks {
  preToolUse?: (request: ToolRequest, state: TaskState) => Promise<void>;
  postToolUse?: (request: ToolRequest, result: ToolResult, state: TaskState) => Promise<EvidenceEntry[] | void>;
  preDeliver?: (
    state: TaskState,
    context: { requestedStatus?: ResultStatus; derivedStatus: ResultStatus }
  ) => Promise<void>;
  preCompact?: (state: TaskState) => Promise<Pick<TaskState, "goal" | "acceptanceSpec" | "evidence" | "openFailures" | "nextAction">>;
}

export interface ResultReport {
  status: ResultStatus;
  completed: string[];
  evidence: string[];
  verification: string[];
  remainingRisks: string[];
  nextStep?: string;
}

export class AgentLoopRuntime {
  private readonly gateway: ToolGateway;
  private readonly verifiers: Verifier[];
  private readonly hooks: Hooks;

  constructor(gateway: ToolGateway, verifiers: Verifier[], hooks: Hooks = {}) {
    this.gateway = gateway;
    this.verifiers = verifiers;
    this.hooks = hooks;
  }

  async runTool(request: ToolRequest, state: TaskState): Promise<TaskState> {
    await this.hooks.preToolUse?.(request, state);

    const decision = await this.gateway.canRun(request, state);
    if (!decision.approved) {
      // A single denied tool must NOT latch the whole task into a terminal state.
      // Record a recoverable, blocking failure so the model can request approval
      // or pick a safer tool, and still spend a turn so repeated denials cannot
      // spin forever (the turn budget eventually forces LIMITED).
      const spent = spendTurn(withPermissionBlock(state, request, decision.reason));
      if (spent.status === "LIMITED") return spent;
      return {
        ...spent,
        status: "REPAIRING",
        nextAction: `Tool ${request.name} was blocked: request approval or choose a safer tool.`
      };
    }

    const result = await this.gateway.run(request, state);
    let updated = appendToolEvidence(state, request, result);
    // A successful tool call means the model found a permitted path, so any prior
    // permission block is resolved and should be cleared automatically.
    if (updated.openFailures.some((failure) => failure.blocking)) {
      updated = { ...updated, openFailures: updated.openFailures.filter((failure) => !failure.blocking) };
    }
    const extraEvidence = await this.hooks.postToolUse?.(request, result, updated);
    if (extraEvidence?.length) {
      updated = { ...updated, evidence: [...updated.evidence, ...extraEvidence] };
    }
    return spendTurn(updated, result.cost ?? 0);
  }

  async judge(state: TaskState): Promise<TaskState> {
    let next = { ...state, status: "JUDGING" as LoopStatus };

    for (const verifier of this.verifiers) {
      const report = await verifier.verify(next);
      next = {
        ...next,
        evidence: [...next.evidence, ...report.evidence],
        acceptanceSpec: {
          ...next.acceptanceSpec,
          criteria: next.acceptanceSpec.criteria.map((criterion) => {
            const update = report.criteria.find((item) => item.id === criterion.id);
            return update ? { ...criterion, status: update.status } : criterion;
          })
        }
      };
    }

    // The runtime, not the model, owns repair-attempt counting and failure cleanup.
    next = reconcileFailures(next);

    return {
      ...next,
      status: deriveLoopStatus(next)
    };
  }

  /** Compress context while guaranteeing the essential loop state survives. */
  async compact(state: TaskState): Promise<TaskState> {
    if (!this.hooks.preCompact) return state;
    const preserved = await this.hooks.preCompact(state);
    return { ...state, ...preserved };
  }

  async deliver(state: TaskState, requestedStatus?: ResultStatus): Promise<ResultReport> {
    const status = deriveResultStatus(state);
    await this.hooks.preDeliver?.(state, { requestedStatus, derivedStatus: status });
    if (requestedStatus === "SUCCESS" && status !== "SUCCESS") {
      throw new Error(`PreDeliver blocked: requested SUCCESS but derived status is ${status}.`);
    }
    return {
      status,
      completed: state.acceptanceSpec.criteria
        .filter((criterion) => criterion.status === "PASS")
        .map((criterion) => `${criterion.id}: ${criterion.statement}`),
      evidence: state.evidence.map((entry) => `${entry.id}: ${entry.summary}`),
      verification: state.acceptanceSpec.criteria.map(
        (criterion) => `${criterion.id}: ${criterion.status} - ${criterion.statement}`
      ),
      remainingRisks: [
        ...(state.acceptanceSpec.risks ?? []),
        ...state.openFailures.map((failure) => `${failure.criterionId}: ${failure.actual}`)
      ],
      nextStep: state.nextAction
    };
  }
}

export function appendToolEvidence(state: TaskState, request: ToolRequest, result: ToolResult): TaskState {
  const entry: EvidenceEntry = {
    id: `ev-${state.evidence.length + 1}`,
    timestamp: new Date().toISOString(),
    source: request.name,
    action: request.purpose,
    ok: result.ok,
    summary: result.summary,
    artifact: result.artifact,
    supports: result.evidenceFor ?? request.supportsCriteria ?? [],
    risk: result.risk
  };

  return { ...state, evidence: [...state.evidence, entry] };
}

/** Attach or reinforce a recoverable permission block (deduplicated by criterion id). */
export function withPermissionBlock(state: TaskState, request: ToolRequest, reason?: string): TaskState {
  const actual = reason ?? "Tool denied by gateway.";
  const existing = state.openFailures.find(
    (failure) => failure.blocking && failure.criterionId === PERMISSION_FAILURE_ID
  );
  const openFailures = existing
    ? state.openFailures.map((failure) =>
        failure === existing ? { ...failure, attempts: failure.attempts + 1, actual } : failure
      )
    : [
        ...state.openFailures,
        {
          criterionId: PERMISSION_FAILURE_ID,
          expected: `Tool ${request.name} is permitted to run`,
          actual,
          evidence: "ToolGateway.canRun",
          repairPlan: "Request approval, choose a safer tool, or narrow scope, then retry.",
          attempts: 0,
          blocking: true
        }
      ];
  return { ...state, openFailures };
}

export function spendTurn(state: TaskState, cost = 0): TaskState {
  const turnsUsed = state.budget.turnsUsed + 1;
  const costUsed = (state.budget.costUsed ?? 0) + cost;
  const overTurns = turnsUsed >= state.budget.maxTurns;
  const overCost = state.budget.maxCost !== undefined && costUsed >= state.budget.maxCost;

  if ((overTurns || overCost) && !p0AllPass(state)) {
    return {
      ...state,
      status: "LIMITED",
      budget: { ...state.budget, turnsUsed, costUsed },
      nextAction:
        overCost && !overTurns
          ? "Cost budget exhausted before P0 acceptance passed."
          : "Turn budget exhausted before P0 acceptance passed."
    };
  }
  return { ...state, budget: { ...state.budget, turnsUsed, costUsed } };
}

/**
 * Runtime-owned bookkeeping for failures:
 * - drop failures whose criterion now passes,
 * - increment attempts for criteria still failing,
 * - auto-record a minimal failure for newly failing criteria,
 * so the "no infinite repair" stop condition does not depend on the model.
 */
export function reconcileFailures(state: TaskState): TaskState {
  const failing = new Set(
    state.acceptanceSpec.criteria.filter((c) => c.status === "FAIL").map((c) => c.id)
  );
  const resolved = new Set(
    state.acceptanceSpec.criteria
      .filter((c) => c.status === "PASS" || c.status === "WARNING")
      .map((c) => c.id)
  );

  let openFailures = state.openFailures.filter(
    (failure) => failure.blocking || !resolved.has(failure.criterionId)
  );

  const counted = new Set<string>();
  openFailures = openFailures.map((failure) => {
    if (!failure.blocking && failing.has(failure.criterionId)) {
      counted.add(failure.criterionId);
      return { ...failure, attempts: failure.attempts + 1 };
    }
    return failure;
  });

  for (const id of failing) {
    if (counted.has(id)) continue;
    const criterion = state.acceptanceSpec.criteria.find((c) => c.id === id);
    openFailures.push({
      criterionId: id,
      expected: criterion?.statement ?? "Criterion passes.",
      actual: "Verifier reported FAIL.",
      evidence: latestEvidenceIdFor(state, id) ?? "verifier",
      repairPlan: "Diagnose the failing criterion, apply a fix, then re-verify.",
      attempts: 0
    });
  }

  return { ...state, openFailures };
}

export function deriveLoopStatus(state: TaskState): LoopStatus {
  if (state.status === "LIMITED") return state.status;
  if (p0AllPass(state)) return "SUCCESS";
  if (state.openFailures.some((failure) => !failure.blocking && failure.attempts >= state.budget.maxRepairAttempts)) {
    return "FAILED";
  }
  if (state.acceptanceSpec.criteria.some((criterion) => criterion.status === "FAIL")) return "REPAIRING";
  if (hasUnresolvedBlock(state)) return "REPAIRING";
  return "VERIFYING";
}

export function deriveResultStatus(state: TaskState): ResultStatus {
  if (state.status === "LIMITED") return "LIMITED";
  if (state.status === "FAILED") return "FAILED";
  if (p0AllPass(state)) {
    return p1HasFailures(state) ? "PARTIAL" : "SUCCESS";
  }
  if (hasUnresolvedBlock(state)) return "BLOCKED";
  // P0 not proven and nothing is blocking: the honest status is "not verified",
  // never PARTIAL (which would over-claim usable output).
  return "UNVERIFIED";
}

export function p0AllPass(state: TaskState): boolean {
  const p0 = state.acceptanceSpec.criteria.filter((criterion) => criterion.priority === "P0");
  return p0.length > 0 && p0.every((criterion) => criterion.status === "PASS" && hasPositiveEvidenceFor(state, criterion.id));
}

export function p1HasFailures(state: TaskState): boolean {
  return state.acceptanceSpec.criteria.some(
    (criterion) => criterion.priority !== "P0" && ["FAIL", "BLOCKED", "PENDING"].includes(criterion.status)
  );
}

export function hasUnresolvedBlock(state: TaskState): boolean {
  return state.openFailures.some((failure) => failure.blocking);
}

export function hasEvidenceFor(state: TaskState, criterionId: string): boolean {
  return state.evidence.some((entry) => entry.supports.includes(criterionId));
}

export function hasPositiveEvidenceFor(state: TaskState, criterionId: string): boolean {
  return state.evidence.some((entry) => entry.supports.includes(criterionId) && entry.ok !== false);
}

export function latestEvidenceIdFor(state: TaskState, criterionId: string): string | undefined {
  for (let i = state.evidence.length - 1; i >= 0; i--) {
    if (state.evidence[i].supports.includes(criterionId)) return state.evidence[i].id;
  }
  return undefined;
}

export function hasAnyEvidence(state: TaskState): boolean {
  return state.evidence.length > 0;
}
