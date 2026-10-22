# ouroboros-dsh 实现规格（v1）

> **效力**：本文是实现规格。实现、评审、验收一律以本文为准。
> 历史调研、方案对比与被否决的备选方案见 [`research.md`](research.md)——那份文档**不含任何实现要求**，
> 只在需要追溯"某个数字为什么是这样"时查阅。
>
> 上游语义参考：Q00/ouroboros v0.55.x（MIT）。所有数值的源码锚点见附录 A。

---

## 1. 目标与非目标

**目标**：在 DeepSeek Harness 里跑通 spec-first 工作流（访谈 → Seed → 执行 → 评测 → 演化）：
LLM 走 `ctx.llm`，执行走 `ctx.subagents` / `ctx.workflowEngine`，状态落项目内 `.ouroboros/`。

**非目标**：PM 访谈、brownfield 仓库注册、`publish` / `maintain` 技能、TUI、dashboard、
多宿主适配层、MCP 传输、自带 LLM 后端与凭据、`~/.ouroboros/` 里的任何数据。

---

## 2. 交付形态（硬约束）

### 2.1 一个 bundle，一条 preset

- bundle 包名 `@local/ouroboros-dsh`；`dsh.bundle.patch: ./cordis.patch.yml`；纯 ESM、无构建、无运行时依赖。
- patch **只插入一条** `@deepseek-ai/dsh-agent-preset` 行：`id: preset-ouroboros`，
  `config: { id: ouroboros, name: Ouroboros, order: 5, plugins: [...] }`。
- 该 preset 的 `plugins` = **逐行照搬 shipped `standard` preset 的插件列表**，末尾追加一行本插件：
  `{ id: ouroboros, name: '@local/ouroboros-dsh' }`。
  - 照搬区以 `# scaffold-begin` / `# scaffold-end` 标注。`@deepseek-ai/dsh-agent-preset` 的 config
    只有 `id` / `name` / `description` / `order` / `plugins`，**没有继承字段**，所以必须整段复制；
    DSH 升级时整段重抄。
- **不在 profile 层加 host 行**：本插件只存在于该 preset 的作用域内。
- 与旧 MCP 方案**互斥**（两者都占 `preset-ouroboros` 行 id）：安装本 bundle 前先卸载
  `@local/dsh-ouroboros-preset`。

### 2.2 暴露面：一个技能，工具懒注册

- 启动时**只注册 1 个技能、不注册任何工具**：`ctx.skills.registerProvider({ list, get })`。
- 技能 `ooo`：`invocation: { modelInvocable: true, userInvocable: true }`；
  `description` ≤ 200 字，必须含触发词（ooo / 访谈 / 规格 / Seed / 评测 / 演化）与"先加载本技能再动手"。
- 6 个工具在 `get('ooo')` 被调用的那一刻注册（`ctx.tools.register`），注册必须幂等。
- 因为插件挂在 preset 作用域，技能与工具都进该 preset 的注册层：**其他 preset 的会话既看不到技能，
  也看不到工具**；本 preset 的会话在首次加载技能前，请求里也没有任何 `ooo_*` schema。

### 2.3 强制门：没有锁定 Seed 就不许写文件

- 监听 `agent/created`，用**该 agent 自己的 ctx** 注册守卫（`this.tools.guard(fn)`）。
  不得用插件自身 ctx——`guard` 在普通 ctx 上是全局的，会波及所有 preset。
- 守卫逻辑（同步、只读一个小 JSON）：工具名属于写文件类（`write` / `edit` / `str_replace_editor`）
  且目标落在会话工作区内时，读 `<cwd>/.ouroboros/seed.lock.json`；不存在则拒绝，理由固定为：
  `先加载技能 ooo 并完成访谈、锁定 Seed；当前项目没有已锁定的 Seed。`
- 守卫只能拒绝、不能授予；`bash` 内的写入不在守卫范围（已知缺口，见 §11）。

---

## 3. 架构

### 3.1 文件结构

```
ouroboros-dsh/
├── package.json            # name/type/exports/files/dsh.bundle.patch
├── cordis.patch.yml        # 一条 preset 声明（§2.1）
├── index.js                # export function apply(ctx, config)；export const inject = [...]
├── core/                   # 确定性内核：纯函数，无 IO，全部可单测
│   ├── seed.js             # 校验/解析/序列化 + semantic_ac_key
│   ├── ambiguity.js        # 打分、四维下限、streak、0.21 钉子、milestone、就绪判定
│   ├── gate.js             # approved|rejected|unverified + failure_reason 优先级
│   ├── stage1.js           # mechanical.toml → argv → 退出码 → 证据（executed 语义）
│   ├── trigger.js          # Stage2→Stage3 触发矩阵
│   ├── consensus.js        # 计票（≥2 票、ratio ≥0.66）与独立性标注
│   ├── converge.js         # 相似度、停滞、振荡、平台期、上限
│   ├── focus.js            # frozen/active 集合代数
│   └── ledger.js           # append-only jsonl：append / fold / query
├── tools/                  # 6 个工具，各一文件；只做编排，判定一律调 core/
├── skill/                  # 唯一技能
│   ├── SKILL.md            # 门面：触发、五步、硬门、references 指针、footer 规则
│   └── references/{contract,interview,seed,evaluate,evolve}.md
├── locale/{zh,en}.json
└── icon.svg
```

### 3.2 一次完整流程

```
用户 /ooo 我想做一个 X
   │  技能目录（1 行）→ 加载 skill ooo → 此刻注册 6 个工具
   ▼
ooo_interview ──► ctx.llm（下一问 + clarity 分量）──► ctx.userQuestions.ask（选项 + 自定义文本）
   │  确定性：core/ambiguity（打分、四维下限、streak）、core/ledger 追加
   └─ 就绪 = 总分 ≤0.2 ∧ 四维下限 ∧ 连续 2 次 ∧ ≥3 轮已答 ∧ 无未答
   ▼
ooo_seed ──► 九道门 → restate + 显式批准（plan-review intent）→ core/seed 校验
   │        └─ 失败：不写盘，返回缺口清单
   ▼  .ouroboros/seeds/seed_<id>.json + .ouroboros/seed.lock.json（解锁写入）
ooo_run ──► 每条 AC 派一个子代理（worker prompt 不含 verify_command / output_assertion）
   ▼  .ouroboros/runs/<run_id>/artifacts/
ooo_evaluate ──► Stage1：ctx.subprocess 跑 mechanical.toml 的命令（无 shell）
              ──► Stage2：新子代理（只读工具）看「声明的成功契约 + 执行证据」给结构化 JSON
              ──► 触发矩阵 → Stage3：3 个独立子代理投票
              ──► core/gate：approved | rejected | unverified
   ▼
ooo_evolve（可选）──► wonder/reflect → 新 Seed → run → evaluate，按 §7 收敛判据停止
```

### 3.3 确定性 / 生成式分界

| 只能由代码决定 | 允许 LLM |
|---|---|
| 歧义总分、四维下限、streak、0.21 钉子、milestone | clarity 分量与问句措辞 |
| Seed schema、AC 成功契约、`semantic_ac_key` | Seed / AC 文本起草 |
| 验收裁决、`executed` 语义、`failure_reason` 优先级 | Stage2 / Stage3 评审判断（只能扣留） |
| Stage1 argv 白名单、退出码、超时 | 从机械失败里总结"补什么" |
| 相似度、停滞/振荡/平台期、focus 集合代数、rewind | wonder 的"我们还不知道什么" |
| 账本 append/fold、投票计票、触发矩阵 | reflect 的规格修改建议 |

---

## 4. 数据契约

### 4.1 Seed（冻结；写入后不可变）

```jsonc
{
  "goal": "非空字符串",
  "task_type": "code | research | analysis | artifact | document | documentation | presentation",
  "constraints": ["硬约束"],
  "acceptance_criteria": [{
    "description": "非空",
    "semantic_ac_key": "ac_ + sha256(JSON{description,verify_command,expected_artifacts,output_assertion})[:16]",
    "verify_command": "字符串或 null",
    "expected_artifacts": ["workspace 相对路径"],
    "output_assertion": "字符串或 null",
    "verify_exemption_reason": "字符串或 null"
  }],
  "ontology_schema": { "name": "…", "description": "…", "fields": [{ "name": "…", "field_type": "…", "description": "…", "required": true }] },
  "evaluation_principles": [{ "name": "…", "description": "…", "weight": 1.0 }],
  "exit_conditions": [{ "name": "…", "description": "…", "evaluation_criteria": "…" }],
  "metadata": { "seed_id": "seed_<12hex>", "version": "1.0.0", "created_at": "ISO8601",
                "ambiguity_score": 0.0, "gate_forced": false, "interview_id": "…",
                "decision_provenance": { "user_confirmed": 0, "model_inferred": 0, "maintainer_policy": 0 } }
}
```

**不变量**
- `output_assertion` 非空时 `verify_command` 必须非空，否则拒绝。
- `semantic_ac_key` 只由成功契约派生，**不含数组位置与 metadata**：AC 在重试/换代后身份不变，
  成功契约变了才变。
- 校验失败一律不写盘。

### 4.2 Verdict（`.ouroboros/runs/<run_id>/verdict.json`）

```jsonc
{
  "acceptance_state": "approved | rejected | unverified",
  "failure_reason": "首个扣留/失败原因，或 null",
  "stage1": { "has_executed_evidence": true, "checks": [
      { "check_type": "lint|build|test|static|coverage", "passed": true,
        "executed": true, "exit_code": 0, "message": "…" } ] },
  "stage2": { "score": 0.0, "ac_compliance": true, "goal_alignment": 0.0, "drift_score": 0.0,
              "uncertainty": 0.0, "reward_hacking_risk": 0.0, "reasoning": "…" },
  "stage3": { "approved": false, "majority_ratio": 0.0, "votes": [], "reviewer_independence": "…" }
}
```

### 4.3 账本（`.ouroboros/ledger.jsonl`，append-only，只由代码写）

每行一个事件：

```jsonc
{ "seq": 1, "at": "ISO8601", "type": "interview.answered | interview.scored | seed.locked | run.started | run.completed | evaluate.stage1 | evaluate.stage2 | evaluate.stage3 | evaluate.verdict | evolve.generation | evolve.converged", "data": { } }
```

- 追加必须原子（`O_APPEND` + 单行 JSON + 换行）。
- `seq` 单调递增；读取时按 `seq` 折叠，冲突即报错。

### 4.4 运行目录

```
.ouroboros/
├── seed.lock.json                  # 存在即“已锁定”，守卫依据；不含正文，只有 seed_id + 哈希
├── seeds/seed_<id>.json            # 不可变正文
├── ledger.jsonl
├── mechanical.toml                 # Stage1 命令来源（沿用上游格式）
└── runs/<run_id>/
    ├── seed_snapshot.json
    ├── artifacts/
    ├── stage1.json  stage2.json  stage3.json
    └── verdict.json
```

---

## 5. 工具规格

所有工具：失败必须返回可读错误且**不改动**已有状态；写盘只走 `.ouroboros/`；
不得把 `verify_command` / `output_assertion` 交给执行侧。

| 工具 | 用途 | 参数 | 返回（要点） | 副作用 | 依赖 |
|---|---|---|---|---|---|
| `ooo_interview` | 一轮访谈：记答案 → 确定性打分 → 生成下一问 → 收用户答复 | `goal?`、`session_id?`、`answer?` | `{ question, options[], ambiguity, floors{...}, milestone, ready, ledger_lines, next_action }` | 追加账本；必要时 `seed.lock.json` 不动 | `ctx.llm`、`ctx.userQuestions`（**必须主会话**） |
| `ooo_seed` | 九道门 → restate + 批准 → 校验 → 锁 Seed | `session_id`、`force?` | `{ seed_id, path, gates[], forced, quality_notes[] }` | 写 `seeds/`、`seed.lock.json` | `ctx.llm`、`ctx.userQuestions`、子代理（closure 审计，只读） |
| `ooo_run` | 按 AC 派执行子代理，收集产物 | `seed_id`、`max_parallel?` | `{ run_id, acs[], artifacts[], children[] }` | 写 `runs/<id>/` | `ctx.subagents` / `ctx.workflowEngine` |
| `ooo_evaluate` | 三阶段评测 + 确定性裁决 | `seed_id`、`run_id?` | `{ acceptance_state, failure_reason, stage1, stage2?, stage3? }` | 写 `runs/<id>/{stage1,stage2,stage3,verdict}.json` | `ctx.subprocess`、子代理、`ctx.llm` |
| `ooo_evolve` | 一代或到收敛的演化循环 | `lineage_id?`、`seed_id`、`max_generations?`（默认 8，上限 30） | `{ lineage_id, generations, converged, similarity, stop_reason }` | 写 `lineage/<id>.jsonl`、`runs/` | `ctx.workflowEngine`（固定脚本）、`ctx.llm`、子代理 |
| `ooo_status` | 只读汇总：阶段/歧义/代数/最近裁决 | `cwd?` | `{ phase, ambiguity, locked, generations, last_verdict, footer }` | 无 | — |

**关于面试问答**：`ooo_interview` 自己调用 `ctx.userQuestions.ask()` 呈现选项卡片并等待答案；
**不得**把问题当作文本返回给模型转述（子代理不能开人对人交互，访谈必须在主会话）。

---

## 6. 技能规格

只有一个技能 `ooo`。`SKILL.md` 只写"门面"和硬性纪律，细节放 `references/`，由模型需要时用文件工具读取
（技能目录里只有 1 行摘要，`references/` 不产生常驻成本）。

`SKILL.md` 必须包含，且按此顺序：

1. **触发**：用户说 `ooo …`、`/ooo …`、"先规格后实现"、"把这个想法做成规格"、"自评/演化"。
2. **五步**：访谈 → Seed → 执行 → 评测 → 演化，每步一行，并写明"每一步都必须用对应工具，不得手工模拟"。
3. **硬门清单**（不可跳过）：refine 确认、歧义账本可见、`ready ≠ 可以写 Seed`（先 closure 审计）、
   restate + 显式批准、`approved` 只能来自 Stage1 执行证据。
4. **状态约定**：只读/只写 `.ouroboros/`；禁止写 `~/.ouroboros/`；账本只由工具写。
5. **references 指针**：`contract`（阈值与裁决）、`interview`（打分与提问）、`seed`（九道门）、
   `evaluate`（三阶段与隔离）、`evolve`（收敛判据）。
6. **footer**：每轮回复最后一行恰好一句 `◆ <当前状态> → next: <推荐动作>`，状态取自 `ooo_status`。
7. **禁止**：不得用 `bash` 直接改 `.ouroboros/` 里的文件；不得在未锁定 Seed 时写业务代码（守卫会拦）。

---

## 7. 确定性内核与阈值

所有模块均为纯函数；阈值集中在一个 `core/constants.js`，测试逐条断言。

| 项 | 值 | 说明 |
|---|---|---|
| 歧义总分 | `round(1 − Σ(clarity×weight), 4)` | greenfield 权重 goal 0.40 / constraint 0.30 / success 0.30；brownfield 0.35/0.25/0.25/0.15 |
| 就绪 | `总分 ≤ 0.2` ∧ `goal≥0.75` ∧ `constraint≥0.65` ∧ `success≥0.70` ∧（brownfield）`context≥0.60` ∧ 连续 2 次 ∧ ≥3 轮已答 ∧ 无未答 | 四者同时满足才算就绪 |
| 未答钉子 | 非首轮存在未答 → 分数 ≥ `0.21` | 永不就绪 |
| milestone | 总分 ≤1.0 initial / ≤0.4 progress / ≤0.3 refined / ≤0.2 ready | 仅展示 |
| Stage2 扣留 | `ac_compliance=false` ∨ `score<0.8` ∨ `reward_hacking_risk≥0.7` | 0.8 与 0.7 为常量 |
| Stage3 触发 | manual > seed 修改 > ontology 演化 > goal 重解释 > `drift>0.3` > `uncertainty>0.3` > lateral 采纳 | 首个命中即停；两个 0.3 严格大于 |
| Stage3 通过 | `赞成/有效票 ≥ 0.66` 且有效票 ≥2 | 有效票不足 = 错误 |
| 验收裁决 | 有 Stage1 执行证据 ∧ 模型层无扣留 → `approved`；无执行证据 → `unverified`；否则 `rejected` | 模型层只能扣留 |
| Stage1 命令集 | lint / build / test / static / coverage，来自 `.ouroboros/mechanical.toml` | 无 shell、白名单可执行、默认超时 300s；未配置 = 不算证据 |
| 覆盖率阈值 | 0.7 | 仅当 coverage 配了命令时判 |
| 相似度 | `0.5×名称重合 + 0.3×类型匹配 + 0.2×完全一致`，分母均为 `|旧 ∪ 新|` | 演化收敛用 |
| 收敛 | 相似度 ≥0.95 且全部 block gate 清空 | block：有评测且 approved、Seed 级 AC 覆盖、每 AC 权威、`score<0.7`、无回归、validation 通过 |
| 提前收敛 | outcome gate 通过即可在 `min_generations` 之前收敛 | 第 1 代就正确也能停 |
| 停滞 | 相似度 ≥0.95 连续 3 代 | 非终态，lineage 保留 |
| 振荡 | 第 N 代 ≈ 第 N−2 代 | 触发停止并报告 |
| 平台期 | 最近 3 代均未 approved 且相邻分差 <0.01 | 触发停止并报告 |
| 代数 | `min_generations=3`、`max_generations=30` | `ooo_evolve` 默认 8，上限 30 |
| 回归 | 历史上通过过、当前不是权威通过 → 回归 | per-AC 布尔，无阈值 |

**必须优先写的六个模块**（先单测全绿再接工具）：`seed`、`ambiguity`、`gate`、`stage1`、`converge`+`focus`、`ledger`。

---

## 8. 状态与并发

- 写文件：临时文件 + `rename` 原子替换；`.ouroboros/` 下不出现半写文件。
- 单写者假设：`.ouroboros/.lock`（`O_EXCL`）标记一个进行中的 run/evaluate；拿不到锁直接报错并提示已有 run。
- 账本：`O_APPEND` 单行写入，崩溃最多丢最后一行；读取按 `seq` 校验，断号即报错。
- 不写 DSH session log：第三方插件不能写 `plugin:` 记录，账本只能是自己文件。

---

## 9. 安装与使用

```bash
# 1) 卸载旧 MCP 方案（同占 preset-ouroboros 行 id）
#    plugin_manager action=remove_bundle target=@local/dsh-ouroboros-preset
# 2) 安装本 bundle（本地目录）
#    plugin_manager action=install_bundle target=/abs/path/to/ouroboros-dsh
# 3) 新建会话，模式选「Ouroboros」
```

- **验证**：`plugin_manager list_plugins` 出现 `preset-ouroboros`；
  `cordis_inspect_query`（`Config.listConfigs`，`name: '@local/ouroboros-dsh'`）能取到本插件的 schema；
  其他 preset 的新会话里**看不到** `ooo` 技能、也没有 `ooo_*` 工具。
- **日常使用**：`/ooo 我想做一个 X`，或直接说 `ooo interview 我想做一个 X`。
- **卸载**：`plugin_manager action=remove_bundle target=@local/ouroboros-dsh`。

---

## 10. 分期交付与验收

每期以可观测事实收口。括号里是验证手段。

### P0 门面与访谈（3–4 天）

交付：bundle + preset 声明 + 技能 `ooo`（含 `references/contract.md`）+ `core/{ambiguity,ledger,seed}.js`
+ `ooo_interview` + `ooo_status` + `agent/created` 守卫。

验收：
1. 选「Ouroboros」的新会话，工具清单里**只有** `ooo` 技能一行；`ooo_*` 工具不存在（读该会话最新 `request/header`）。
2. 加载技能或 `/ooo` 后，下一步 `request/header` 出现 6 个 `ooo_*`，且日志中有一条工具新增的 `developer/message`。
3. 其他 preset 的新会话：既无 `ooo` 技能条目，也无 `ooo_*`（同样的 header 检查）。
4. ≥3 轮问答走 `ask_user_question` 卡片；构造"总分 0.18 但 goal clarity 0.70"的用例，断言仍未就绪。
5. `.ouroboros/ledger.jsonl` 行数 = 已答轮数，`jq -c .` 全部可解析。
6. 没有锁定 Seed 时，`write` 被守卫拒绝并给出指向技能的理由；锁定后同一路径可写。
7. `ps -eo cmd | grep 'ouroboros mcp serve'` 无输出；`~/.ouroboros/ouroboros.db` mtime 不变。

### P1 Seed 与评测（5–7 天）

交付：`ooo_seed`（九道门 + 批准）、`ooo_evaluate`（Stage1/2 + 触发矩阵 + 裁决）、
`core/{gate,stage1,trigger,consensus}.js`、`references/{seed,evaluate}.md`。

验收：
1. AC 不满足 → `rejected`，`failure_reason` 指向首个扣留原因。
2. 删掉 `mechanical.toml`（或某条命令未配置）→ `unverified`，**不是** approved。
3. `reward_hacking_risk=0.7` 否决、`0.69` 不否决；Stage3 全票赞成不能推翻 Stage2 扣留。
4. Stage1 拒绝 shell 元字符与绝对路径可执行文件（单测）。
5. Seed 未获批准时 `ooo_run` 拒绝执行并列出缺哪道门。
6. 一次真实仓库的 Stage1：用真实 `mechanical.toml` 的命令跑通并写入 `stage1.json`。

### P2 执行与演化（7–10 天）

交付：`ooo_run`、`ooo_evolve`、`core/{converge,focus}.js`、`references/evolve.md`。

验收：
1. 一次 `ooo_run` 产出 `runs/<id>/artifacts/`；worker prompt 不含 `verify_command` / `output_assertion`（grep 断言）。
2. `ooo_evolve` 在"相似度 ≥0.95 且 block 清空"或第 30 代停止；`lineage/*.jsonl` 每代一行含相似度与 grade。
3. 停滞 / 振荡 / 平台期 / 第 1 代即收敛：四个构造用例各自命中正确 `stop_reason`。
4. 取消：`exec.signal` 后无遗留子进程（`ps` 复核）。

### P3 收尾（2 天）

1. 旧 `.ouroboros/*.yaml` seed 只读兼容（真实项目的 seed 当夹具）。
2. 文档：安装、`mechanical.toml` 来源、与 MCP 方案的回退关系写进 README。
3. 清理：确认没有写 `~/.ouroboros/`、没有遗留临时文件。

---

## 11. 约束与已知限制

| 约束 | 后果 | 应对 |
|---|---|---|
| 子代理不能开人对人交互 | 访谈只能在主会话 | 访谈工具只在主会话运行；子代理只做只读检索与评审 |
| `ctx.llm` 无结构化输出（只有 temperature/maxTokens/stop） | 评审结果要手写解析 | 要求纯 JSON 块；解析失败重试 2 次；仍失败 → `unverified` / 可读错误，**不猜** |
| 工具注册不在会话维度 | 同一 preset 内首次使用后工具常驻，已开会话收到"工具新增"消息并付一次 KV cache 失效 | 接受；不为此加复杂度 |
| `guard` 在普通 ctx 上是全局 | 必须按 agent 注册 | 只在 `agent/created` 里用 `this.tools.guard` |
| `bash` 内的写入不受守卫约束 | 守卫不是沙箱 | 已知缺口；如需更强约束靠会话权限模式，不在本插件范围 |
| preset 必须复制 `standard` 插件清单 | DSH 升级要重抄 scaffold | `scaffold-begin/end` 标注；升级列为维护动作 |
| preset 是 eager 装载 | 不用它也会加载插件代码 | 代价是进程内 JS，无子进程；不接受为此改成 host 常驻 |
| Stage1 在沙箱内可能跑不动（网络/安装类命令） | 得到 `unverified` | 这是正确行为；不为通过而放宽证据要求 |

---

## 附录 A：上游锚点（改数值前先读）

| 内容 | 位置 |
|---|---|
| Seed 字段 / AC 契约 / `semantic_ac_key` | `core/seed.py:768-870`、`:530-583`、`:730-753` |
| 歧义公式 / 阈值 / 四维下限 / 0.21 钉子 | `bigbang/ambiguity.py:36-59`、`:296`、`:836-852` |
| 就绪的合取与 streak | `bigbang/ambiguity.py:296-334`、`interview.py:53` |
| 下一问与 closure 切换 | `bigbang/turn_planner.py:122-165`、`interview.py:1557-1573` |
| 九道门与 force | `mcp/tools/authoring_handlers.py:119-125, 1256-1320`、`core/seed_verify_gate.py:47-61` |
| 验收裁决与三态 | `evaluation/models.py:34-40, 566-603` |
| Stage1 执行细节与 `executed` | `evaluation/mechanical.py:322-329, 357`、`languages.py:191-217, 229-306` |
| Stage2 字段与扣留 | `evaluation/semantic.py:36-68`、`models.py:220-254` |
| 触发矩阵 / 计票 / 独立性 | `evaluation/trigger.py:31-37`、`consensus.py:399-405, 530-532`、`reviewer_independence.py:47-248` |
| 收敛顺序 | `evolution/convergence.py:70-133, 394-410` |
| 相似度 / focus / rewind | `core/lineage.py:389-407`、`evolution/focus.py:193-282`、`loop.py:2027-2098` |
| 账本表结构与重放 | `persistence/schema.py:42-227`、`event_store.py:1684-1721` |

## 附录 B：数值决策（文档与代码冲突时取哪边）

| 项 | 文档说 | 代码是 | 本规格取 |
|---|---|---|---|
| Seed 就绪 | 只要 `≤0.2` | 还要四维下限 + 连续 2 次 + ≥3 轮 | 代码 |
| `min_generations` | 2 | 判据类 2、循环配置 3 | 3 |
| 停滞 | 视为终止 | 非终态、可恢复 | 代码 |
| Stage2 复看内容 | 未提 | 看到声明的成功契约 + 执行证据；Stage3 看不到 | 代码 |
| 共识投票 | "3 模型投票" | 可配置 roster + 0.66 比例，2 票即可 | 代码 |
| `satisfaction_threshold` | 配置项 | 硬编码 0.8，字段惰性 | 0.8 |
| drift 阈值 | 展示用 0.15/0.30 | 触发用 `>0.3`；循环里仅遥测 | 代码 + 只做展示 |
| 宿主客户端门 | 技能里是硬门 | 默认 warn-only，需 env 才阻断 | **本规格取阻断** |

## 附录 C：术语

- **Seed**：不可变规格，含 goal / AC / ontology / constraints / 评测原则 / 退出条件。
- **AC**：验收条件；成功契约 = `verify_command` + `expected_artifacts` + `output_assertion`。
- **Stage1 / 2 / 3**：机械检查 / LLM 语义评审 / 多票共识。只有 Stage1 能授予批准。
- **acceptance_state**：`approved` / `rejected` / `unverified`。
- **ledger**：`.ouroboros/ledger.jsonl`，append-only，只由代码写。
- **lineage**：演化血缘；每代一条记录，rewind 只截断投影不删事件。
- **block gate**：相似度达标后仍必须全部通过的收敛闸门集合（§7）。
