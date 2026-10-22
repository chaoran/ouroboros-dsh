# interview — 打分与提问

## 一轮做什么

1. 记录用户答案（人对人卡片：`ctx.userQuestions.ask`，**必须在主会话**）。
2. 更新四维 clarity（模型只给分量，0..1）。
3. `core/ambiguity.js` 计算总分、四维下限、streak、0.21 钉子、milestone、就绪。
4. 生成下一个问题（模型只给措辞与选项，维度由代码挑最弱的一维）。
5. 追加账本并返回 `question / options / ambiguity / floors / milestone / ready / ledger_lines / next_action`。

## 分数

```
total = round(1 − Σ(clarity_d × weight_d), 4)
```

- greenfield 权重：goal 0.40 / constraint 0.30 / success 0.30
- brownfield 权重：goal 0.35 / constraint 0.25 / success 0.25 / context 0.15

## 就绪（合取，缺一不可）

- `total ≤ 0.2`
- 四维下限：goal `≥0.75`、constraint `≥0.65`、success `≥0.70`、（brownfield）context `≥0.60`
- **连续 2 次**满足上述条件（streak）
- **≥3 轮**已答
- 没有未答问题

> 例：总分 0.18 但 goal clarity 0.70 → 未就绪。分数低不等于可以收口。

## 0.21 钉子

非首轮（`answered_rounds > 0`）存在未答问题时，分数**至少** 0.21。钉子只抬高下限，不降低真实
分数；有钉子的轮次永远不就绪。

## milestone

`≤1.0` initial、`≤0.4` progress、`≤0.3` refined、`≤0.2` ready。仅用于展示进度，不参与就绪判定。

## 提问规则

- 每轮只问**一维**：当前 clarity 最低的那一维（brownfield 含 context）。
- 选项 2–4 个，另允许自定义文本。
- 问题必须能引出"可验证的说法"，不要问"还有什么吗"。
- 模型输出无法解析时使用确定性回退问题；打分回退为 +0.2（被问维度）/ +0.05（其它维度），
  并在返回的 `ambiguity.scoring_source` 里标明 `deterministic_fallback`。

## 账本

每轮恰好一行 `interview.answered`：问题、答案、来源、评分来源，以及整块确定性评分
（总分、clarity、milestone、streak、ready）。因此 `ledger.jsonl` 的行数 = 已答轮数
（§10 P0.5）。`interview.scored` 保留为外部重打分时的类型，本工具不再单独追加第二行。
