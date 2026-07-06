# Agent Loop Runtime — 架构说明

> 本文面向想要理解或接入本套件的工程师,力求让读者一目了然:它的**原理**、**工作模式**、**优缺点**。
> 对应实现见 `sdk/typescript/agent-loop-runtime.ts`,可运行示例见 `sdk/typescript/example-coding-agent.ts`。

---

## 1. 一句话定位

这是一套把"**Agent 可靠工作方法论**"固化成**可复用工程构件**的启动套件:契约(Skill)+ 运行时骨架(SDK)+ 权限网关 + 钩子 + 校验器 + 持久化状态 + 审计 + 模板 + JSON Schema。它不是一个能独立运行的应用,而是一层**可被任意通用 Agent 接入的"可靠性护栏"**。

它要解决的核心痛点是:**大模型倾向于"产出了文字就宣布完成",而不是"用证据证明完成"。**

---

## 2. 核心理念

```
不要指望模型"记得"要小心;
把这套循环写进运行时状态、钩子、权限、校验器和结果状态里。
```

换句话说,可靠性不靠提示词里的"请务必仔细",而靠**代码层面的确定性闸门**。凡是"模型可能忘、可能骗"的环节,都下沉为运行时机制:

- 该不该记录证据 → 由 `postToolUse` / 落账函数强制,不靠模型自觉。
- 能不能宣布成功 → 由状态机 `deriveResultStatus` 派生,且只能由非失败证据支撑,不靠模型自称。
- 危险动作能不能执行 → 由 `ToolGateway` 审批,不靠模型克制。
- 修复能不能无限重试 → 由运行时计数 `attempts` 并强制 `FAILED`,不靠模型止损。
- 任务状态能不能恢复 → 由 `TaskStateStore` 版本化保存,不靠上下文记忆。
- 工具执行能不能回放 → 由 `AuditSink` 记录,不靠最终报告口述。

---

## 3. 分层架构

套件按"软约束(教模型怎么想)+ 硬约束(用代码强制执行)"分层:

```
                 ┌───────────────── 软约束(引导) ─────────────────┐
User Task ─────► │ Skill (SKILL.md)  循环协议 + 交付纪律              │
                 │ Templates         验收单 / 证据台账 / 失败 / 交付   │
                 └───────────────────────────────────────────────────┘
                             │  (模型据此驱动循环)
                             ▼
                 ┌───────────────── 硬约束(强制) ─────────────────┐
                 │ AgentLoopRuntime   状态机 + 状态派生 + 预算         │
                 │   ├─ ToolGateway   工具权限 & 审批                  │
                 │   ├─ Hooks         preToolUse/postToolUse/          │
                 │   │                 preDeliver/preCompact           │
                 │   ├─ Verifiers     领域校验器(测试/来源/schema…)  │
                 │   ├─ Evidence      证据台账(每次工具结果落账)     │
                 │   ├─ Store/Audit   状态持久化 + 工具/状态审计       │
                 │   └─ Result Report 终态派生 + 交付报告              │
                 └───────────────────────────────────────────────────┘
                             │
                             ▼
                 SUCCESS / PARTIAL / UNVERIFIED / BLOCKED / LIMITED / FAILED
```

**各关注点应放在哪(以及由谁保证):**

| 关注点 | 落点 | 为什么 |
|---|---|---|
| 工作原则/协议 | Skill / 系统提示 | 模型需要知道循环怎么走 |
| 任务状态 | SDK 运行时 `TaskState` | 必须跨轮次持久化 |
| 工具权限 | Tool Gateway / 沙箱 | 必须可强制执行 |
| 审批 | 宿主应用 / 网关 | 高风险动作需人工审 |
| 证据采集 | 落账函数 / postToolUse | 不能靠模型"记得记录" |
| 状态持久化 | TaskStateStore | 支持跨轮恢复、并发版本控制 |
| 审计 | AuditSink | 支持回放、追责、事故分析 |
| P0 交付闸门 | preDeliver 钩子 + 状态派生 | 阻止虚假成功 |
| 验证 | 外部工具(verifier) | 必须触达真实环境 |
| 最终状态 | 运行时状态机 | 消灭含糊的"done" |

---

## 4. 数据模型

一切围绕一个可持久化的 `TaskState`:

```ts
interface TaskState {
  taskId: string;
  status: LoopStatus;          // 过程态或终态
  goal: string;
  acceptanceSpec: AcceptanceSpec; // 可量化的"完成"定义
  decisions: string[];
  evidence: EvidenceEntry[];   // 证据台账(只增)
  openFailures: Failure[];     // 未解决的失败(运行时会回收)
  budget: Budget;              // 轮次/修复次数/成本 上限
  nextAction: string;
}
```

关键从属类型:

- **AcceptanceSpec / AcceptanceCriterion**:把目标翻译成分级验收标准,每条带 `priority`(P0/P1/P2)、`evidenceRequired`、`status`。**P0 是必须通过项**。
- **EvidenceEntry**:证据条目。关键字段:
  - `supports: string[]` —— 声明"这条证据支撑哪几条验收标准"(证据 ↔ 标准的多对多绑定)。
  - `ok?: boolean` —— **保留底层工具调用的成败信号**,让校验器能区分"跑过"和"跑通";`ok === false` 的证据不能支撑 P0 成功。
- **Failure**:失败记录。`attempts` 由运行时计数;`blocking?: boolean` 标记"权限/审批类阻断"(映射到 `BLOCKED` 而非 `FAILED`)。
- **Budget**:`maxTurns / maxRepairAttempts / maxCost` 三个维度的上界。

---

## 5. 状态机:两级状态

### 5.1 两级设计

- **过程态 `LoopStatus`**:`PLANNING / ACTING / JUDGING / REPAIRING / VERIFYING`。
- **终态 `ResultStatus`**:交付时必须落到的 6 种之一。

最大价值在于**诚实的非成功态**,专门对抗"什么都说成功":

| 终态 | 含义 |
|---|---|
| `SUCCESS` | P0 全部通过且有证据 |
| `PARTIAL` | P0 通过,但有已知的非 P0 缺口 |
| `UNVERIFIED` | 有产出,但缺少必要验证 |
| `BLOCKED` | 缺权限/数据/审批,无法推进 |
| `LIMITED` | 轮次/成本/时间预算耗尽 |
| `FAILED` | 修复已尝试,P0 仍失败 |

### 5.2 状态派生规则(纯函数,可测)

**过程态派生 `deriveLoopStatus`**(每次 `judge` 后计算,优先级从上到下):

1. `LIMITED` 粘性透传;
2. **P0 全过 → `SUCCESS`**(优先于一切,修复成功可翻盘);
3. 存在"非阻断失败且 `attempts >= maxRepairAttempts`" → `FAILED`;
4. 有 criterion 处于 `FAIL` → `REPAIRING`;
5. 仅有阻断失败 → `REPAIRING`(可恢复,提示换工具/申请审批);
6. 否则 → `VERIFYING`。

**终态派生 `deriveResultStatus`**(`deliver` 时计算):

1. `LIMITED` / `FAILED` 透传;
2. **P0 全过** → 有非 P0 缺口则 `PARTIAL`,否则 `SUCCESS`;
3. 否则:存在阻断 → `BLOCKED`;
4. 否则 → `UNVERIFIED`(P0 未证明且无阻断,诚实地报"未验证",**绝不**报 PARTIAL 以免过度声称)。

**成功闸门 `p0AllPass`**(全项目最精髓的一条):

```ts
// 必须存在 P0,且每条 P0 都 PASS 且有非失败证据支撑
p0.length > 0 && p0.every(c => c.status === "PASS" && hasPositiveEvidenceFor(state, c.id))
```

> 含义:**没有 P0 正向证据,就永远拿不到 SUCCESS。** 注意反面:一个没有定义任何 P0 的 spec 将永远无法 `SUCCESS`——这是刻意的"强制定义 P0"设计,接入时务必为任务设置 P0。

状态流转示意:

```
        judge / verifier 打分
PLANNING ─► ACTING ─► JUDGING ─┬─ P0 全过 ───────────────► SUCCESS / PARTIAL
                               ├─ 有 FAIL ─► REPAIRING ─► (修复) ─► judge…
                               │                 └─ attempts≥上限 ─► FAILED
                               ├─ 仅阻断 ─► REPAIRING ─► (换工具成功自动解阻断)
                               └─ 待验证 ─► VERIFYING
预算耗尽(任意时刻) ─────────────────────────────────────► LIMITED
deliver 时仍有阻断且 P0 未过 ───────────────────────────► BLOCKED
```

---

## 6. 工作模式:一次任务的生命周期

`AgentLoopRuntime` 只暴露 4 个动作,循环由调用方(模型)驱动:

| 方法 | 职责 | 关键行为 |
|---|---|---|
| `runTool` | 执行一次工具调用 | preToolUse → `canRun`(拒则记录**可恢复**阻断 + 扣一轮)→ `run` → **落账(含 ok)** → 成功则清除历史阻断 → postToolUse 可补充派生证据 → 扣预算(轮次+成本) |
| `judge` | 对照验收标准判定 | 跑 verifier 更新各 criterion → `reconcileFailures`(运行时计数/回收失败)→ `deriveLoopStatus` |
| `compact` | 压缩上下文 | 调用 `preCompact`,保证 Goal/Spec/Evidence/OpenFailures/NextAction 被保留 |
| `deliver` | 产出交付报告 | `deriveResultStatus` → preDeliver 校验请求状态 → 汇总报告 |

完整循环:

```
Configure ─ 确定可用工具/审批点/预算/停止条件
Goal ───── 复述用户真实目标
Spec ───── 目标 → P0/P1 验收标准
Plan ───── 选"最短的、能产出证据"的路径
   │
   ▼  while (!isTerminal)
   ├─ Act     runtime.runTool()   # 权限 + 落账 + 预算,均由运行时强制
   ├─ Judge   runtime.judge()     # verifier 打分 + 失败计数/回收
   ├─ Repair  (模型) 只修有证据支撑的失败
   ├─ Verify  runtime.judge()     # 修完重判
   └─ Compact runtime.compact()   # 需要时压缩上下文并保关键状态
   │
Deliver ── runtime.deliver()      # 闸门 + 终态派生 + 报告
```

**责任边界**(接入时务必分清):

- **运行时(代码)负责**:证据落账(含 `ok`)、修复次数计数与失败回收、预算核算与 `LIMITED`、阻断的记录与解除、终态派生、交付闸门。
- **模型/调用方负责**:选择下一步动作、编写 verifier、执行具体修复、决定何时 `deliver`。

---

## 7. 优点

1. **核心洞见正确且稀缺**:把"要小心"从提示词(软)搬进运行时闸门(硬)。这是它区别于普通 prompt 模板的根本价值。
2. **诚实的多态交付**:6 种结果态(尤其 `UNVERIFIED/LIMITED/BLOCKED/PARTIAL`)系统性对抗"过度声称"。
3. **证据 ↔ 验收强绑定**:`SUCCESS` 必须 P0 挂非失败证据(`p0AllPass` + `hasPositiveEvidenceFor`),从机制上要求用证据说话;证据保留 `ok`,校验器能区分"跑过 vs 跑通"。
4. **止损内建**:修复次数由运行时计数,超限自动 `FAILED`;预算(轮次/成本)耗尽自动 `LIMITED`——无限循环从机制上被切断。
5. **阻断可恢复**:单次工具被拒不再锁死任务,而是进入可恢复的 `REPAIRING`;换到被允许的工具成功执行后,阻断自动解除;仅当交付时仍有阻断才落 `BLOCKED`。
6. **纯函数派生**:所有状态判定为无副作用纯函数,易测、易审计(见 `agent-loop-runtime.test.ts`,25 个用例)。
7. **安全姿态好**:工具分五级 + 网关 + 对 DESTRUCTIVE/EXTERNAL_ACTION 默认要审批。
8. **领域无关 + 可插拔**:verifier 按领域(编码/研究/数据/产品)扩展,同一骨架通吃。
9. **可移植、状态外置**:配套 JSON Schema 与 MCP 工具规范,状态可存在模型上下文之外,任何语言/Agent 都能接。
10. **轻**:核心零运行时依赖、约 300 行、可读性强。
11. **开始具备生产接入面**:`runtime-extensions.ts` 提供 `TaskStateStore`、`FileTaskStateStore`、`AuditSink`、`JsonlAuditSink`、策略型网关、审计网关、Verifier Registry、CommandVerifier 和并发证据合并函数,使试点阶段可以接入真实存储/审计/策略系统。

---

## 8. 局限与注意事项

即便经过本轮加固,仍有以下**设计取舍/固有局限**,接入时需知晓:

1. **运行时是"骨架"而非"编排器"**:主循环(何时 act/judge/repair/deliver)仍由调用方实现。套件保证"闸门正确",但不保证"调用方按正确顺序调用闸门"。例如若跳过 `judge` 直接 `deliver`,失败不会被回收。
2. **证据的"内容真实性"仍需 verifier 保证**:运行时只校验"证据是否存在且绑定到 P0",证据是否**真的**证明了标准,取决于 verifier 的质量。弱 verifier = 弱保证。
3. **并行工具调用需调用方自行合并**:`runTool` 采用不可变状态复制,若并行发起多个 `runTool` 于同一 `state`,后写会覆盖先写、丢失证据。并行读取需在调用方层面归并结果后再并入 `state`。
4. **`attempts` 语义**:`judge` 每观察到某 P0/P1 仍 `FAIL` 就累加;新失败从 0 起,`attempts >= maxRepairAttempts` 判 `FAILED`。因此 `maxRepairAttempts=2` 意味着"允许 2 次修复后再失败即判死"。请按此语义设阈值。
5. **`BLOCKED` 的自动解除依赖"后续有成功工具调用"**:若被拒后模型再未成功执行任何工具就直接交付,则以 `BLOCKED` 收尾——这是刻意的保守策略。
6. **运行环境**:代码用到 `.ts` 扩展名导入,依赖 Node ≥ 22.6 的类型擦除(或 tsc/tsx)。已提供 `package.json` / `tsconfig.json`,`npm test` 与 `npm run example` 可直接运行。
7. **扩展仍是接口/基础实现**:`InMemoryTaskStateStore`、`FileTaskStateStore`、`InMemoryAuditSink` 和 `JsonlAuditSink` 适合测试/单机试点,生产需要替换为数据库、对象存储、日志系统或事件总线。

---

## 9. 如何运行

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # 25 个纯函数/运行时单测
npm run example     # 跑一遍最小编码 Agent 示例
```

想直观理解闸门效果,可把 `example-coding-agent.ts` 里模拟网关的 `ok: true` 改为 `ok: false`(模拟测试失败):你会看到 `preDeliver` 闸门拒绝交付,而**不会**再误报 `SUCCESS`。

---

## 10. 本轮加固变更记录(相对初始版本)

| # | 问题 | 修复 |
|---|---|---|
| 1 | 证据丢弃 `ok`,示例校验器"跑过即 PASS",导致**测试失败仍报 SUCCESS** | `EvidenceEntry` 增加并保留 `ok`;示例校验器改看 `ok===true`;新增回归测试 |
| 2 | `attempts` 从不自增、`openFailures` 从不回收,"禁止无限修复"未被强制 | 新增 `reconcileFailures`:`judge` 时由运行时计数失败、回收已通过项 |
| 3 | `deriveResultStatus` 零证据兜底误判为 `PARTIAL`(过度声称) | 改为统一 `UNVERIFIED`;`PARTIAL` 仅在"P0 过 + 非 P0 有缺口"时产生 |
| 4 | 单次工具被拒即锁死为终态 `BLOCKED` | 改为可恢复的 `REPAIRING` + 阻断标记;成功调用自动解除;交付时仍阻断才 `BLOCKED` |
| 5 | `preCompact`/成本预算/`PLANNING·ACTING` 定义了却从不触发;guide 伪代码引用不存在的方法 | 新增 `compact()` 触发 `preCompact`;`spendTurn` 核算 `maxCost`;修正 guide 伪代码 |
| 6 | 无任何单测 | 新增 `agent-loop-runtime.test.ts`(25 用例)+ `package.json`/`tsconfig.json` |
| 7 | 类型/Schema 不一致;开箱不可运行 | `stopConditions` 补 `unverified`;schema 补 `ok`/`blocking`;修正导入扩展名与构造函数写法,Node 原生可运行 |
