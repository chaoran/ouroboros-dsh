# seed — 九道门

`ooo_seed` 的顺序：**起草 Seed → 校验 → closure 审计 → restate + 显式批准 → 九道门 → 写盘 + 锁**。
任何一步不过：**不写盘**，返回缺口清单。

## 九道门

| # | 门 | 通过条件 |
|---|---|---|
| 1 | `answered_rounds` | 已答轮数 ≥3 |
| 2 | `ambiguity_threshold` | 总分 ≤0.2 |
| 3 | `clarity_floors` | 四维下限全满足 |
| 4 | `ready_streak` | 连续就绪候选 ≥2 次 |
| 5 | `requirement_distillation` | closure 审计通过（没有未解决的需求缺口） |
| 6 | `ac_success_contract` | 每条 AC 有 `verify_command` 或 `verify_exemption_reason` |
| 7 | `restate_approved` | 用户对完整 restate 显式选择"批准并锁定"（`plan-review` intent） |
| 8 | `client_acceptance_gate` | 用户确认"Seed 就绪验收" |
| 9 | `explicit_force` | 记录本次是否使用 `force`；真实分数照录 |

`force=true` 只绕过 **1–4**；第 5–8 道门永远不能绕过。绕过后 `metadata.gate_forced=true`，
`metadata.ambiguity_score` 保留真实分数，账本 `seed.locked` 也记录 `gate_forced`。

## Seed 不变量（`core/seed.js`）

- `goal` 非空；`task_type` ∈ `code|research|analysis|artifact|document|documentation|presentation`。
- 每条 AC：`description` 非空；`verify_command` / `output_assertion` / `verify_exemption_reason`
  为字符串或 `null`；`expected_artifacts` 是 workspace 相对路径（拒绝绝对路径与 `..`）。
- **`output_assertion` 非空时 `verify_command` 必须非空**。
- `semantic_ac_key = "ac_" + sha256(JSON{description, verify_command, expected_artifacts,
  output_assertion})[:16]`：只由成功契约派生，**不含数组位置与 metadata**。
- `metadata.seed_id` 形如 `seed_<12hex>`；`created_at` 是 ISO8601；`ambiguity_score` ∈ 0..1；
  `gate_forced` 布尔；`decision_provenance` 三个非负整数。
- 校验失败一律不写盘。

## 锁定

- 正文写 `seeds/seed_<id>.json`（不可变；新版本 = 新 id）。
- `seed.lock.json` **只含** `seed_id` / `hash` / `gates_passed` / `gate_forced` / `ambiguity_score` /
  `interview_id` / `created_at`，不含正文。存在即"已锁定"，是写文件守卫与 `ooo_run` 的依据。
- 锁文件用临时文件 + `rename` 原子替换；不会出现半写状态。

## 与执行的关系

`ooo_run` 在下列任一情况拒绝执行并列出缺哪道门：没有 `seed.lock.json`、锁定的 seed_id 不匹配、
Seed 正文缺失、Seed 校验失败、**Seed 正文哈希与锁文件不一致**（冻结后不可变）。
`ooo_evaluate` 与 `ooo_evolve` 同样校验该哈希。
