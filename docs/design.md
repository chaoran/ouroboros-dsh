# 把 Ouroboros 的核心能力原生引入 DSH（不起额外进程）

> **公开版说明**：本文最初为一个私有工作区所写。公开版已把本地绝对路径、内部包名与运行 ID 替换为占位符，其余内容未改。

> 调研日期 2026-10-22（v2：补生态调查与既有先例）。对象：`~/src/ouroboros`（v0.55.x，696 个 py 文件 /
> 358,312 行）与一个装配了 `@local/dsh-ouroboros-preset` 的 dsh profile（`web`）。
> DSH 实现检出：`<dsh-install>/node_modules/@deepseek-ai/`。
>
> 本文是**调研与方案**：没有改代码，没有装卸 bundle。所有阈值/字段都以源码为准；
> 文档与代码冲突处单独列出（附录 B）；给实现者的交接清单在附录 C。

---

## 0. 结论

**可行，且不需要"移植 35 万行"。** 三条判断：

1. **体积大头不是核心，是"在别人的宿主里假装成操作系统"的适配层。**
   `orchestrator/` 103,205 行（宿主 CLI 的 adapter——README 列了 14 个宿主——加 parallel_executor/runner）、
   `mcp/` 51,590（server + job + fan-out 传输）、`cli/` 30,191、`tui/`+`dashboard*`+`config_tui/`
   13,252、`providers/` 15,006、`auto/` 25,410（流水线胶水，扣掉 ledger 三件套）、
   `plugin/` 10,248、`boundary/` 19,622。**这些在 DSH 里应当删掉，而不是移植**——
   DSH 自己就是宿主，已经有 agent loop、委派、模型通道、账本、UI。
2. **真正的核心是 6 个契约**，在 Python 里我逐条追踪到 **33,601 行（9.4%）**：
   Seed 与 AC 成功契约、歧义打分与四重就绪闸门、三阶段评测的*验收权*、演化循环与收敛判据、
   事件溯源账本、执行/验证分离。上限（把相关子系统整包算）是 58,932 行（16.4%）。
   这 3.4 万里约 40–50% 是 Python 特有的加固（路径/Windows 校验、pydantic 强制转换、
   sqlite 租约、per-AC CAS 守卫），DSH 用自己的原语替掉，**TS 内核现实估计 8–12k 行**
   （最小可信子集 5–7k，见 §5）。
3. **DSH 的原语几乎一一对应**，且有两处比 ouroboros 自己的做法更对：
   `ctx.llm.stream()` 是宿主模型通道（不再需要 litellm 子进程），
   `ctx.subagents` / `ctx.workflowEngine` 是宿主委派通道（不再需要 host-dispatch 的
   park + 心跳 + 人工回填）。

**"不好用"的根因是架构错位**：把一个自带 LLM 后端、自带执行器、自带账本、自带 36 个工具的
"操作系统"当 MCP 插件塞进另一个操作系统，于是同时存在双 LLM 通道、双账本、双委派协议、
36 个工具的全量注入，以及被迫写进工作区的胶水（一次实测里，工作区就多出了 `.ouroboros/wait_fanout.py`）。

**建议**：原生 host-only bundle `@local/dsh-ouroboros`（纯 ESM，无构建步骤），
6 个工具 + 5 个嵌入技能 + 一个确定性内核；分 4 期，P0（访谈在进程内跑通、不再起 python）
3–4 天可交付。

---

## 1. 现状与生态：DSH 里的 ouroboros，以及它有没有现成的原生替代

### 1.1 安装形态

`<profile>/node_modules/@local/dsh-ouroboros-preset/cordis.patch.yml` 插入一条
`@deepseek-ai/dsh-agent-preset`（preset `ouroboros`，`order: 5`），plugins 前半段照搬
shipped `standard` preset，末尾加一行：

```yaml
- id: mcp-ouroboros
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: ouroboros
    transport: stdio
    command: <venv>/bin/ouroboros
    args: [mcp, serve]
    env: { …短白名单… }
    toolCallTimeoutMs: 1800000
    failOnStartupError: false
```

即**一条 stdio MCP 连接 = 一个常驻 Python 进程**，暴露 36 个 `mcp__ouroboros__*` 工具
（32 个来自 `mcp/tools/definitions.py:459`，另外 4 个只在 adapter 组合根注册：
`ac_dashboard`、`record_conductor_decision`、`session_signal`、`session_signal_targets`；
名单见 `mcp/tool_manifest.py:8`）。

而且 preset 是**eager 装载**的：声明一被 Loader 挂上就 mount 子树，与有没有人选这个模式无关
（该 preset README 的"三条要知道的行为"第 1 条）。所以代价在 profile 启动时
就已付出，不用也要付。

**版本兼容性**：这个 bundle 的 `package.json` 不声明 `engines.dsh`，也不声明 dsh peer，因此 dsh 的
版本门（`engines.dsh` → DSH peer → 都没有则放行）不会拦它；它用到的 mcp-client 字段
（`serverName`/`transport`/`command`/`args`/`env`/`toolCallTimeoutMs`/`failOnStartupError`）在
dsh 0.2.1-rc.2 的检出里仍然存在。所以"能装、能起"成立——但上游从未声明针对该版本做过适配，
而 §1.3 的现场证据说明"能起"与"好用"是两件事。

### 1.2 成本（标注来源，不把我没测的当测过的）

| 项 | 数值 | 来源 |
|---|---|---|
| 常驻 Python RSS | ~310 MB（带 litellm）/ ~160 MB（仅 `[mcp]`） | 该 preset 的 README（作者实测） |
| uv 包装进程 | ~35 MB | 同上 |
| 工具数 | 36 | 源码 |
| 注入的系统提示 | MCP server instructions ≤ 32,768 字节，进 **logged** system message | `dsh-mcp-client` README（`maxInstructionBytes` 默认 32,768） |
| 单次调用超时 | 默认 60 s；本 preset 抬到 1800 s | 同上 / preset patch |
| 账本 | `~/.ouroboros/ouroboros.db` 本机 33 MB | `ls ~/.ouroboros` |

> 本次调研的 `ps` 看不到宿主进程（沙箱内只有自己的进程树；`:3080` 有监听但无进程信息），
> 所以上表是机制 + 仓库内既有测量，**不是我复测的**。复测：宿主上
> `ps -eo pid,rss,cmd | grep 'mcp serve'`。

### 1.3 现场证据：两次真实 `ooo auto`

一次本地实测留下的 `.ouroboros/traces/` 中有两次完整轨迹：

| 轨迹 | 结果 | 细节 |
|---|---|---|
| `run-1` | `status: complete`，Seed grade **A** | 18 轮提问、23 条决策；但 Seed QA `score 0.48 / verdict revise / passed false` 仍算 complete |
| `run-2` | `status: failed` | **35 轮提问、39 条决策之后**，`generate_seed` 报 `Failed to parse extraction response after 2 attempts: Missing required field: acceptance_criteria (response_preview: '')` —— LLM 返回空串 |

同目录散落着**手工胶水**：`wait_fanout.py`、`submitted_fanouts.txt`、
`fanout_64da2578_prompt.txt`、`worker_prompt.txt`、`worker_result.md`、`context_pack.json`。
它们不是产品功能，而是"宿主没按 ouroboros 期待的方式服务 fan-out"时人/模型补出来的。
`mechanical.toml` 里还留着注释，说自动生成的 Stage-1 命令指向仓库里根本不存在的
`npm run test:<不存在的脚本>`。

两件事被这两条轨迹钉死：**访谈成本真实（35 轮）**、**失败点在宿主看不见的 LLM 通道**。

### 1.4 六个根因

1. **双 LLM 通道。** 访谈/Seed/QA 走 `~/.ouroboros/config.yaml` 的 `llm.backend: litellm`
   → DeepSeek 官方 API，key 在 `~/.ouroboros/credentials.yaml`。harness 的模型选择、token 计量、
   重试、限流、按会话计费**全部绕过**；空响应只能由 ouroboros 自己重试两次。
   更糟的是它自己的语义：Stage 2 解析失败是 `Result.err`，**整条流水线中止**，而不是记一个失败裁决
   （`evaluation/pipeline.py:179-180`）。
2. **双委派协议。** `OUROBOROS_AGENT_RUNTIME=host` 时 `execute_task` 会 park，
   等宿主 spawn 子代理再 `ouroboros_submit_fanout_results` 回填
   （`orchestrator/host_dispatch.py` 开头 30 行写清了契约：900 s stall scope + 3600 s dispatch deadline）。
   DSH 的委派是 `ctx.subagents` managed activation / `ctx.workflowEngine`，不是"模型自己 spawn 再回填"。
3. **流程纪律全丢。** 24 个 SKILL.md 的批准门、账本可见性、`seed-ready ≠ 完成` 的 closure 审计、
   restate 门、`◆ state → next` footer、观察者所有权，**一个都到不了 DSH**——MCP-only 只搬了工具。
4. **36 个工具全量注入 + 语义重复。** 6 对同步/后台双胞胎（`execute_seed`/`start_execute_seed` 等）
   只为绕 MCP 客户端超时；6 个只读投影工具供 ralph/仪表盘消费。
5. **账本在 harness 外。** 33 MB SQLite 在 `~/.ouroboros/`，与 workspace/git/session log 全脱钩：
   不可 review、不可 diff、不随仓库走。项目内只剩 `.ouroboros/*.yaml|jsonl` 投影。
6. **宿主能力靠自报。** DSH 在它眼里是第 14 个宿主，能力协商 `host_capability=undeclared` +
   ≤2 KB instructions（`backends/capabilities.py:748-800`），连"工具可能被延迟发现"都要教模型
   （`+ouroboros <skill>` 查询约定）。

---

### 1.5 生态调查：当前没有现成的 DSH 原生 port（2026-10-22）

写这一节是为了让实现者**不要再去找一遍**。结论：不存在面向当前 dsh 的原生（in-process / TS）
Ouroboros 移植；上游唯一提供的 DSH 集成就是 §1.1 那个纯配置 MCP bundle。

| 检查面 | 结果 |
|---|---|
| 上游 `integrations/` | 只有 `dsh-plugin`（GitHub contents API） |
| 该包本身 | `dsh-ouroboros@0.1.0`：`files` 只有 `cordis.patch.yml` + `README.md`，无 `main`/`exports`/依赖/`engines` |
| 立项 issue | [#2159](https://github.com/Q00/ouroboros/issues/2159) 原文："A **config-only** dsh bundle … inserts one `@deepseek-ai/dsh-mcp-client` row spawning `ouroboros mcp serve` over stdio. **No separate repo or release cadence: it has no code of its own.**" |
| 落地 PR | [#2158](https://github.com/Q00/ouroboros/pull/2158)（bundle）；[#2169](https://github.com/Q00/ouroboros/pull/2169) 加的是 host-driven execution runtime（park + 心跳），仍是子进程协议 |
| 仓库名变体 | `dshoroboros` / `ooo-dsh` / `dsh-ooo` / `ouroboros-dsh` 在 GitHub 搜索均为 0 命中 |
| npm | `dsh-ouroboros` / `ouroboros-dsh` / `dsh-plugin-ouroboros` / `dsh-ooo` 全部 404 |
| 上游 issue/PR 的原生提案 | title 含 `in-process` / `typescript` / `port` 的命中与本主题无关（0 条实质提案） |
| 社区搬运 | `nnnet/dsh-plugins-collection` 只是把上游 fork 作为 git submodule 挂进去（仍是 Python/MCP） |
| 生态清单口径 | `awesome-deepseek-harness` 中文 README 写作"纯配置包，经 MCP 挂载 Ouroboros，提供 36 个工具"；插件目录站标"原生运行时"，指的是"在 dsh 聊天里可用"，不是 in-process（其 FAQ 两种口径混用） |

两个直接影响本项目的推论：

1. **本项目不是重复劳动**——补的正是上游明确不做的部分（`#2159`：*no code of its own*）。
2. **命名避开 `dsh-ouroboros`**：上游已把它用在 MCP bundle 上。本项目仓库名用 `ouroboros-dsh`。

### 1.6 可借鉴的既有原生移植：pirobos / clauroboros

原生移植已经有人做出来了，只是**不是给 DSH 的**：

| 项目 | 宿主 | 形态 | 状态 | 与本项目的关系 |
|---|---|---|---|---|
| [`shseooo/pirobos`](https://github.com/shseooo/pirobos) | pi.dev（pi-mono 扩展） | TypeScript，`index.ts` + `src/` | v0.2.1，MIT，48 个文件 ≈ 2k 行；0★；最后推送 2026-05-27；未发 npm | **最接近的先例**，可直接当蓝图 |
| [`shseooo/clauroboros`](https://github.com/shseooo/clauroboros) | Claude Code | 同作者；`.ouroboros/` 与 pirobos 字节兼容 | 同上量级 | 证明同一份 `.ouroboros/` 状态可跨宿主复用 |
| [`BrahmanForge/pirobos-ralph-loop-harness`](https://github.com/BrahmanForge/pirobos-ralph-loop-harness) | pi.dev | ralph 变体实验 | 实验性 | 只当参考 |
| [`police-hotbioy/code-feedback-weave`](https://github.com/police-hotbioy/code-feedback-weave) | 泛 | 反馈闭环实验 | 实验性 | 只当参考 |

pirobos README 第一句：*"This is **not** a wrapper around the `ouroboros` Python CLI. The spec-first
loop … is implemented directly inside pi as a TypeScript extension."* —— 与 §4 的方案同构。

**七条具体可借鉴的（按价值排序）**：

1. **状态布局**：`.ouroboros/seed.json` 是真身、`seed.yaml` 是只读镜像，finalize 后 lock。
   与 §4.5 同构，建议**对齐命名**，让同一项目的状态可被 pirobos / clauroboros 复用。
2. **Stage-1 命令自动识别**：mechanical 自动探测 15+ runner（Node 锁文件感知的包管理器、
   vitest / jest / playwright / cypress、tox / pytest、rake / make、cargo、go、mix、swift、
   composer / phpunit、mvn / gradle），只对**上次评测以来的 git diff** 做增量。
   这直接解决 §1.3 那个"自动生成的 Stage-1 命令指向不存在脚本"的坑——但仍要 fail-closed：
   探测不到 = `unverified`，不许猜。
3. **硬门**：没有锁定 Seed 时对 `edit`/`write` 直接 `{block: true}`。DSH 的等价物是
   `ctx.tools.guard` 的 pre-execute 守卫，比"提示词里写批准门"硬得多，建议 P1 就做。
4. **ralph 硬上限默认 8 轮**（上游是 30 代）。对按 token 计费的用户更友好，原生版建议取 8–10 且可配。
5. **逐 AC 评分 + 文件级证据**（`ooo_grade_ac`）：与 §2.3 "每 AC 独立权威"一致，可作为 Stage-2 的输入组织方式。
6. **`plan.json` + plan tick**：Seed 锁定后把 AC 展开成执行计划。本方案没有这一层——建议作为
   **P2 可选项**：它只是 AC 的展示视图，**不要**当账本。
7. **drift 是独立命令、只做展示**：与 §2.4 "drift 仅遥测、不参与收敛"完全一致，印证我们的取舍。

**规模标定**：pirobos 用 ≈2k 行 TS 覆盖 interview / seed / evaluate / drift / unstuck / ralph 全环。
本方案估 5–12k 行，差额来自三项额外要求：Stage-3 共识与独立性过滤、lineage/rewind/完整收敛信号集、
事件溯源账本。所以 §5 的估计**偏保守**而非乐观。

**不要做的事**：

- **不要把它当依赖**：0★、单人、5 月后未更新、未发 npm、只有 2 个测试文件。当蓝图可以，当依赖不行。
- **不要搬"人格化"提示**：pirobos 会把一份 `KARPATHY_HARNESS` 常量注入系统提示（仅在 Seed 锁定后）。
  本方案不需要——纪律由 5 个技能承载，系统提示只留一小段路由说明（§3）。
- **不要抄它的宿主钩子写法**：那是 pi 的扩展 API（`tool_call` / `before_agent_start`）；DSH 对应
  `ctx.tools.guard` / `ctx.systemPrompt.section` / `ctx.subagents`。

## 2. Ouroboros 的核心能力（逐条对照源码）

### 2.1 Seed 与 AC 成功契约

`core/seed.py:768-870`，pydantic `frozen=True`、`extra="allow"`：

```
goal: str(min_length=1)                    # :828
task_type: TaskType = "code"               # :829，7 个内置
brownfield_context: BrownfieldContext      # :837
constraints: tuple[str, ...]               # :841
acceptance_criteria: tuple[AcceptanceCriterionSpec, ...]   # :845
ontology_schema: OntologySchema            # :851 必填
evaluation_principles: tuple[EvaluationPrinciple, ...]     # :857
exit_conditions: tuple[ExitCondition, ...] # :863
metadata: SeedMetadata                      # :869 必填
```

**没有 `non_goals`、没有 `id`、没有内容哈希**；身份是 `metadata.seed_id`（`seed_` + uuid4[:12]）。
non-goals 只存在于访谈账本的一个 section 里。

`AcceptanceCriterionSpec`（:530-563）：

```
description: str(min 1)
semantic_ac_key: "ac_[a-f0-9]{16}" | None
verify_command: str | None
expected_artifacts: tuple[str, ...]     # workspace 相对路径，必须存在，每段 ≤255 UTF-8 字节
output_assertion: str | None
verify_exemption_reason: str | None
investment: InvestmentSpec | None
```

两条硬不变量：

- **`output_assertion` 没有 `verify_command` → 构造期拒绝**（:565-584）。
- **`semantic_ac_key = "ac_" + sha256(json{description, verify_command, expected_artifacts,
  output_assertion}, sort_keys, compact)[:16]`**，**故意排除列表位置与 metadata**（:730-753）：
  AC 身份因此能在重试间存活，只有成功契约变了才变。这是"可回放"的根：评测结论可以按 key 复用。

`SeedMetadata`（:421-432）：`seed_id, version "1.0.0", created_at, ambiguity_score=0.15,`
`gate_forced, interview_id, parent_seed_id, generation_mode("normal"|"partial_seed_from_evidence"),`
`degraded=False, unresolved_slots, recovery_reason, decision_provenance`。

**移植性：高。** 全是确定性校验与序列化。

### 2.2 访谈歧义：打分公式 + 四重就绪闸门

**打分是代码拥有的，模型只报分量**（`bigbang/ambiguity.py:836-852`）：

```
ambiguity = round(1 − Σ(clarity_i × weight_i), 4)
greenfield 权重: goal 0.40 / constraint 0.30 / success_criteria 0.30      # :48-50
brownfield 权重: goal 0.35 / constraint 0.25 / success 0.25 / context 0.15 # :53-56
```

clarity 由模型按维度给 0..1（clamped :767-771），一次 LLM 调用、temperature 0.1（:145），
返回 `goal_clarity_score / constraint_clarity_score / success_criteria_clarity_score`
（+ brownfield 的 `context_clarity_score`），各自带 `_justification`；
数字缺失 = 解析错误，justification 缺失 = 占位符（:756-772）。

**"就绪"是四重合取，不是单一阈值**：

| 条件 | 阈值 | 位置 |
|---|---|---|
| 总分 | `overall ≤ 0.2`（严格 `<=`） | `ambiguity.py:296` |
| 每维下限 | goal ≥ 0.75 / constraint ≥ 0.65 / success ≥ 0.70 / brownfield context ≥ 0.60 | `:42-45, :318-334` |
| 连续达标 | `AUTO_COMPLETE_STREAK_REQUIRED = 2` 次 | `:39` |
| 已答轮数 | `MIN_ROUNDS_BEFORE_EARLY_EXIT = 3` | `interview.py:53` |
| 未答陷阱 | 非首轮有未答 → 分数钉在 ≥ `0.21`，永不就绪 | `:59, :585-601` |

`DEFAULT_INTERVIEW_ROUNDS = 10` **只是提示、不强制**（`interview.py:54`）；真正的上限是宿主配置
`max_interview_rounds`。milestone 分档：initial ≤1.0 / progress ≤0.4 / refined ≤0.3 / ready ≤0.2（:169-186）。

**下一问怎么选**（`turn_planner.py:122-165`）：默认"原子轮"——**一次** LLM 调用同时返回下一问
和所有 clarity 分量，契约要求 `{"next_question","goal_clarity_score",…}`，并指示
"先算 clarity 再选 next_question"。`≤0.25` 进入 closure 模式（只做收口探针，不开新话题）；
某维低于下限时，即使已 ≤0.25 也继续钻最弱那一维。
`≤0.25` 时视角面板从 6 条裁到 seed-closer / breadth-keeper / architect（`interview.py:1557-1573`）。
候选面板模式（3 个 persona 并发出问，再由确定性 `min` 选）**默认关闭**
（`question_candidate_panel = False`，`interview.py:818`）。

**咨询旁路（advisory fan-out）是零权重的**：6 条 lane（`interview_schemas.py:1264-1318`）
严格单向——分数被注入 lane prompt，**没有任何代码把 lane 输出喂回打分或选题**，合并在宿主 LLM 的散文里。
→ **移植时可以整层砍掉**，只在"想给人看多视角"时保留。

**Seed 生成前的 9 道门**：①≥3 轮已答 ②总分≤0.2 ③四维下限 ④连续 2 次 ⑤需求蒸馏 blocker
⑥每条 AC 有 `verify_command` 或 `verify_exemption_reason`（`seed_verify_gate.py:47-61`，
模式 `warn|block`，**默认 warn**）⑦宿主 `restate_goal_approved` ⑧宿主
`seed_ready_acceptance_guard`（`REQUIRED_CLIENT_GATES`，**默认 warn-only**，除非
`OUROBOROS_REQUIRE_CLIENT_GATES=1`，`authoring_handlers.py:119-125`）⑨显式 `force=true`
（绕过 ②③④，但**如实记录真实分数**、置 `gate_forced=True`、发
`mcp.tool.generate_seed.force_bypass`，`:1256-1320`）。

**另一条无 LLM 的路**：`session_seed.py:10-38` 从已定型的会话材料直接结晶 Seed
（逐字锚定、门槛 = goal + ≥1 AC、否则出缺口问题、**ambiguity 无条件记为 0.2 上限**）。
→ 这是原生版在 LLM 失败时的**确定性回退**，值得直接搬。

### 2.3 三阶段评测：验收权归谁

"三阶段"就是三个布尔开关（`pipeline.py:62-68, 143-239`）串成一条带短路的流水线：
Stage1 机械 → Stage2 语义 → 触发矩阵 → Stage3 共识 → **单一裁决函数** `decide_final_approval`。

**Stage 1（机械、$0、唯一能授予批准的阶段）**

- 5 类命令检查：`lint / build / test / static / coverage`（`models.py:77-84`），
  来源优先级 overrides > `.ouroboros/mechanical.toml` > 全空（`languages.py:229-306`）。
- **不走 shell**：`create_subprocess_exec`，解析期就拒绝 shell 元字符、非白名单/绝对可执行文件
  （`languages.py:191-217`），默认超时 300 s。
- 判定：`passed = return_code == 0`（`mechanical.py:357`）；超时 → kill、rc −1、`executed=True, passed=False`；
  **未配置 → `passed=True, executed=False, {"skipped": true}`，这不算证据**（:322-329）。
- 唯一的输出解析是覆盖率正则 + 阈值 0.7（:180-204, 268-285）。
- **Stage 1 不做 stdout/断言匹配**——`output_assertion` 由执行/验证子系统负责。
- `disposition ∈ executed_fail | executed_pass | no_evidence`（`models.py:176-188`）；
  **只有 `executed_pass` 能支撑批准**。

**Stage 2（LLM、advisory、只能扣留）**

- 9 字段 / 6 必填（`semantic.py:36-68`），temperature 0.2、max_tokens 8192、
  `response_format=json_schema`（:84-92）。
- **解析失败 = `Result.err`，流水线中止**，不是"记一个 rejected"（`pipeline.py:179-180`）。
- 只有三件事闸门：`ac_compliance=false`、`score < 0.8`（硬编码 `SEMANTIC_APPROVAL_SCORE`，
  `models.py:40`，配置里的 `satisfaction_threshold` **惰性**）、`reward_hacking_risk ≥ 0.7`（:34）。
  `goal_alignment` 从不闸门；`drift_score`/`uncertainty` 只喂 Stage 3 触发。
- **它看到什么**：AC 文本、**声明的成功契约**（`verify_command`/`expected_artifacts`/`output_assertion`）
  渲染成 `## DECLARED SUCCESS CONTRACT`、`## EXECUTED EVIDENCE`（命令 + 退出码 + 600 字符尾巴 +
  check-package 结论）、goal、constraints、artifact 类型、原始 artifact 或最多 150k 字符的真实源码
  （`semantic.py:143-211`、`executed_evidence.py:43-68`）。**从不给 diff。**
- 隔离靠只读策略信封（Read/Grep/Glob/WebFetch/WebSearch，`max_turns=20`），
  **评审者不能执行、不能写**（`orchestrator/policy.py:118-123, 258-263`）。

**Stage 3（共识、advisory）**

- 触发矩阵按优先级、首个命中即停、`manual_request` 短路（`trigger.py:31-37`）：
  seed 修改 > ontology 演化 > goal 重解释 > `drift_score > 0.3` > `uncertainty > 0.3` > lateral 采纳
  （两个 0.3 都是**严格 `>`**）。
- 计票：`majority_ratio = 赞成 / 成功收集的票`，`approved = ratio ≥ 0.66`；**少于 2 票是 error**
  （`consensus.py:399-405, 530-532`）。单模型回退 = 同一模型 × 3 个视角提示。
- "独立性"是**按厂商族过滤**，不是上下文隔离：已知同族标签只在剩 ≥2 票时才丢弃，未知族一律保留；
  标签（`independent|same_vendor|unavailable|unverified`）**只改分母，不改结论**
  （`reviewer_independence.py:47-248`）。
- Stage 3 看到的**严格少于** Stage 2：无文件、无契约、无执行证据（`consensus.py:165-194`）。

**单一裁决**（`models.py:566-603`）：

```
approved   ⟺ stage1 存在 ∧ has_executed_evidence ∧ 模型层没有任何扣留
没有执行证据 → unverified（不是 rejected、不是 approved）
模型层只能扣留：Stage 3 的赞成不能推翻 Stage 2 的扣留
failure_reason 优先级：S1 执行失败 → S3 否决 → S2 AC 不合规 → S2 低分 → 反作弊否决
```

`adversarial.py` **不是阶段**——它是 9 条攻击类别提示的静态表，渲染进 QA/评审的提示里
（:42-163），不能否决机械或语义结果。

> **这一层正是 DSH 现成 `ralph` 明确缺的**：`dsh-tool-ralph` README 的限制第一条就是
> *"Completion is worker self-declaration — there is no independent evaluator or verifier…
> evaluator policy and evaluator-driven continuation are deferred"*。
> 原生移植的评测层不是重复建设，是补 DSH 的已知缺口。

### 2.4 演化循环与收敛

没有 FSM 类，只有三个枚举 + 有序 `if`：`GenerationPhase`（wondering/reflecting/seeding/executing/
evaluating/completed/failed/cancelled/interrupted）、`StepAction`（continue/converged/ontology_stable/
stagnated/exhausted/failed/interrupted）、`LineageStatus`（active/converged/exhausted/aborted）。

**一步 = 一代**：Gen1 = Execute→Evaluate；Gen2+ = Wonder→Reflect→Seed→Execute→Evaluate。
`evolve_step(lineage_id, initial_seed, execute, parallel, directive, lease)`，**没有租约立刻失败**
（`loop.py:152-160, 578-681`）。

**Focus 是集合代数，不是打分**：`frozen = passed − (challenged ∪ regressed ∪ changed ∪ added)`，
`active = all − frozen`；AC 裁决缺失或覆盖不全时**fail-closed 退回全 active**
（`focus.py:193-282`）。frozen 的 AC 不重跑，沿用上一代的 `authoritative_pass`。

**收敛判定顺序**（`convergence.py:70-391`，先命中先返回）：

1. **outcome gate 通过 → CONVERGED，发生在 min_generations 之前**（所以第 1 代就正确也能停）；
2. `completed ≥ 30` → EXHAUSTED（**停，但不是 converged**）；
3. `completed < min_generations` → continue（`ConvergenceCriteria` 写 2，`EvolutionaryLoopConfig` 写 3，
   文档写 2 —— **取 3**）；
4. `similarity ≥ 0.95` → 再跑全部 block gate（有评测且 approved、Seed 级 AC 覆盖、每 AC 权威、
   score < 0.7 若启用、regression、evolution、validation），全清 → CONVERGED，任一 block → continue；
5. 相似度 ≥0.95 连续 3 代 → STAGNATED（**非终态，lineage 可恢复，映射到 UNSTUCK**）；
6. 评测平台期：最近 3 代都不 approved 且相邻差 < 0.01；
7. 振荡 A→B→A ≥3 代；
8. wonder 问题在最近 3 代里有 ≥2 代重叠 ≥70%。

相似度 = `0.5·name_overlap + 0.3·type_match + 0.2·exact_match`，分母统一 `|old ∪ new|`
（`lineage.py:389-407`）。

**rewind** 按代数（含），不按 step id/checkpoint：把投影截到 ≤N、追加 `lineage.rewound`、
状态回 ACTIVE、从 N+1 继续，**不删任何事件**（`loop.py:2027-2098`）。
**regression** 是 per-AC 布尔：历史上通过过、现在不是 `authoritative_pass` 就是回归，无阈值
（`regression.py:50-114`）。**drift 只是遥测**：`drift_recording` 传空列表并吞异常
（`drift_recording.py:14-43`），**从不参与收敛判定**——不要把它当闸门。

### 2.5 事件溯源账本

根目录是常量 `Path.home()/".ouroboros"`，**没有环境变量覆盖**（`config/models.py:1019`）。
DB 路径解析：显式参数 → `config.yaml` 的 `persistence.database_path` → 旧默认
`~/.ouroboros/ouroboros.db`（:1040-1075）。

- 单表 `events(id PK, aggregate_type, aggregate_id, event_type, payload JSON, timestamp, consensus_id)`
  + 5–6 索引（`persistence/schema.py:42-72`）。**没有 seeds/sessions/ledger/snapshots 表**——
  那些只是事件流或 JSON 文件。
- 8 张 **guard 表**提供 one-winner CAS（`lineage_step_claims`、`session_start/terminal_guards`、
  `ac_acceptance_guards`、`lineage_advancement_claims/waiters`、`session_signal_target_guards`、
  `brownfield_repos`，:83-227）。
- 重放：`WHERE aggregate_type=? AND aggregate_id=? ORDER BY timestamp, id`（时间戳不唯一，id 做 tiebreaker）；
  增量 tail 用 `rowid > last`（`event_store.py:1684-1781`）。**没有版本列、没有乐观并发检查**，
  顺序靠 WAL + `BEGIN IMMEDIATE` + 3 次退避重试（:1531-1543）。
- checkpoint 是 JSON `{seed_id, phase, state, timestamp, hash}`（sha256 完整性、最多回滚 3 层、
  staged+fsync+原子发布，`checkpoint.py:30-60, 315-325`）。
- artifact 体在 `artifacts` 表（`contract_id` 主键），**事件只带引用**（`artifact_store.py:59-70`）。
- 事件名 `domain.subject.past_tense`，**114 个类型字面量**。

### 2.6 流程纪律（24 个 SKILL.md）

工具表达不了、只有技能能表达的那一半。可移植的 8 条：

1. **批准门**：写进工作流状态前先 refine 确认；Seed 生成前必须 **restate + 显式批准**；
   "候选修订默认不接受任何一条"。
2. **账本可见**：四轨歧义账本必须出现在**主会话**，不能只活在工具状态里。
3. **closure 审计**：Seed-Closer 3 lane 的结论可以**否决**工具自报的 `seed-ready`
   （"MCP says seed-ready, but I am not accepting it yet because <gap>"）。
4. **footer**：最后一行恰好一句 `◆ <状态> → next: <动作>`，状态取自 `session_status`；
   禁止 `Step N of M`（它是演化循环，不是线性流程）。
5. **委派所有权**：恰好一个观察者子代理持游标，主会话不得同时轮询同一 job。
6. **反仿造**：不得手工模拟 pipeline/loop（"do not emulate"）。
7. **裁决权归人**：lateral / QA / publish 的结论由用户下。
8. **传输可疑即 fail-closed**：契约/sentinel 不匹配就报完整性失败，不许即兴发挥。

---

## 3. DSH 原生替身矩阵

| ouroboros 的依赖 | DSH 原语 | 证据 |
|---|---|---|
| LLM 后端（litellm 子进程） | `ctx.llm.stream({provider, model, system, messages, temperature, signal})`；`prepareCall()` 做校验/默认值 | `dsh-experimental-auto-review/lib/index.js:390-414`、`dsh-llm/README.md:50-57` |
| 模型选择 | `ctx.agentDefaultModel.currentSelection()` | Service 目录 `agentDefaultModel` |
| 36 个 MCP 工具 | `ctx.tools.register({name, description, parameters, output:{schema, render}, execute(args, exec)})` | `dsh-tool-ralph/lib/index.js:300-340`；`dsh-tools/lib/types/index.d.ts:115-158` |
| 24 个 SKILL.md | `ctx.skills.register({name, description, content, invocation?})`（嵌入技能） | `dsh-skill/README.md:52-55`、`dsh-skill/lib/types/index.d.ts:78-84` |
| `ask_user`（选项 + 自由文本） | `ctx.userQuestions.ask()` / `askTimed()`；支持单选/多选/自定义、`intent: 'plan-review'`（正好呈 Seed 求批准） | `dsh-user-questions/README.md` |
| subagent fan-out | `ctx.subagents.startActivation(spec)`；或 `ctx.workflowEngine.start({script, meta, args, subagentProvider, parent, signal})` | `dsh-subagent/lib/types/index.d.ts:135-152`、`dsh-workflow/README.md:30-42`、`dsh-tool-ralph/lib/index.js:335-345` |
| `job_*` + `start_*` 双胞胎 | 不需要：工具可阻塞并声明自己的超时预算（`ToolDefinition.timeoutMs` → `dsh-tool-call-timeout-policy`） | `dsh-tools/lib/types/index.d.ts:151-156` |
| Stage-1 机械检查 | `ctx.subprocess.spawn({argv, cwd, stdio, graceMs, signal, env})`（无 shell，正好对齐它的白名单语义） | Service 目录 `subprocess` |
| 事件账本（SQLite） | workspace 内 `.ouroboros/ledger.jsonl`，经 `ctx.fs.writeText(target, content, expected, signal, sandboxPolicy)` 写（受会话沙箱约束） | Service 目录 `fs` |
| （反面）用 DSH session log 当账本 | **不行**：`appendPluginRecord` 只允许 `packages/experimental/` 的包，第三方"也必须不调用" | `dsh-session/README.md:70-72` |
| server instructions（≤32 KB 全量注入） | `ctx.systemPrompt.section({name, order, text})`，短、可本地化、按作用域生效 | `dsh-tool-ralph/lib/index.js:295-299` |
| `ooo <cmd>` 路由 | `ctx.commands.register({name, description, handler})` 或技能触发 | `dsh-commands/lib/types/index.d.ts:38-55` |
| 执行隔离 | 会话权限模式 + `dsh-sandbox`；Auto review 式 pre-execute 守卫可复用 | `dsh-experimental-auto-review/README.md` |

**两个会直接改设计的 DSH 约束**：

- **子代理不能开人对人交互**（`human interaction is unavailable while the calling agent is owned
  by another live agent`，见 `dsh-user-questions` README 的错误清单）。
  → **访谈只能在主会话**；子代理只做只读检索/评审。
- **`ctx.llm` 没有结构化输出模式**：`GenerateOptions` 采样只有 `temperature/maxTokens/stop`，
  没有 `response_format`/JSON schema。→ 所有"要 JSON"的地方都要手写解析 + 有限重试 + fail-closed。
  （python 版有 `response_format=json_schema` 却仍然死在空响应，见 §1.3；这个风险要提前设计。）

---

## 4. 目标架构

### 4.1 形态

host-only bundle，纯 ESM，无构建、无外部依赖：

```
dsh-ouroboros/
├── package.json        # type:module, exports {".":"./index.js","./locale/*.json","./icon"},
│                       # dsh.bundle.patch: ./cordis.patch.yml
├── cordis.patch.yml    # 一行：id: ouroboros, name: '@local/dsh-ouroboros'
├── index.js            # export function apply(ctx, config) + export const inject=[…]
├── core/               # 确定性内核，纯函数，全部单测
│   ├── seed.js         # 校验/解析/序列化/semantic_ac_key（sha256 前 16）
│   ├── ambiguity.js    # 1−Σ(clarity×weight)、四维下限、streak、0.21 钉子、milestone
│   ├── gate.js         # decide_final_approval：approved|rejected|unverified + 扣留原因链
│   ├── converge.js     # 相似度 0.5/0.3/0.2、0.95、停滞 3、振荡、plateau、cap 30、min 3
│   ├── focus.js        # frozen/active 集合代数 + fail-closed
│   ├── ledger.js       # append-only jsonl：append/fold/query
│   └── stage1.js       # mechanical.toml → argv → 退出码 → 证据（executed 语义）
├── tools/              # 6 个工具
├── skills/             # 5 个嵌入技能（Markdown）
├── locale/{en,zh}.json
└── icon.svg
```

### 4.2 工具面：36 → 6

| 工具 | 角色 | 调 LLM | 执行 | 落盘 |
|---|---|---|---|---|
| `ooo_interview` | 一轮访谈：收答案 → 确定性打分/账本 → 下一问 → 经 `userQuestions` 呈现 | 只出问句 + clarity 分量 | 主会话（`ask` 必须主会话） | ledger |
| `ooo_seed` | 9 道门 → restate + 批准（`plan-review` intent）→ 校验 → 写不可变 Seed | 起草 Seed | — | `seeds/seed_<id>.json` |
| `ooo_run` | 读 Seed → 按 AC 派子代理（worker prompt **不含** verify 命令/断言） | 否 | `ctx.subagents` / `workflowEngine` | `runs/<id>/artifacts/` |
| `ooo_evaluate` | Stage1 子进程 → Stage2 新子代理 → 触发矩阵 → Stage3 投票 → **确定性裁决** | Stage2/3 评审 | 子进程 + 子代理 | `stage1/stage2/verdict.json` |
| `ooo_evolve` | wonder→reflect→新 Seed→run→evaluate，收敛即停 | wonder/reflect | workflowEngine 固定脚本 | `lineage/<id>.jsonl` |
| `ooo_status` | 读账本 → phase/ambiguity/generation/last verdict + footer 文本 | 否 | — | — |

对照"最小原生子集"（10 个工具）：`submit_fanout_results`、`job_wait`、`job_result`、`fetch_artifact`
以及 6 个 `start_*` **全部消失**——委派不再是"宿主回填"，而是插件自己 `await` 的 activation；
也不需要可处置的中间信封。

### 4.3 一次循环

```
"ooo interview 我想做一个 X"
   │ 技能 `ooo`（路由 + footer 纪律）
ooo_interview ─► ctx.llm（下一问 + clarity）─► ctx.userQuestions.ask（选项/自由文本）
   │  确定性：ambiguity.js 打分、四维下限、streak、账本追加
   └─ 循环直到「≤0.2 ∧ 四维达标 ∧ 连续2次 ∧ ≥3轮」且无未答
   │
   ▼ 技能 `ooo-interview` 的门：restate → 3-lane closure 审计（只读子代理）→ 显式批准
ooo_seed ─► 9 道门（宿主门默认**阻断**，不像上游默认 warn）─► plan-review 批准
   │        └─ 校验失败 = 不写盘，返回缺口清单
   ▼ .ouroboros/seeds/seed_<id>.json（不可变，含 semantic_ac_key）
ooo_run ─► 每 AC 一个子代理（按依赖分波）─► runs/<id>/artifacts/
   ▼
ooo_evaluate ─► S1: ctx.subprocess（mechanical.toml，exit code，executed 语义）
              ─► S2: 新子代理（只读策略信封）+ 结构化 JSON（0.8 / ac_compliance / 0.7 veto）
              ─► 触发矩阵 → S3: 3 票（≥0.66，≥2 票成功）
              ─► gate.js：approved | rejected | unverified
   ▼
ooo_evolve（可选）─► wonder/reflect → Gen N+1 … 相似度 ≥0.95 ∧ block gates 全清，或 cap 30
```

### 4.4 确定性 / 生成式分界

| 必须确定性（代码） | 允许 LLM |
|---|---|
| 歧义公式、四维下限、streak、0.21 钉子、milestone | clarity 分量与问句措辞 |
| Seed schema、AC 成功契约、`semantic_ac_key` | 起草 Seed / AC 文本 |
| **验收裁决**、`executed` 语义、failure_reason 优先级 | Stage2/3 评审判断（只能扣留） |
| Stage1 argv 白名单、退出码、超时 | 从机械失败里总结"补什么" |
| 相似度、停滞/振荡/plateau、focus 集合代数 | wonder 的"我们还不知道什么" |
| 账本 append/fold、rewind、regression | reflect 的规格修改建议 |
| 触发矩阵优先级、计票 | advisory lane 的检索（零权重，可砍） |

### 4.5 状态布局（workspace 内，可 git、可 diff）

```
.ouroboros/
├── seeds/seed_<id>.json          # 不可变；metadata.seed_id + AC.semantic_ac_key
├── mechanical.toml               # 沿用现有格式（S1 命令来源）；缺 = 无检查 = unverified
├── ledger.jsonl                  # append-only {seq, at, type, data}
├── runs/<run_id>/
│   ├── seed_snapshot.json
│   ├── artifacts/…
│   ├── stage1.json               # 每条命令 argv/cwd/exit/输出摘要 + executed 标记
│   ├── stage2.json               # 结构化评审 + reward_hacking_risk
│   └── verdict.json              # acceptance_state + 扣留原因链
└── lineage/<lineage_id>.jsonl    # 每代：seed 摘要、相似度、grade、action、frozen AC
```

不写 `~/.ouroboros/ouroboros.db`；与旧数据互操作时**只读**兼容 `.ouroboros/seeds/*.yaml`
与 `mechanical.toml`（真实项目里两处都有现成文件，可当测试夹具）。

### 4.6 与现有 DSH 机制的关系

- **不是取代 `ralph`**：`ralph` 是"无评估者的新鲜子代理循环"；`ooo_evolve` 是"有评估者的演化循环"。
  若要合并，把 §2.3 的 gate 作为 ralph 的 continuation 判据——正是它 README 里 deferred 的那件事。
- **复用 Auto review 的纪律**：只读评审信封（`max_turns`、无执行/写权限）在 DSH 里可以用
  per-child 的工具限制 + 权限模式实现，不必自建策略引擎。
- **别把 todo 当账本**：todo 是模型可改的展示态；账本必须 append-only 且由代码写。
- **借鉴 pirobos 的四处**（§1.6）：`.ouroboros/` 命名对齐；Stage-1 runner 自动探测（fail-closed）；
  无 Seed 时用 `ctx.tools.guard` 硬拦写操作；evolve/ralph 轮数上限取 8–10。
- **plan 视图不进账本**：pirobos 的 `plan.json` 只做 AC 的执行视图（P2 可选）。

---

## 5. 工作量

| 部分 | 原 Python（追踪到的核心） | TS 估计 | 依据 |
|---|---|---|---|
| Seed + AC 契约 + `semantic_ac_key` | ~1,900 | 400–600 | 纯 schema + 一次 sha256 |
| 歧义 + milestone + 四重闸门 | ~1,700 | 300–450 | 公式 + 阈值 |
| 评测（S1/S2/S3 + 裁决 + 触发矩阵 + 独立性过滤） | ~4,000 | 1,000–1,500 | 裁决/计票/触发纯逻辑；评审是提示 |
| 演化（收敛/停滞/振荡/plateau/focus/rewind/regression） | ~7,300 | 700–1,000 | 全纯函数 |
| 账本 + checkpoint + 投影 | ~5,000 | 500–800 | jsonl + 原子写 |
| 验证/执行分离（verifier + 产物收集） | ~1,900 | 400–700 | 可瘦身：产物由 `ctx.fs` 收集 |
| 6 工具 + 委派编排（替代 mcp 层 51k） | — | 1,000–1,500 | 工具壳 + 子代理编排 |
| 5 个技能（Markdown） | 24 个 SKILL.md | ~600 行 | 只搬纪律 |
| 测试 | — | 800–1,200 | 内核单测 + 端到端 |
| **合计** | **33,601（9.4%）** | **约 5–7k（最小可信）/ 8–12k（对等）** | 上限 16.4% 是整包口径 |

估时（单人，含验证）：P0 3–4 天，P1 5–7 天，P2 7–10 天，P3 2 天，合计约 3–4 周。

> **校准**：pirobos（§1.6）用 ≈2k 行 TS 覆盖了 interview→seed→evaluate→drift→ralph 全环，
> 但没有 Stage-3 共识、没有 lineage/rewind、没有事件溯源账本——本文这三项额外要求正是差额来源。
> 若只做 P0+P1（§7 的方案 B），落在 2–4k 行是现实的。

---

## 6. 分阶段与验收

每期都以"可观测事实"收口，不以"代码写完"收口。

### P0 — 进程内访谈（3–4 天）

范围：bundle 骨架 + `ooo_status` + `ooo_interview` + 技能 `ooo`/`ooo-interview` +
`core/ambiguity.js` + `core/ledger.js` + `core/seed.js`（只读校验，用于兼容旧 yaml）。

验收：

1. `plugin_manager list_plugins` 出现 `ouroboros`；`cordis_inspect_query`（`Config.listConfigs`）能看到它的 schema。
2. 新会话 `ooo interview 我想做一个 X`，**≥3 轮**由 `ask_user_question` 卡片呈现（选项 + 自定义文本），
   分数按公式下降，且**四重条件全部满足**才提示进入 Seed（构造一个"总分 0.18 但 goal clarity 0.70"的
   反例，断言仍不就绪）。
3. `ps -eo cmd | grep 'ouroboros mcp serve'` 无输出；`~/.ouroboros/ouroboros.db` mtime 不变。
4. `.ouroboros/ledger.jsonl` 行数 = 轮数；`jq -c .` 全部可解析。
5. LLM 调用出现在 DSH 的 session log 与 token 计量里（不再有看不见的模型调用）。
6. LLM 返回空/坏 JSON 时：重试 2 次 → 返回可读错误 + 保留账本，**不丢已答内容**。

### P1 — 决定性评测（5–7 天）

范围：`ooo_seed` + `ooo_evaluate`（S1/S2 + 触发矩阵 + 裁决）+ `core/gate.js`/`stage1.js`/`seed.js` +
技能 `ooo-seed`/`ooo-evaluate`。

验收：

1. AC 不满足 → `verdict.acceptance_state === 'rejected'`，`stage2` 带扣留原因链。
2. 删掉 `mechanical.toml` 或某条命令"未配置" → `unverified`（**不是** approved）；用
   `executed=false` 的伪造 check 断言同样得 `unverified`。
3. `reward_hacking_risk = 0.7` → 否决；`0.69` → 不否决；Stage3 全票赞成也翻不了 Stage2 的扣留。
4. Seed 未获批准时 `ooo_run` 拒绝执行且说明缺哪道门（宿主门在原生版**默认阻断**，
   与上游 `warn-only unless OUROBOROS_REQUIRE_CLIENT_GATES=1` 不同——这是刻意的差异，写进文档）。
5. Stage1 拒绝 shell 元字符与绝对路径可执行文件（单测即可，不必真跑）。
6. 一次真实仓库的 S1：用一个真实仓库 `mechanical.toml` 里现成的
   `node --test packages/<pkg>/test/spec.test.mjs` 当夹具。

### P2 — 执行与演化（7–10 天）

范围：`ooo_run`（子代理派发）+ `ooo_evolve`（workflowEngine 固定脚本）+ `core/converge.js`/`focus.js`。

验收：

1. 一次 `ooo_run` 产出 `runs/<id>/artifacts/`；worker prompt 里**不含** verify 命令/断言（grep 断言）。
2. `ooo_evolve` 在"相似度 ≥0.95 且 block gates 全清"或第 30 代停止；`lineage/*.jsonl` 每代一行，
   含相似度、grade、frozen AC。
3. 停滞/振荡/plateau/outcome-gate-第1代收敛 四种情形各有一个构造用例（不必真跑 30 代）。
4. 取消：`exec.signal` 后无遗留子进程（`ps` 复核）。

### P3 — 收尾（2 天）

1. 卸载 `@local/dsh-ouroboros-preset`；归档/删除仓库里的 `.ouroboros/` 胶水文件。
2. 只读兼容旧 seed（真实项目里的 `.ouroboros/seeds/*.yaml` 与上游仓库内的 seed yaml 都当夹具）。
3. 文档：安装、S1 命令来源、与 MCP 方案的回退关系。

---

## 7. 备选方案

| 方案 | 进程 | LLM 路径 | 状态 | 工作量 | 结论 |
|---|---|---|---|---|---|
| **A. 原生移植（本文）** | 0 | `ctx.llm` | workspace 文件 | 5–12k 行 / 3–4 周 | **推荐** |
| B. 混合：只做 P0+P1 | 0 | `ctx.llm` | workspace | 2–4k 行 | A 的前半，风险最低，收益最大（访谈 + 决定性评测） |
| C. 进程内嵌 Python（pyodide/pybind） | 0（但一个 runtime） | 仍需 litellm | 仍 SQLite | 巨大 | **否决**：还是"另一个操作系统" |
| D. 只搬 skills（零代码） | 0 | 会话模型 | 模型自述 | 1 天 | 可当探针；没有账本与验收权，等于放弃核心价值 |
| E. 保留 MCP，改一次性 CLI | 每次一个短进程 | litellm | SQLite | 1 天 | 只把常驻换冷启动（数秒），§1.4 的 2/3/5 一条没解 |

选 A 的理由：唯一同时消掉"额外进程 / 双 LLM 通道 / 双委派协议 / 账本在外"四个根因，
并把 ouroboros 的评测能力补到 DSH 现成的 ralph/workflow 上。

---

## 8. 风险与取舍

| 风险 | 影响 | 处置 |
|---|---|---|
| "完整引入"被误读成 1:1 复刻 | 期待值失配 | 本文把"完整"重定义为 §2 的 6 个契约 + 8 条纪律；宿主编排/UI/13 个 adapter 属于 DSH 已有能力 |
| 两份实现漂移 | 语义分叉 | 原生版**独占**账本；python 只读历史；把阈值写进 `contract.json`（0.2 / 0.75/0.65/0.70/0.60 / streak 2 / rounds 3 / 0.21 / 0.8 / 0.7 / 0.66 / 0.95 / 3 / 30 / min 3）并在测试里断言 |
| DSH API 在 rc 期间变动 | 委派/工具签名变（0.2.1-rc 已改制 managed activation） | 动手前用 `cordis_inspect_query` 取精确契约；写 `engines`/peer；只依赖 Service，不碰内部模块 |
| LLM 结构化输出不可靠 | 空响应 / 缺字段（本机已发生） | 纯 JSON 块 + 解析 + 重试 2 次；仍失败 → `unverified`/可读错误 + **保留账本**；需要 Seed 时走 `session_seed` 式确定性回退 |
| 上游语义自相矛盾 | 移植选错数 | 附录 B：min_generations 取 3；Stagnated 非终态；drift 不闸门；Stage2 解析失败在原生版选择"记 unverified"而非"中止流水线"（**刻意差异**） |
| 子代理不能提问 | 访谈被塞进子代理直接报错 | 架构钉死：访谈只在主会话；lane 只读 |
| Stage1 在沙箱里跑不动 | `npm install`/网络命令失败 | fail-closed 成 `unverified`；命令只从 `mechanical.toml` 取，**不从 `package.json` 猜**（实测已踩过） |
| token 成本 | 6 工具 + 1 段短提示 vs 36 工具 + ≤32 KB 指令 | P0 验收时记录一次请求的实际 token，作为后续回归基线 |
| 不做的部分 | PM 访谈 / brownfield / publish / maintain / TUI / 仪表盘 / 13 个 adapter | 明确列为非目标 |

---

## 附录 A：数据契约（移植时照这个写）

```ts
// Seed（冻结，extra 允许）
type Seed = {
  goal: string                       // minLength 1
  task_type: 'code'|'research'|'analysis'|'artifact'|'document'|'documentation'|'presentation'
  brownfield_context?: BrownfieldContext
  constraints: string[]
  acceptance_criteria: AC[]
  ontology_schema: { name: string; description: string; fields: OntologyField[] }   // 必填
  evaluation_principles: { name: string; description: string; weight: number }[]     // weight 0..1
  exit_conditions: { name: string; description: string; evaluation_criteria: string }[]
  metadata: { seed_id: `seed_${string}`; version: '1.0.0'; created_at: string;
              ambiguity_score: number; gate_forced?: boolean | null; interview_id?: string;
              parent_seed_id?: string; generation_mode: 'normal'|'partial_seed_from_evidence';
              degraded: boolean; unresolved_slots: string[]; recovery_reason?: string;
              decision_provenance: Record<string, number> }
}
type AC = { description: string; semantic_ac_key?: `ac_${string}`; verify_command?: string;
            expected_artifacts: string[]; output_assertion?: string;
            verify_exemption_reason?: string; investment?: InvestmentSpec }
// 不变量：output_assertion 必须伴随 verify_command
// semantic_ac_key = 'ac_' + sha256(JSON({description, verify_command, expected_artifacts,
//                   output_assertion}) 键排序、紧凑)[:16]   —— 排除数组位置与 metadata

// 评测结果（存 verdict.json）
type Verdict = { acceptance_state: 'approved'|'rejected'|'unverified'
                 stage1: { checks: { check_type: 'lint'|'build'|'test'|'static'|'coverage'
                                     passed: boolean; executed: boolean; exit_code: number|null
                                     message: string }[]; has_executed_evidence: boolean }
                 stage2?: { score: number; ac_compliance: boolean; goal_alignment: number;
                            drift_score: number; uncertainty: number; reward_hacking_risk: number;
                            reasoning: string }
                 stage3?: { approved: boolean; majority_ratio: number; votes: unknown[] }
                 failure_reason?: string }
```

## 附录 B：文档与代码冲突处（移植时以谁为准）

| 冲突 | 文档说 | 代码是 | 取 |
|---|---|---|---|
| Seed 就绪条件 | `docs/architecture.md:211`：只有 `ambiguity ≤ 0.2` | 还要四维下限 + 连续 2 次 + ≥3 轮 | **代码** |
| `min_generations` | `docs/guides/evolution-loop.md:109`：2 | `ConvergenceCriteria` 2、`EvolutionaryLoopConfig` 3 | **3**（更保守） |
| 停滞是否终止 | 文档列为终止信号 | STAGNATED 非终态，可恢复（映射 UNSTUCK） | **代码** |
| Stage 2 看到什么 | `evaluation-pipeline.md:218-231` 未提 | 看到声明的成功契约 + 执行证据；Stage 3 看不到 | **代码** |
| "3 模型投票" | `evaluation/__init__.py:8` | 可配置 roster + 0.66 比例，2 票即可 | **代码** |
| `satisfaction_threshold` | 配置项存在 | 硬编码 0.8，字段惰性 | **0.8** |
| drift 阈值 | status skill 里 0.15/0.30 | 触发矩阵用 `drift > 0.3`；循环里 drift 仅遥测 | **代码 + 只做展示** |
| 宿主客户端闸门 | skill 里是硬门 | `REQUIRED_CLIENT_GATES` 默认 warn-only，需 env 才阻断 | **原生版取阻断**（差异记录在案） |

## 附录 C：实现者交接清单

在新工作区里读这份文档开工时，按 C.1→C.5 走；每一条都对应正文里某个已踩过的坑。

### C.1 动手前

1. **不要去找现成的 DSH 原生 port**（§1.5），也不要复用 MCP bundle 的任何代码路径。
2. 用 `cordis_inspect_query`（host `Service`）取一次精确契约：`llm`、`tools`、`skills`、`subagents`、
   `workflowEngine`、`userQuestions`、`subprocess`、`fs`、`systemPrompt`、`commands`。
   §3 的证据是 0.2.1-rc.2 时点的；rc 之间会变（委派已从 fork/spawn 改成 managed activation）。
3. 读每个 `@deepseek-ai/dsh-<pkg>/README.md` 的 **Model Experience** 一节：它写明这个包会让模型
   看到什么，决定你的工具/技能是否需要额外提示。

### C.2 不要做的事

| 不要 | 原因 |
|---|---|
| 接 MCP / 起 Python 子进程 | 正是本项目要消除的东西（§1.4） |
| 引 litellm 或自带 API key | LLM 必须走 `ctx.llm`，否则绕过 harness 的模型选择、计量、重试（§1.3 的空响应就是这么丢的） |
| 写 `~/.ouroboros/ouroboros.db` | 账本落 workspace 的 `.ouroboros/`，否则不可 review、不随仓库走（§4.5） |
| 用 DSH session log 当账本 | 第三方插件不能写 `plugin:` 记录（`dsh-session` README） |
| 让子代理去问用户 | 子代理开人对人交互会报错；访谈只能在主会话（§3） |
| 从 `package.json` 猜 Stage-1 命令 | 实测踩过：猜出来的命令指向仓库里不存在的脚本（§1.3）；只从 `mechanical.toml` 取，探测不到就 `unverified` |
| 让模型决定"是否批准" | 只有 Stage-1 执行证据能授予批准，模型层只能扣留（§2.3） |
| 把 todo / plan 当账本 | 它们是可改的展示态；账本 append-only 且由代码写（§4.6） |
| 依赖 `ctx.llm` 的结构化输出 | `GenerateOptions` 只有 `temperature/maxTokens/stop`，没有 `response_format`；要手写解析 + 重试 + fail-closed（§3） |

### C.3 必须先写的确定性模块

`core/seed.js`（含 `semantic_ac_key`）、`core/ambiguity.js`（公式 + 四维下限 + streak + 0.21 钉子）、
`core/gate.js`（approved/rejected/unverified + `failure_reason` 优先级）、`core/stage1.js`
（argv 白名单 + `executed` 语义）、`core/converge.js` + `core/focus.js`、`core/ledger.js`。

先让这六个模块的单测全绿，再接工具与技能——顺序反过来会把不确定性混进内核。

### C.4 回读锚点（改任何数值前先读源码）

| 要改什么 | 读哪里 |
|---|---|
| Seed 字段 / AC 成功契约 | `core/seed.py:768-870`、`:530-563`、`:730-753` |
| 歧义公式 / 阈值 / 四维下限 | `bigbang/ambiguity.py:42-59`、`:296`、`:836-852` |
| 下一问与 closure 切换 | `bigbang/turn_planner.py:122-165`、`interview.py:1557-1573` |
| Seed 生成前的九道门 | `authoring_handlers.py:119-125, 1256-1320`、`core/seed_verify_gate.py:47-61` |
| 验收裁决 | `evaluation/models.py:34-40, 566-603` |
| 触发矩阵 / 计票 | `evaluation/trigger.py:31-37`、`consensus.py:399-405, 530-532` |
| Stage-1 执行细节 | `evaluation/mechanical.py:322-329, 357`、`languages.py:191-217, 229-306` |
| 收敛顺序 | `evolution/convergence.py:70-133, 394-410` |
| 相似度 / focus / rewind | `core/lineage.py:389-407`、`evolution/focus.py:193-282`、`loop.py:2027-2098` |
| 账本 schema / 重放 | `persistence/schema.py:42-227`、`event_store.py:1684-1721` |

### C.5 已经定下、不必再讨论的选择

- 6 个工具 / 5 个技能，工具名 `ooo_*`（§4.2）。
- 状态在项目内 `.ouroboros/`（§4.5）。
- 宿主侧审批门默认**阻断**（上游默认 warn-only，这是刻意的差异，见附录 B）。
- `min_generations` 取 3；停滞非终态；drift 不闸门（附录 B）。
- 非目标：PM 访谈 / brownfield / publish / maintain / TUI / dashboard / 14 个宿主 adapter（§0）。
