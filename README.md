# ouroboros-dsh

**Status: design only — no code yet.**

A native, in-process port of [Ouroboros](https://github.com/Q00/ouroboros)'s spec-first workflow into
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`):
interview → Seed → execute → evaluate → evolve, as a dsh plugin with **no Python sidecar, no MCP
bridge, and no second LLM path**.

## Why

The existing dsh integration (`dsh-ouroboros`) is a configuration-only bundle: one row that spawns
`ouroboros mcp serve` over stdio. That costs a persistent Python process (~310 MB measured with the
litellm extra), routes interview/Seed/QA calls through litellm instead of the harness model, exposes
36 MCP tools plus up to 32 KB of server instructions on every request, and — because it ships tools
without the 24 workflow skills — drops the approval gates, ledger visibility and delegation contract
that make Ouroboros more than a prompt.

This project ports the part a prompt cannot replace (the contracts and deterministic gates) and
deletes the part dsh already provides (host adapters, TUI, dashboard, job/fan-out transport).

## What it will ship

| Layer | Content |
|---|---|
| Tools (6) | `ooo_interview`, `ooo_seed`, `ooo_run`, `ooo_evaluate`, `ooo_evolve`, `ooo_status` |
| Skills (5) | `ooo`, `ooo-interview`, `ooo-seed`, `ooo-evaluate`, `ooo-evolve` — the discipline a tool cannot express |
| Deterministic core | ambiguity scoring + four-way readiness gate; Seed/AC validation with a stable `semantic_ac_key`; one acceptance gate (`approved` / `rejected` / `unverified`); convergence + focus algebra; append-only ledger |
| State | `.ouroboros/` inside the project (seeds, `ledger.jsonl`, runs, lineage) — reviewable, diffable, in-repo |
| Host wiring | `ctx.llm` (session model), `ctx.subagents` / `ctx.workflowEngine` (execution), `ctx.subprocess` (Stage 1), `ctx.skills` / `ctx.tools` / `ctx.userQuestions` |

No extra process, no credentials of its own, no second ledger.

## Install shape

One **host-level bundle** row in the profile patch — no new agent preset, nothing to pick in the
composer, no process. The plugin consumes host services (`ctx.llm`, `ctx.subagents`, `ctx.subprocess`,
`ctx.fs`, `ctx.userQuestions`) and contributes profile-wide tools plus five skills; all state lives in
the project's `.ouroboros/` directory. A preset-scoped variant is possible but documented as the
non-default option (see §4.7 of the design).

Exposure is **one skill by default**. Only the skill catalog line is resident; the six `ooo_*` tools are
registered when the skill is first loaded, so a session that never touches ooo carries no tool schemas.
A permanent `ctx.tools.guard` blocks writes until a Seed is locked — that is the part a prompt cannot
enforce, and it costs no model-visible tool. Details and the measured trade-offs are in §4.8.

Package identity, deliberately distinct from the upstream MCP bundle: repository `ouroboros-dsh`,
bundle `@local/ouroboros-dsh`, Loader row id `ouroboros`. Upstream's `dsh-ouroboros` name stays
reserved for its config-only MCP bundle.

## Read the design

- [docs/design.md](docs/design.md) — the full study (Chinese): current-state diagnosis with
  measurements, the six irreducible contracts with source references, the DSH primitive mapping,
  the target architecture, a four-phase plan with observable acceptance criteria, risks, and an
  appendix listing doc-vs-code conflicts in upstream.

## Scope

Non-goals: PM interview, brownfield repo registry, `publish` / `maintain` skills, TUI, dashboards,
and the 14 host adapters — either another product line or already dsh's job.

## Relation to upstream

Not affiliated with the Ouroboros project. The design references Q00/ouroboros v0.55.x (MIT).
Prior art worth reading: [pirobos](https://github.com/shseooo/pirobos) — a native TypeScript port of
the same loop for pi.dev — and [clauroboros](https://github.com/shseooo/clauroboros) for Claude Code.

## License

MIT — see [LICENSE](LICENSE).
