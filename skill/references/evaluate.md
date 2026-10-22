# evaluate — 三阶段与隔离

`ooo_evaluate` 读取已锁定的 Seed 与一次 run，按 Stage1 → Stage2 → 触发矩阵 → Stage3 → 裁决执行。
**只有 Stage1 能授予 `approved`。**

## Stage 1 — 机械检查（唯一能授予批准）

- 命令来源：`.ouroboros/mechanical.toml`，键为 `lint` / `build` / `test` / `static` / `coverage`，
  可选 `timeout`（秒，默认 300）。
- **无 shell**：命令被切成 argv 后直接 spawn。拒绝 shell 元字符（`& | ; < > $ \``、换行）、
  绝对路径可执行文件、带路径分隔符的程序，以及白名单外的程序。
- 判定：`passed = (exit_code === 0)`；超时 → `executed=true, passed=false, exit_code=-1`。
- **未配置 = 不算证据**：`executed=false`，不参与 approved。
- **声明了但被拒绝的命令是硬失败**（shell 元字符 / 绝对路径 / 白名单外）：记
  `executed=true, passed=false`，裁决为 `rejected`，绝不静默跳过。
- `mechanical.toml` 本身语法错误 → 拒绝评测（fail closed），不写新 verdict。
- `coverage` 额外要求解析出的覆盖率 `≥0.7`；解析不到即失败。
- 策略：`workspace-write`，`workspaceRoot` = 项目根。调用 `ctx.sandbox.confine(argv, policy, signal)`；
  provider 失败 → **fail closed**（报错，不改走裸 spawn）。
- `danger-full-access`：provider 不被咨询，结果记 `sandbox = { mode: 'danger-full-access', enforcement: 'none' }`。
- 落盘：`stage1.json` 含 `checks`、`has_executed_evidence`、`sandbox`；`verdict.sandbox` 同值。

## Stage 2 — 语义评审（纯 `ctx.llm`，不是子代理）

- 看到：goal、constraints、**声明的成功契约**（`verify_command` / `expected_artifacts` /
  `output_assertion`）、执行证据（命令 + 退出码 + 尾部）、run artifacts 摘要。
- 输出 JSON：`score`、`ac_compliance`、`goal_alignment`、`drift_score`、`uncertainty`、
  `reward_hacking_risk`、`reasoning`、`items`（P0/P1/P2 条目，供人看）、`flags`（触发矩阵用）。
- 扣留条件：`ac_compliance=false` ∨ `score<0.8` ∨ `reward_hacking_risk≥0.7`。
- 解析失败重试 2 次（共 3 次）；仍失败 → 裁决 `unverified`，不猜。
- 隔离：没有工具、没有进程、没有文件访问——比"只读子代理"更强。

## 触发矩阵 → Stage 3

优先级（首个命中即停）：manual > Seed 修改 > ontology 演化 > goal 重解释 > `drift_score > 0.3` >
`uncertainty > 0.3` > lateral 采纳。两个 0.3 都是严格大于。

## Stage 3 — 三票共识（纯 `ctx.llm`）

- 三个独立 reviewer（不同 reviewer id、独立上下文）各投一票。
- 通过：赞成/有效票 `≥0.66` 且有效票 `≥2`；有效票不足是**错误**，不是否决。
- `reviewer_independence`：`independent`（id 互异）/ `shared-context`（重复 id）/ `unlabeled`。
- **Stage3 全票赞成也不能推翻 Stage2 扣留。**

## 裁决（`core/gate.js`）

1. 没有 Stage1 执行证据 → `unverified`
2. 有执行检查失败 → `rejected`（`failure_reason` = 首个失败）
3. Stage2 缺失/不可解析 → `unverified`
4. Stage2 或 Stage3 扣留 → `rejected`
5. 否则 → `approved`

落盘：`runs/<run_id>/{stage1,stage2,stage3,verdict}.json`，并追加
`evaluate.stage1 / stage2 / stage3 / verdict` 账本事件。
