# ouroboros-dsh

**Status: design only — no code yet.** The implementation spec is
[docs/design.md](docs/design.md).

A native, in-process port of [Ouroboros](https://github.com/Q00/ouroboros)'s spec-first workflow into
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`):
interview → Seed → execute → evaluate → evolve, as a dsh plugin with **no Python sidecar, no MCP
bridge, and no second LLM path**.

## Shape

| Decision | Value |
|---|---|
| Delivery | one bundle → **one agent preset** (`ouroboros`); nothing added at the profile/host layer |
| Exposure | **one skill** (`ooo`); the six `ooo_*` tools are registered only when that skill is first loaded |
| Enforcement | a per-agent `ctx.tools.guard` blocks file writes until a Seed is locked |
| LLM | `ctx.llm` (the session's own model — no litellm, no API key of its own) |
| Execution | `ctx.subagents` / `ctx.workflowEngine`; Stage 1 runs through `ctx.subprocess` (no shell) |
| State | `<project>/.ouroboros/` — seeds, `ledger.jsonl`, runs, lineage; reviewable and diffable |
| Naming | repo `ouroboros-dsh`, bundle `@local/ouroboros-dsh`, Loader row `ouroboros` |

Sessions on other presets see neither the skill nor the tools. Inside the Ouroboros preset, a session
that never loads the skill carries no tool schemas at all.

## Documents

- **[docs/design.md](docs/design.md)** — the implementation spec: data contracts, tool and skill
  specs, deterministic thresholds, state layout, install steps, four-phase plan with observable
  acceptance criteria, and known limits. **Start here.**
- [docs/research.md](docs/research.md) — the 2026-10-22 research record (upstream analysis, ecosystem
  survey, prior art, rejected alternatives). Background only; it states no requirements.

## Non-goals

PM interview, brownfield repo registry, `publish` / `maintain` skills, TUI, dashboards, the 14 host
adapters, MCP transport, and any data under `~/.ouroboros/`.

## Relation to upstream

Not affiliated with the Ouroboros project; design references Q00/ouroboros v0.55.x (MIT). Native ports
of the same loop exist for other hosts ([pirobos](https://github.com/shseooo/pirobos) for pi.dev);
their transferable decisions are already folded into the spec. Upstream's `dsh-ouroboros` name stays
reserved for its config-only MCP bundle — this project does not reuse it.

## License

MIT — see [LICENSE](LICENSE).
