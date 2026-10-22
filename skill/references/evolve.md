# evolve — 收敛判据

`ooo_evolve` 的一代是：**run → evaluate → reflect 候选 Seed → 收敛判定**。每代追加一行
`lineage/<lineage_id>.jsonl`，含 `generation`、`similarity`、`grade`（裁决）、`stop_reason`、
`blocks`、`focus`。

## 相似度

```
similarity = 0.5 × 名称重合 + 0.3 × 类型匹配 + 0.2 × 完全一致
```

分母都是 `|旧 ∪ 新|`（按 `ontology_schema.fields` 的 `name` 取并集）。空并集视为 1.0。
候选 Seed 相对上一代 Seed 计算。第 1 代没有父本，记为 1.0。

## 收敛

`相似度 ≥0.95` **且** 全部 block gate 清空：

| block gate | 条件 |
|---|---|
| `evaluation_approved` | 本轮有评测且裁决为 `approved` |
| `seed_ac_coverage` | Seed 级 AC 覆盖完整（每条 AC 都有可判定结果） |
| `per_ac_authority` | 每条 AC 都有权威通过 |
| `score_threshold` | Stage2 `score ≥0.7` |
| `no_regression` | 历史上通过过、当前不是权威通过 → 回归 |
| `validation_passed` | 本轮 validation 通过 |

**提前收敛**：上述条件在第 `min_generations`（3）代之前满足，`stop_reason = early_converged`。
第 1 代就正确也能停。

## 停止条件

| 情形 | 判据 | `stop_reason` |
|---|---|---|
| 收敛 | 相似度 ≥0.95 且 block 清空 | `converged` |
| 提前收敛 | 收敛且代数 <3 | `early_converged` |
| 振荡 | 第 N 代 ≈ 第 N−2 代（相似度与分数差都 <0.01） | `oscillating` |
| 平台期 | 最近 3 代均未 approved 且相邻分差 <0.01 | `plateau` |
| 停滞 | 相似度 ≥0.95 连续 3 代（非终态；lineage 保留） | `stalled` |
| 代数上限 | 达到 `max_generations`（默认 8，上限 30，下限 1） | `max_generations` |

判定顺序：收敛 → 振荡 → 平台期 → 停滞 → 代数上限。除收敛外都只是"停止并报告"，不是"成功"。

## focus（冻结/活跃）

下一代的 AC 工作集：

- 没有 per-AC 证据、覆盖不完整、或聚合失败但没有指明失败 AC → **全量 active**（fail closed）。
- 否则 `frozen = 上一轮权威通过的 AC − 被挑战/回归/内容修改/新增`，`active = 全部 − frozen`。
- `rewind` 只截断 lineage 投影，不删除事件。

## 安全说明

演化产生的新 Seed 由循环自身写入并更新锁文件（`gates_passed: []`、带 `parent_seed_id` 与
`lineage_id`）。它**不代表**用户对新 Seed 的 restate 批准；需要人工确认时重新跑 `ooo_seed`。
