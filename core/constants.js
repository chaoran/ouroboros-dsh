/**
 * Every deterministic threshold in one place. Other modules import from here
 * and never hard-code a number; tests assert the values in this file.
 *
 * Source of truth: docs/design.md §7.
 */

/** greenfield interview dimension weights (goal / constraint / success). */
export const AMBIGUITY_WEIGHTS = Object.freeze({
  greenfield: Object.freeze({ goal: 0.4, constraint: 0.3, success: 0.3 }),
  brownfield: Object.freeze({ goal: 0.35, constraint: 0.25, success: 0.25, context: 0.15 }),
});

/** Dimension order used for display and floor iteration. */
export const DIMENSIONS = Object.freeze({
  greenfield: Object.freeze(['goal', 'constraint', 'success']),
  brownfield: Object.freeze(['goal', 'constraint', 'success', 'context']),
});

/** Interview modes. */
export const INTERVIEW_MODES = Object.freeze(['greenfield', 'brownfield']);

/** Ready: total ambiguous mass must be at most this. */
export const READY_TOTAL_MAX = 0.2;

/** Ready: per-dimension clarity floors (all must hold). */
export const READY_FLOORS = Object.freeze({
  goal: 0.75,
  constraint: 0.65,
  success: 0.7,
  context: 0.6,
});

/** Ready: consecutive ready-candidate rounds required. */
export const READY_STREAK = 2;

/** Ready: at least this many answered interview rounds. */
export const READY_MIN_ANSWERED_ROUNDS = 3;

/**
 * Unanswered-question pin: from the second round on, an unanswered question
 * forces the score to at least this value, so the interview can never be ready.
 */
export const UNANSWERED_PIN = 0.21;

/** Milestone bands (descending upper bounds, inclusive). Display only. */
export const MILESTONES = Object.freeze([
  Object.freeze({ name: 'initial', max: 1.0 }),
  Object.freeze({ name: 'progress', max: 0.4 }),
  Object.freeze({ name: 'refined', max: 0.3 }),
  Object.freeze({ name: 'ready', max: 0.2 }),
]);

/** Stage 2 withholds when score < this. */
export const STAGE2_SCORE_MIN = 0.8;

/** Stage 2 withholds when reward_hacking_risk >= this. */
export const STAGE2_REWARD_HACKING_MAX = 0.7;

/** Stage 3 trigger: drift_score strictly greater than this. */
export const TRIGGER_DRIFT = 0.3;

/** Stage 3 trigger: uncertainty strictly greater than this. */
export const TRIGGER_UNCERTAINTY = 0.3;

/** Stage 3 approves when approve/valid >= this ratio. */
export const STAGE3_APPROVAL_RATIO = 0.66;

/** Stage 3 requires at least this many valid votes; fewer is an error. */
export const STAGE3_MIN_VOTES = 2;

/** Stage 1 default per-command timeout, in milliseconds. */
export const STAGE1_TIMEOUT_MS = 300_000;

/** The only Stage-1 check types, in plan order. */
export const STAGE1_CHECK_TYPES = Object.freeze(['lint', 'build', 'test', 'static', 'coverage']);

/**
 * Executables Stage 1 may run. Commands come from `.ouroboros/mechanical.toml`;
 * anything outside this list is rejected before spawn (no shell, no absolute
 * executable paths).
 */
export const STAGE1_EXECUTABLE_ALLOWLIST = Object.freeze([
  'node',
  'npm',
  'npx',
  'pnpm',
  'yarn',
  'bun',
  'deno',
  'tsc',
  'eslint',
  'vitest',
  'jest',
  'mocha',
  'pytest',
  'python',
  'python3',
  'uv',
  'ruff',
  'mypy',
  'cargo',
  'rustc',
  'go',
  'make',
  'cmake',
  'swift',
  'dotnet',
  'mvn',
  'gradle',
  'php',
  'ruby',
  'rspec',
  'bundle',
  'rake',
  'shellcheck',
]);

/**
 * Shell metacharacters rejected in a Stage-1 command (outside quotes too:
 * the parser does not evaluate a shell, so every one of them is a hard error).
 */
export const STAGE1_SHELL_METACHARACTERS = Object.freeze([
  '&',
  '|',
  ';',
  '<',
  '>',
  '$',
  '`',
  '\n',
  '\r',
]);

/** Coverage threshold, applied only when a coverage command is configured. */
export const COVERAGE_THRESHOLD = 0.7;

/** Similarity weights: name overlap / type match / exact match. */
export const SIMILARITY_WEIGHTS = Object.freeze({ name: 0.5, type: 0.3, exact: 0.2 });

/** Convergence: similarity at or above this after all block gates clear. */
export const CONVERGE_SIMILARITY = 0.95;

/** Stall: similarity >= threshold for this many consecutive generations. */
export const STALL_GENERATIONS = 3;

/** Plateau: look at this many trailing generations. */
export const PLATEAU_WINDOW = 3;

/** Plateau: adjacent score deltas strictly below this. */
export const PLATEAU_SCORE_DELTA = 0.01;

/** Oscillation: generation N is "about" generation N-2 within this epsilon. */
export const OSCILLATION_EPSILON = 0.01;

/** Block gate: score must be at least this to call a generation converged. */
export const BLOCK_SCORE_MIN = 0.7;

/** Evolution loop defaults and bounds. */
export const MIN_GENERATIONS = 3;
export const MAX_GENERATIONS = 30;
export const DEFAULT_GENERATIONS = 8;

/** Task types accepted by the Seed schema. */
export const TASK_TYPES = Object.freeze([
  'code',
  'research',
  'analysis',
  'artifact',
  'document',
  'documentation',
  'presentation',
]);

/** Ledger event types (append-only). */
export const LEDGER_EVENT_TYPES = Object.freeze([
  'interview.answered',
  'interview.scored',
  'seed.locked',
  'run.started',
  'run.completed',
  'evaluate.stage1',
  'evaluate.stage2',
  'evaluate.stage3',
  'evaluate.verdict',
  'evolve.generation',
  'evolve.converged',
]);

/** Names of the six tools registered when the skill is loaded. */
export const TOOL_NAMES = Object.freeze([
  'ooo_interview',
  'ooo_seed',
  'ooo_run',
  'ooo_evaluate',
  'ooo_evolve',
  'ooo_status',
]);

/** Tools whose file effects the Seed gate guards. */
export const WRITE_TOOL_NAMES = Object.freeze(['write', 'edit', 'str_replace_editor']);

/** Fixed guard denial reason (design §2.3). */
export const SEED_GUARD_REASON =
  '先加载技能 ooo 并完成访谈、锁定 Seed；当前项目没有已锁定的 Seed。';

/** State directory (project-relative). */
export const STATE_DIR = '.ouroboros';

/** Seed lock file (project-relative). */
export const SEED_LOCK_FILE = '.ouroboros/seed.lock.json';

/** Ledger file (project-relative). */
export const LEDGER_FILE = '.ouroboros/ledger.jsonl';

/** Mechanical Stage-1 config file (project-relative). */
export const MECHANICAL_FILE = '.ouroboros/mechanical.toml';

/** Single-writer lock (project-relative, O_EXCL). */
export const WRITER_LOCK_FILE = '.ouroboros/.lock';
