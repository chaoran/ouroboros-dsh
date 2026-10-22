# ouroboros-dsh

**Status: P0–P2 implemented (bundle + preset + skill + six tools + deterministic core + tests).
Not yet installed into a live profile** — the install/live-session checks in
[Verification](#verification) are marked **待安装后验证**.

A native, in-process port of [Ouroboros](https://github.com/Q00/ouroboros)'s spec-first workflow into
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`):
interview → Seed → execute → evaluate → evolve, as a dsh plugin with **no Python sidecar, no MCP
bridge, and no second LLM path**.

The implementation spec is [docs/design.md](docs/design.md); it is the authority for every number
and interface below.

## Shape

| Decision | Value |
|---|---|
| Delivery | one bundle (`@local/ouroboros-dsh`) → **one agent preset** (`ouroboros`); nothing added at the profile/host layer |
| Exposure | **one skill** (`ooo`); the six `ooo_*` tools are registered only when that skill is first loaded |
| Enforcement | a per-agent `ctx.tools.guard` blocks file writes until a Seed is locked |
| LLM | `ctx.llm` (the session's own model — no litellm, no API key of its own) |
| Execution | `ctx.subagents`; Stage 1 runs through `ctx.subprocess`, wrapped by `ctx.sandbox.confine` |
| State | `<project>/.ouroboros/` — seeds, `ledger.jsonl`, runs, lineage; reviewable and diffable |
| Naming | repo `ouroboros-dsh`, bundle `@local/ouroboros-dsh`, Loader row `ouroboros` |
| Dependencies | none at runtime; pure ESM, no build step |

Sessions on other presets see neither the skill nor the tools. Inside the Ouroboros preset, a session
that never loads the skill carries no tool schemas at all.

## Repository layout

```
index.js                 apply(): skill provider + per-agent guard; no eager tools
core/                    deterministic, pure modules (constants, seed, ambiguity, gate,
                         stage1, trigger, consensus, converge, focus, ledger)
tools/                   six ooo_* tools + shared orchestration helpers
skill/SKILL.md           the one skill (facade: triggers, five steps, hard gates, footer)
skill/references/*.md    contract / interview / seed / evaluate / evolve
cordis.patch.yml         one preset-ouroboros row; scaffold-begin/end copies the shipped
                         standard plugin list verbatim (re-copy on DSH upgrade)
locale/{zh,en}.json      skill/tool display strings + footer template
test/                    node:test suites; every §7 threshold is asserted
```

## Install (design §9)

```bash
# 1) Remove the old MCP bundle first — both occupy the preset-ouroboros row id.
#    plugin_manager action=remove_bundle target=@local/dsh-ouroboros-preset
# 2) Install this bundle from a local directory.
#    plugin_manager action=install_bundle target=/abs/path/to/ouroboros-dsh
# 3) Start a new session and choose the "Ouroboros" preset.
```

Prerequisites:

- Session permission at least `workspace-write`. A `read-only` session cannot write
  `.ouroboros/`, so tools return a readable error asking you to switch modes.
  Under `danger-full-access` no execution is confined; results honestly carry
  `sandbox: { mode: 'danger-full-access', enforcement: 'none' }`.
- Uninstall: `plugin_manager action=remove_bundle target=@local/ouroboros-dsh`.

## Stage-1 commands: `.ouroboros/mechanical.toml`

Stage 1 only runs what this file declares — it never guesses from `package.json`:

```toml
lint = "pnpm run lint"
test = "node --test test/"
static = "node --check index.js"
# optional; seconds (default 300)
timeout = 600
```

Accepted keys are exactly `lint`, `build`, `test`, `static`, `coverage`, `timeout`. Commands are
tokenized and spawned **without a shell**: shell metacharacters (`& | ; < > $` backtick, newline),
absolute executable paths, programs containing path separators, and executables outside
`core/constants.js`'s allowlist are rejected before spawn. A missing file, or a key that is not
configured, is **not evidence** → the verdict is `unverified`, never `approved`.

## Relation to the MCP bundle

The previous approach (`@local/dsh-ouroboros-preset`, a config-only MCP bundle) and this one cannot
coexist: both declare the `preset-ouroboros` row id. Uninstall the MCP bundle before installing this
one; to roll back, remove this bundle and reinstall the MCP one. This project never reads or writes
`~/.ouroboros/`.

## Usage

```text
/ooo 我想做一个 X
ooo interview 我想做一个 X
```

The five steps are `/ooo` → `ooo_interview` → `ooo_seed` → `ooo_run` → `ooo_evaluate` (optional
`ooo_evolve`); `ooo_status` is the read-only summary. Every reply ends with exactly one footer line:
`◆ <当前状态> → next: <推荐动作>`.

## Tests

```bash
node --test 'test/**/*.test.js'
```

> Node's documented CLI takes glob patterns as positional arguments; a directory (`node --test test/`)
> is not a supported positional and fails with `Cannot find module .../test` on Node 24.11.1. The glob
> form above is the equivalent command and is what `npm test` uses. `node --test` with no arguments
> also discovers `test/**/*.test.js`.

Current result: **88 tests, 88 pass, 0 fail** (Node v24.11.1, no dependencies installed).

## Verification

### Verified without a live install (evidence = test name / file)

| Design item | Status | Evidence |
|---|---|---|
| §7 ambiguity formula, floors, streak, 0.21 pin, milestone | 做了 | `test/ambiguity.test.js`, `test/constants.test.js` |
| §7 readiness conjunction incl. "0.18 但 goal 0.70 仍未就绪" (§10 P0.4) | 做了 | `test/ambiguity.test.js` + 4-round flow in `test/tools.test.js` |
| §7 ledger = answered rounds, every line valid JSON (§10 P0.5) | 做了 | `test/tools.test.js` (`ledger_lines`/`answered`) |
| §7 Stage-2 withholding 0.8 / 0.7 boundary; Stage 3 cannot overturn (§10 P1.3) | 做了 | `test/gate.test.js` |
| §7 Stage-1 shell metachar / absolute executable rejection, fail-closed at verdict (§10 P1.4) | 做了 | `test/stage1.test.js`, `test/tools.test.js` |
| §7 trigger matrix priority + strict `> 0.3` | 做了 | `test/trigger.test.js` |
| §7 consensus ratio 0.66 / ≥2 valid votes / independence | 做了 | `test/consensus.test.js` |
| §7 similarity, convergence, stall, oscillation, plateau, generation caps, focus/rewind (§10 P2.3) | 做了 | `test/converge.test.js`, `test/focus.test.js` |
| §7 gate priority; no evidence → `unverified`; Stage-1 failure → `rejected` (§10 P1.1/P1.2) | 做了 | `test/gate.test.js`, `test/tools.test.js` |
| §2.1 preset copied verbatim from shipped `standard` + one trailing row | 做了 | `test/plugin.test.js` diffs against the installed `standard.patch.yml` |
| §2.2 startup exposes exactly 1 skill / 0 tools; loading the skill registers 6 idempotently | 做了 | `test/plugin.test.js` |
| §2.3 guard registered per agent via `agent/created`, denies writes until lock, allows after | 做了 | `test/plugin.test.js` (fake agent ctx; live check below) |
| §5/§10 P2.1 worker prompt excludes `verify_command` / `output_assertion` | 做了 | `test/plugin.test.js` (`buildWorkerPrompt`) |
| §2.4 `danger-full-access` reported as `enforcement: 'none'`; `workspace-write` records `full`/`partial`; `confine()` failure fails closed; `read-only` writes return a readable error | 做了 | `test/tools.test.js` |
| §10 P1.5 `ooo_run` refuses without a locked Seed; a tampered Seed body fails the lock hash | 做了 | `test/tools.test.js` |
| §10 P2.4 (unit half) — `exec.signal` aborts the Stage-1 spawn signal, calls `terminate()`, and waits for `waitForExit` | 做了 | `test/run-confined.test.js` |
| §8/§12 — a failing `ooo_run` releases `.ouroboros/.lock`; `continuing:true` cold-resumes via `sendMessage` and never silently spawns | 做了 | `test/tools.test.js` |
| §3.1 file tree, no runtime dependencies, no `~/.ouroboros` writes / MCP spawn (static half of §10 P0.7) | 做了 | `test/boundaries.test.js` |

### 待安装后验证 (needs a live profile/session)

1. §10 P0.1 — new Ouroboros session: latest `request/header` lists only the `ooo` skill, no `ooo_*`.
2. §10 P0.2 — after `/ooo` or loading the skill: next `request/header` has six `ooo_*` tools and the
   log contains a tool-addition `developer/message`.
3. §10 P0.3 — a session on another preset sees neither `ooo` nor `ooo_*` (same header check).
4. §10 P0.6 — live `write` denial before the Seed lock, allowed after; and the guard must not leak to
   other presets.
5. §10 P0.7 / §9 — `plugin_manager list_plugins` shows `preset-ouroboros`; `cordis_inspect_query`
   (`Config.listConfigs`, `name: '@local/ouroboros-dsh'`) returns the schema; no
   `ouroboros mcp serve` process; `~/.ouroboros/ouroboros.db` mtime unchanged.
6. §10 P1.6 — one real repository Stage-1 run with its real `mechanical.toml` writing `stage1.json`.
7. §10 P2.1 (artifacts half) — a real `ooo_run` produces `runs/<id>/artifacts/`.
8. §10 P2.2 — a live `ooo_evolve` appends `lineage/*.jsonl` and stops at the configured cap.
9. §10 P2.4 — cancel via `exec.signal`, then confirm with `ps` that no child process remains.

## Known limits / follow-ups

- **Evolve orchestration is native JS**, not a `ctx.workflowEngine` script: workflow scripts cannot
  call this plugin's own `ooo_run`/`ooo_evaluate`, so the deterministic loop lives in code. The tool
  still uses `ctx.llm` and `ctx.subagents` for the model/execution work.
- **Closure audit is a pure `ctx.llm` call**, not a read-only subagent. This is the stronger isolation
  argument from design §2.4; a subagent would only be *asked* to stay read-only.
- **Per-AC authority in evolve** is derived from the aggregate verdict plus per-AC artifact
  `stop_reason`; Stage 1 remains project-wide (five `mechanical.toml` check types), matching the
  spec's Stage-1 vocabulary.
- `ooo_run({ continuing: true })` uses `ctx.subagents.sendMessage` plus `whenIdle()` to rejoin the
  same child; it is best-effort and untested against a live provider.
- Guard does not cover `bash`-internal writes (design §11 known gap); the sandbox is the boundary
  there.
- `enforcement: 'partial'` (old Landlock ABI) is recorded, never hidden, and never changes the verdict.

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
