# ooo — Ouroboros 规格先行工作流

## 1. 触发

用户说 **`ooo …`**、**`/ooo …`**、"先规格后实现"、"把这个想法做成规格"、"自评 / 演化" 时，用本技能。
先加载本技能再动手；技能目录只占一行，细节按需读 `references/`。

## 2. 五步（每一步都必须用对应工具，不得手工模拟）

1. **访谈** → `ooo_interview`（工具自己弹问题卡片；不得把问题转述给模型代答）
2. **Seed** → `ooo_seed`（九道门 → restate → 显式批准 → 校验 → 锁定）
3. **执行** → `ooo_run`（每条 AC 一个执行子代理，产物进 `runs/<id>/artifacts/`）
4. **评测** → `ooo_evaluate`（Stage1 机械 → Stage2 语义 → 触发矩阵 → Stage3 共识 → 裁决）
5. **演化** → `ooo_evolve`（run → evaluate → reflect；按收敛判据停）

只读汇总用 `ooo_status`；它给出本轮回复必须附带的 footer。

## 3. 硬门清单（不可跳过）

- **refine 确认**：每次 Seed 变更都要重新走 restate，用户旧的"可以"不构成对新版本的批准。
- **歧义账本可见**：每一轮都要让用户看到 `ambiguity.total`、四维下限与 streak；它们来自账本，不来自模型口算。
- **`ready ≠ 可以写 Seed`**：就绪只表示访谈可以收口，写 Seed 前必须先做 **closure 审计**（`ooo_seed` 内部执行）。
- **restate + 显式批准**：`ooo_seed` 用 `plan-review` intent 呈现完整 Seed，必须拿到"批准并锁定"才算数。
- **`approved` 只能来自 Stage1 执行证据**：Stage2 / Stage3 只能扣留；没有执行证据一律 `unverified`，不是 approved。

## 4. 状态约定

- 只读写项目内 `<project>/.ouroboros/`：`seeds/`、`ledger.jsonl`、`runs/`、`lineage/`、`mechanical.toml`。
- **禁止**写 `~/.ouroboros/`（本项目不拥有那里的任何数据）。
- 账本只由工具写：append-only、`seq` 单调、单行 JSON；模型不得手改。
- Seed 锁定后不可变；新版本 = 新 `seed_id`。
- `.ouroboros/seed.lock.json` 存在即"已锁定"；它是写文件守卫的唯一依据。

## 5. references 指针

- [`references/contract.md`](references/contract.md) — 阈值与验收裁决（改数值前先读）
- [`references/interview.md`](references/interview.md) — 打分、四维下限、0.21 钉子、提问
- [`references/seed.md`](references/seed.md) — 九道门、force、`semantic_ac_key`
- [`references/evaluate.md`](references/evaluate.md) — 三阶段与沙箱隔离
- [`references/evolve.md`](references/evolve.md) — 相似度、收敛/停滞/振荡/平台期

## 6. footer

每轮回复的**最后一行**恰好一句：

```
◆ <当前状态> → next: <推荐动作>
```

状态取自 `ooo_status` 的 `footer` 字段，原样输出，不增删字词。

## 7. 禁止

- 禁止用 `bash` 直接改 `.ouroboros/` 里的文件（账本、Seed、锁）。
- 未锁定 Seed 时禁止写业务代码：`write` / `edit` / `str_replace_editor` 会被守卫拒绝。
- 禁止把 `verify_command` / `output_assertion` 交给执行子代理或写进 worker prompt。
- 禁止在 `danger-full-access` 会话里假装验收"受限"：`ooo_evaluate` 会如实返回 `sandbox.enforcement = 'none'`，必须转述给用户。
