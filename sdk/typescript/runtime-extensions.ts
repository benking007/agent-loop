import {
  type ApprovalDecision,
  type CriterionStatus,
  type TaskState,
  type ToolCategory,
  type ToolGateway,
  type ToolRequest,
  type ToolResult,
  type Verifier
} from "./agent-loop-runtime.ts";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface StoredTaskState {
  state: TaskState;
  version: number;
  updatedAt: string;
}

export interface TaskStateStore {
  load(taskId: string): Promise<StoredTaskState | undefined>;
  save(state: TaskState, expectedVersion?: number): Promise<StoredTaskState>;
}

export class VersionConflictError extends Error {
  readonly taskId: string;
  readonly expectedVersion: number;
  readonly actualVersion: number;

  constructor(taskId: string, expectedVersion: number, actualVersion: number) {
    super(`Version conflict for task ${taskId}: expected ${expectedVersion}, got ${actualVersion}.`);
    this.taskId = taskId;
    this.expectedVersion = expectedVersion;
    this.actualVersion = actualVersion;
  }
}

export class InMemoryTaskStateStore implements TaskStateStore {
  private readonly tasks = new Map<string, StoredTaskState>();

  async load(taskId: string): Promise<StoredTaskState | undefined> {
    const stored = this.tasks.get(taskId);
    return stored ? clone(stored) : undefined;
  }

  async save(state: TaskState, expectedVersion?: number): Promise<StoredTaskState> {
    const current = this.tasks.get(state.taskId);
    if (expectedVersion !== undefined && (current?.version ?? 0) !== expectedVersion) {
      throw new VersionConflictError(state.taskId, expectedVersion, current?.version ?? 0);
    }
    const stored: StoredTaskState = {
      state: clone(state),
      version: (current?.version ?? 0) + 1,
      updatedAt: new Date().toISOString()
    };
    this.tasks.set(state.taskId, stored);
    return clone(stored);
  }
}

export class FileTaskStateStore implements TaskStateStore {
  private readonly rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = rootDir;
  }

  async load(taskId: string): Promise<StoredTaskState | undefined> {
    try {
      return JSON.parse(await readFile(this.pathFor(taskId), "utf8")) as StoredTaskState;
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  }

  async save(state: TaskState, expectedVersion?: number): Promise<StoredTaskState> {
    const current = await this.load(state.taskId);
    if (expectedVersion !== undefined && (current?.version ?? 0) !== expectedVersion) {
      throw new VersionConflictError(state.taskId, expectedVersion, current?.version ?? 0);
    }

    const stored: StoredTaskState = {
      state: clone(state),
      version: (current?.version ?? 0) + 1,
      updatedAt: new Date().toISOString()
    };
    const path = this.pathFor(state.taskId);
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, `${JSON.stringify(stored, null, 2)}\n`, "utf8");
    await rename(tmp, path);
    return clone(stored);
  }

  private pathFor(taskId: string): string {
    return join(this.rootDir, `${encodeURIComponent(taskId)}.json`);
  }
}

export type AuditEventType =
  | "tool.requested"
  | "tool.allowed"
  | "tool.denied"
  | "tool.completed"
  | "tool.failed"
  | "state.saved"
  | "verifier.registered"
  | "verifier.completed"
  | "verifier.failed";

export interface AuditEvent {
  id: string;
  timestamp: string;
  taskId?: string;
  type: AuditEventType;
  summary: string;
  metadata?: Record<string, unknown>;
}

export interface AuditSink {
  record(event: AuditEvent): Promise<void>;
}

export class InMemoryAuditSink implements AuditSink {
  readonly events: AuditEvent[] = [];

  async record(event: AuditEvent): Promise<void> {
    this.events.push(clone(event));
  }
}

export class JsonlAuditSink implements AuditSink {
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async record(event: AuditEvent): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(event)}\n`, { encoding: "utf8", flag: "a" });
  }
}

export class AuditedTaskStateStore implements TaskStateStore {
  private readonly inner: TaskStateStore;
  private readonly audit: AuditSink;

  constructor(inner: TaskStateStore, audit: AuditSink) {
    this.inner = inner;
    this.audit = audit;
  }

  async load(taskId: string): Promise<StoredTaskState | undefined> {
    return this.inner.load(taskId);
  }

  async save(state: TaskState, expectedVersion?: number): Promise<StoredTaskState> {
    const stored = await this.inner.save(state, expectedVersion);
    await this.audit.record({
      id: auditId(),
      timestamp: new Date().toISOString(),
      taskId: state.taskId,
      type: "state.saved",
      summary: `Saved task state version ${stored.version}.`,
      metadata: { status: state.status, expectedVersion }
    });
    return stored;
  }
}

export interface ToolPolicy {
  defaultDecision: "allow" | "deny";
  categoryDecisions?: Partial<Record<ToolCategory, "allow" | "deny" | "approvalRequired">>;
  allowedTools?: string[];
  deniedTools?: string[];
  approvalRequiredTools?: string[];
}

export class PolicyToolGateway implements ToolGateway {
  private readonly inner: ToolGateway;
  private readonly policy: ToolPolicy;

  constructor(inner: ToolGateway, policy: ToolPolicy) {
    this.inner = inner;
    this.policy = policy;
  }

  async canRun(request: ToolRequest, state: TaskState): Promise<ApprovalDecision> {
    const policyDecision = decideToolPolicy(request, this.policy);
    if (policyDecision !== "allow") {
      return {
        approved: false,
        reason:
          policyDecision === "approvalRequired"
            ? `Tool ${request.name} requires approval by policy.`
            : `Tool ${request.name} denied by policy.`
      };
    }
    return this.inner.canRun(request, state);
  }

  async run(request: ToolRequest, state: TaskState): Promise<ToolResult> {
    return this.inner.run(request, state);
  }
}

export class AuditedToolGateway implements ToolGateway {
  private readonly inner: ToolGateway;
  private readonly audit: AuditSink;

  constructor(inner: ToolGateway, audit: AuditSink) {
    this.inner = inner;
    this.audit = audit;
  }

  async canRun(request: ToolRequest, state: TaskState): Promise<ApprovalDecision> {
    await this.audit.record({
      id: auditId(),
      timestamp: new Date().toISOString(),
      taskId: state.taskId,
      type: "tool.requested",
      summary: `Tool requested: ${request.name}.`,
      metadata: { category: request.category, purpose: request.purpose }
    });
    const decision = await this.inner.canRun(request, state);
    await this.audit.record({
      id: auditId(),
      timestamp: new Date().toISOString(),
      taskId: state.taskId,
      type: decision.approved ? "tool.allowed" : "tool.denied",
      summary: decision.approved ? `Tool allowed: ${request.name}.` : `Tool denied: ${request.name}.`,
      metadata: { reason: decision.reason }
    });
    return decision;
  }

  async run(request: ToolRequest, state: TaskState): Promise<ToolResult> {
    try {
      const result = await this.inner.run(request, state);
      await this.audit.record({
        id: auditId(),
        timestamp: new Date().toISOString(),
        taskId: state.taskId,
        type: result.ok ? "tool.completed" : "tool.failed",
        summary: result.summary,
        metadata: { tool: request.name, ok: result.ok, cost: result.cost }
      });
      return result;
    } catch (error) {
      await this.audit.record({
        id: auditId(),
        timestamp: new Date().toISOString(),
        taskId: state.taskId,
        type: "tool.failed",
        summary: `Tool threw: ${request.name}.`,
        metadata: { error: error instanceof Error ? error.message : String(error) }
      });
      throw error;
    }
  }
}

export class VerifierRegistry {
  private readonly verifiers = new Map<string, Verifier>();
  private readonly audit?: AuditSink;

  constructor(audit?: AuditSink) {
    this.audit = audit;
  }

  async register(verifier: Verifier): Promise<void> {
    if (this.verifiers.has(verifier.name)) {
      throw new Error(`Verifier already registered: ${verifier.name}.`);
    }
    this.verifiers.set(verifier.name, verifier);
    await this.audit?.record({
      id: auditId(),
      timestamp: new Date().toISOString(),
      type: "verifier.registered",
      summary: `Registered verifier: ${verifier.name}.`
    });
  }

  get(name: string): Verifier {
    const verifier = this.verifiers.get(name);
    if (!verifier) throw new Error(`Unknown verifier: ${name}.`);
    return verifier;
  }

  select(names: string[]): Verifier[] {
    return names.map((name) => this.get(name));
  }

  all(): Verifier[] {
    return [...this.verifiers.values()];
  }
}

export interface CommandRunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode?: number;
}

export interface CommandRunner {
  run(command: string, args: string[], options?: { cwd?: string; timeoutMs?: number }): Promise<CommandRunResult>;
}

export interface CommandVerifierConfig {
  name: string;
  criterionId: string;
  command: string;
  args?: string[];
  cwd?: string;
  timeoutMs?: number;
  passStatus?: CriterionStatus;
  failStatus?: CriterionStatus;
}

export class CommandVerifier implements Verifier {
  readonly name: string;
  private readonly config: CommandVerifierConfig;
  private readonly runner: CommandRunner;
  private readonly audit?: AuditSink;

  constructor(
    config: CommandVerifierConfig,
    runner: CommandRunner,
    audit?: AuditSink
  ) {
    this.config = config;
    this.runner = runner;
    this.audit = audit;
    this.name = config.name;
  }

  async verify(state: TaskState): Promise<{
    criteria: Array<{ id: string; status: CriterionStatus; evidence?: string; message: string }>;
    evidence: TaskState["evidence"];
  }> {
    try {
      const result = await this.runner.run(this.config.command, this.config.args ?? [], {
        cwd: this.config.cwd,
        timeoutMs: this.config.timeoutMs
      });
      const evidenceId = `ev-${state.evidence.length + 1}`;
      await this.audit?.record({
        id: auditId(),
        timestamp: new Date().toISOString(),
        taskId: state.taskId,
        type: result.ok ? "verifier.completed" : "verifier.failed",
        summary: `Verifier ${this.name} ${result.ok ? "passed" : "failed"}.`,
        metadata: { command: this.config.command, args: this.config.args ?? [], exitCode: result.exitCode }
      });
      return {
        criteria: [
          {
            id: this.config.criterionId,
            status: result.ok ? this.config.passStatus ?? "PASS" : this.config.failStatus ?? "FAIL",
            evidence: evidenceId,
            message: summarizeCommandResult(result)
          }
        ],
        evidence: [
          {
            id: evidenceId,
            timestamp: new Date().toISOString(),
            source: this.name,
            action: `${this.config.command} ${(this.config.args ?? []).join(" ")}`.trim(),
            ok: result.ok,
            summary: summarizeCommandResult(result),
            supports: [this.config.criterionId],
            risk: result.ok ? undefined : "Command verifier failed."
          }
        ]
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.audit?.record({
        id: auditId(),
        timestamp: new Date().toISOString(),
        taskId: state.taskId,
        type: "verifier.failed",
        summary: `Verifier ${this.name} threw.`,
        metadata: { error: message }
      });
      return {
        criteria: [{ id: this.config.criterionId, status: this.config.failStatus ?? "FAIL", message }],
        evidence: [
          {
            id: `ev-${state.evidence.length + 1}`,
            timestamp: new Date().toISOString(),
            source: this.name,
            ok: false,
            summary: message,
            supports: [this.config.criterionId],
            risk: "Command verifier threw before producing a normal result."
          }
        ]
      };
    }
  }
}

export function decideToolPolicy(
  request: Pick<ToolRequest, "name" | "category" | "approvalRequired">,
  policy: ToolPolicy
): "allow" | "deny" | "approvalRequired" {
  if (policy.deniedTools?.includes(request.name)) return "deny";
  if (policy.approvalRequiredTools?.includes(request.name) || request.approvalRequired) {
    return "approvalRequired";
  }
  if (policy.allowedTools?.includes(request.name)) return "allow";
  const categoryDecision = policy.categoryDecisions?.[request.category];
  if (categoryDecision) return categoryDecision;
  return policy.defaultDecision;
}

export function mergeTaskStates(base: TaskState, incoming: TaskState): TaskState {
  if (base.taskId !== incoming.taskId) {
    throw new Error(`Cannot merge different tasks: ${base.taskId} and ${incoming.taskId}.`);
  }
  return {
    ...incoming,
    decisions: uniqueStrings([...base.decisions, ...incoming.decisions]),
    evidence: uniqueById([...base.evidence, ...incoming.evidence]),
    openFailures: uniqueFailures([...base.openFailures, ...incoming.openFailures])
  };
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function uniqueById<T extends { id: string }>(values: T[]): T[] {
  const byId = new Map<string, T>();
  for (const value of values) byId.set(value.id, value);
  return [...byId.values()];
}

function uniqueFailures(values: TaskState["openFailures"]): TaskState["openFailures"] {
  const byId = new Map<string, TaskState["openFailures"][number]>();
  for (const value of values) byId.set(value.criterionId, value);
  return [...byId.values()];
}

function auditId(): string {
  return `audit-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function summarizeCommandResult(result: CommandRunResult): string {
  const firstOutputLine = (result.stdout || result.stderr).split(/\r?\n/).find((line) => line.trim().length > 0);
  const suffix = result.exitCode === undefined ? "" : ` (exit ${result.exitCode})`;
  return `${result.ok ? "PASS" : "FAIL"}${suffix}${firstOutputLine ? `: ${firstOutputLine.slice(0, 240)}` : ""}`;
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ENOENT";
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
