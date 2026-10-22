# contract — 阈值与验收裁决

所有数值的唯一来源是代码里的 `core/constants.js`；本文件是给人看的口径，冲突时以代码与
`docs/design.md` 为准。

## 节点阈值

| 项 | 值 | 说明 |
|---|---|---|
| 歧义总分 | `round(1 − Σ(clarity×weight), 4)` | greenfield：goal 0.40 / constraint 0.30 / success 0.30；brownfield：0.35 / 0.25 / 0.25 / 0.15 |
| 就绪 | 总分 `≤0.2` ∧ goal `≥0.75` ∧ constraint `≥0.65` ∧ success `≥0.70` ∧（brownfield）context `≥0.60` ∧ 连续 2 次 ∧ ≥3 轮已答 ∧ 无未答 | 全部同时满足 |
| 未答钉子 | 非首轮存在未答 → 分数 `≥0.21` | 永不就绪 |
| milestone | `≤1.0` initial / `≤0.4` progress / `≤0.3` refined / `≤0.2` ready | 仅展示 |
| Stage2 扣留 | `ac_compliance=false` ∨ `score<0.8` ∨ `reward_hacking_risk≥0.7` | 0.8 / 0.7 为常量 |
| Stage3 触发 | manual > seed 修改 > ontology 演化 > goal 重解释 > `drift>0.3` > `uncertainty>0.3` > lateral 采纳 | 首个命中即停；两个 0.3 都是**严格大于** |
| Stage3 通过 | 赞成/有效票 `≥0.66` 且有效票 `≥2` | 有效票不足 = 错误 |
| 验收裁决 | 有 Stage1 执行证据 ∧ 模型层无扣留 → `approved`；无执行证据 → `unverified`；否则 `rejected` | 模型层只能扣留 |
| Stage1 命令 | `lint/build/test/static/coverage`，来自 `.ouroboros/mechanical.toml` | 无 shell、白名单可执行、默认超时 300s；未配置不算证据 |
| 覆盖率阈值 | `0.7` | 仅当 coverage 配了命令时判 |

## 三态与 failure_reason

- `approved`：至少一条 Stage1 检查 `executed=true` 且全部执行检查 `passed=true`，Stage2 无扣留，
  Stage3（若触发）通过。
- `unverified`：没有任何执行证据（`mechanical.toml` 缺失 / 全部未配置 / 命令在解析期被拒），
  或 Stage2 输出无法解析。**绝不因此退化成 approved。**
- `rejected`：首个失败来源。优先级：Stage1 失败 → Stage2 扣留 → Stage3 未通过。

## 沙箱事实

`stage1.json` 与 `verdict.sandbox` 都记录 `{ mode, enforcement }`：

- `danger-full-access` → `enforcement: 'none'`（provider 不被咨询），必须在回复里转述。
- 旧 Landlock ABI / Windows ACL rung → `enforcement: 'partial'`：如实记录，不改变裁决。
- `confine()` 失败 → fail closed，拒绝执行；不得改走裸 spawn。
- 没有任何命令执行时 `enforcement: null`（没有执行事实可报）。

## 账本

`seq` 单调递增；读取按 `seq` 折叠，断号/重复/乱序都是错误。追加用 `O_APPEND` 单行写入，
崩溃最多丢最后一行。
