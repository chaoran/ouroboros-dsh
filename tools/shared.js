/**
 * Shared orchestration helpers for the six `ooo_*` tools: workspace paths,
 * atomic writes, the single-writer lock, ledger access, LLM calls, sandbox
 * resolution, and confined subprocess execution.
 *
 * No `@deepseek-ai/*` imports: the bundle declares no runtime dependencies and
 * talks to services exclusively through `ctx`.
 */
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  LEDGER_FILE,
  MECHANICAL_FILE,
  SEED_LOCK_FILE,
  STATE_DIR,
  WRITER_LOCK_FILE,
} from '../core/constants.js';
import { appendEvent, readEvents } from '../core/ledger.js';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

/** Readable, actionable tool failure. */
export class OuroborosError extends Error {
  constructor(message, code = 'OUROBOROS_ERROR') {
    super(message);
    this.name = 'OuroborosError';
    this.code = code;
  }
}

/** Project root for one agent: its session cwd, else the process cwd. */
export function projectRoot(agent) {
  return agent?.session?.header?.cwd ?? process.cwd();
}

/** All project-relative state locations. */
export function projectPaths(root) {
  return {
    root,
    state_dir: join(root, STATE_DIR),
    seeds_dir: join(root, STATE_DIR, 'seeds'),
    runs_dir: join(root, STATE_DIR, 'runs'),
    lineage_dir: join(root, STATE_DIR, 'lineage'),
    interviews_dir: join(root, STATE_DIR, 'interviews'),
    lock_file: join(root, SEED_LOCK_FILE),
    ledger_file: join(root, LEDGER_FILE),
    mechanical_file: join(root, MECHANICAL_FILE),
    writer_lock: join(root, WRITER_LOCK_FILE),
  };
}

/** Create the state directories, mapping a read-only workspace to a readable error. */
export function ensureStateDirs(paths) {
  for (const dir of [
    paths.state_dir,
    paths.seeds_dir,
    paths.runs_dir,
    paths.lineage_dir,
    paths.interviews_dir,
  ]) {
    try {
      mkdirSync(dir, { recursive: true });
    } catch (error) {
      if (error?.code === 'EROFS' || error?.code === 'EACCES' || error?.code === 'EPERM') {
        throw new OuroborosError(
          `当前会话无法写 ${STATE_DIR}/（${error.code}）。把会话权限切到 workspace-write 后重试；read-only 会话无法记录账本与 Seed。`,
          'NOT_WRITABLE',
        );
      }
      throw error;
    }
  }
}

/** Whether a regular file exists. */
export function fileExists(path) {
  try {
    return existsSync(path);
  } catch {
    return false;
  }
}

/** Read a UTF-8 file, or `undefined` when absent. */
export function readText(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
}

/** Read JSON, or `undefined` when absent. A corrupt file throws a readable error. */
export function readJson(path) {
  const text = readText(path);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new OuroborosError(`${path} 不是合法 JSON（不允许半写/手改文件）`, 'CORRUPT_STATE');
  }
}

/** Atomic JSON write: temp file in the same directory, then rename. */
export function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    const payload = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    const fd = openSync(temp, 'w');
    try {
      let offset = 0;
      while (offset < payload.length) {
        offset += writeSync(fd, payload, offset, payload.length - offset);
      }
    } finally {
      closeSync(fd);
    }
    renameSync(temp, path);
  } catch (error) {
    try {
      rmSync(temp, { force: true });
    } catch {
      // best effort cleanup
    }
    if (error?.code === 'EROFS' || error?.code === 'EACCES' || error?.code === 'EPERM') {
      throw new OuroborosError(
        `当前会话无法写 ${path}（${error.code}）。把会话权限切到 workspace-write 后重试；read-only 会话只读不写。`,
        'NOT_WRITABLE',
      );
    }
    throw error;
  }
}

/** Lexically decide whether `target` lands inside `root`. */
export function isInsideWorkspace(root, target) {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(target);
  const rel = relative(resolvedRoot, resolvedTarget);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** Resolve a model-supplied path against the workspace root. */
export function resolveWorkspacePath(root, target) {
  return isAbsolute(target) ? resolve(target) : resolve(root, target);
}

/**
 * Single-writer lock (`O_EXCL`). Callers must release it in a `finally`.
 * @returns {() => void} release
 */
export function acquireWriterLock(paths, label = 'run/evaluate') {
  mkdirSync(paths.state_dir, { recursive: true });
  let fd;
  try {
    fd = openSync(paths.writer_lock, 'wx');
  } catch (error) {
    if (error?.code === 'EEXIST') {
      const holder = readText(paths.writer_lock) ?? '';
      throw new OuroborosError(
        `已有进行中的 ${label}（${WRITER_LOCK_FILE} 被占用：${holder.trim() || '未知持有者'}）。等待它结束，或确认无进程后删除该锁文件。`,
        'BUSY',
      );
    }
    if (error?.code === 'EROFS' || error?.code === 'EACCES' || error?.code === 'EPERM') {
      throw new OuroborosError(
        `当前会话无法写 ${STATE_DIR}/（${error.code}）；切到 workspace-write 后重试。`,
        'NOT_WRITABLE',
      );
    }
    throw error;
  }
  writeSync(fd, `${process.pid} ${new Date().toISOString()} ${label}\n`);
  closeSync(fd);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    rmSync(paths.writer_lock, { force: true });
  };
}

/** Append one ledger event and return it. */
export function appendLedger(paths, type, data) {
  ensureStateDirs(paths);
  return appendEvent(paths.ledger_file, type, data);
}

/** Fold the ledger (throws on seq gap). */
export function readLedger(paths) {
  return readEvents(paths.ledger_file);
}

/** New opaque id with a prefix, e.g. `run_ab12cd34ef56`. */
export function newId(prefix) {
  return `${prefix}_${randomBytes(6).toString('hex')}`;
}

/** Reject ids that could escape a directory. */
export function assertSafeId(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new OuroborosError(`${label} 非法：只允许字母、数字、下划线和连字符`, 'BAD_INPUT');
  }
  return value;
}

/** Seed lock document (`seed.lock.json`) or undefined. */
export function readSeedLock(paths) {
  return readJson(paths.lock_file);
}

/** Load one Seed body by id. */
export function loadSeed(paths, seedId) {
  return readJson(join(paths.seeds_dir, `${assertSafeId(seedId, 'seed_id')}.json`));
}

/** Write the lock document atomically. */
export function writeSeedLock(paths, lock) {
  writeJsonAtomic(paths.lock_file, lock);
}

/** Interview session state path. */
export function interviewPath(paths, sessionId) {
  return join(paths.interviews_dir, `${assertSafeId(sessionId, 'session_id')}.json`);
}

/** Load interview state. */
export function loadInterview(paths, sessionId) {
  return readJson(interviewPath(paths, sessionId));
}

/** Persist interview state atomically. */
export function saveInterview(paths, sessionId, state) {
  writeJsonAtomic(interviewPath(paths, sessionId), state);
}

/** Deterministic clock helper (tools may inject `at`). */
export function nowIso() {
  return new Date().toISOString();
}

/** Locale strings, loaded once. Falls back to an empty map. */
let localeCache;
export function localeStrings() {
  if (localeCache !== undefined) return localeCache;
  try {
    localeCache = JSON.parse(readFileSync(join(MODULE_DIR, '..', 'locale', 'zh.json'), 'utf8'));
  } catch {
    localeCache = {};
  }
  return localeCache;
}

/** The exact footer line every reply ends with. */
export function footer(status, nextAction) {
  const template = localeStrings().footer ?? '◆ {status} → next: {next}';
  return template.replace('{status}', status).replace('{next}', nextAction);
}

/** Require the calling agent; tools cannot run without one. */
export function requireAgent(exec) {
  const agent = exec?.agent;
  if (agent === undefined) {
    throw new OuroborosError('ooo 工具需要在一个正在运行的 agent 会话中调用', 'NO_AGENT');
  }
  return agent;
}

/** Require the main (root) session for human interaction. */
export function requireMainSession(ctx, agent) {
  const agents = ctx?.get?.('agents') ?? ctx?.agents;
  if (agents !== undefined && typeof agents.roots === 'function') {
    if (!agents.roots().includes(agent)) {
      throw new OuroborosError(
        '访谈/批准必须在主会话运行：子代理不能开人对人交互（design §11）。',
        'NOT_MAIN_SESSION',
      );
    }
  }
}

/** Resolve the LLM service or throw a readable error. */
export function requireLlm(ctx) {
  const llm = ctx?.get?.('llm') ?? ctx?.llm;
  if (llm === undefined || typeof llm.stream !== 'function') {
    throw new OuroborosError('本会话没有可用的 ctx.llm，无法生成问题或评审', 'NO_LLM');
  }
  return llm;
}

/** Resolve the calling agent's provider/model route. */
export function agentRoute(agent) {
  const provider = agent?.options?.provider;
  const model = agent?.options?.model;
  if (typeof provider !== 'string' || typeof model !== 'string') {
    throw new OuroborosError(
      '无法确定当前会话的 provider/model；ooo 不维护自己的 LLM 凭据（design §1 非目标）',
      'NO_ROUTE',
    );
  }
  return { provider, model };
}

/** One-shot text completion through the session's own model. */
export async function callLlm(ctx, agent, options = {}) {
  const llm = requireLlm(ctx);
  const route = agentRoute(agent);
  const messages = [
    { role: 'user', content: [{ type: 'text', text: String(options.prompt ?? '') }] },
  ];
  let text = '';
  const stream = llm.stream({
    provider: route.provider,
    model: route.model,
    messages,
    ...(options.system === undefined ? {} : { system: options.system }),
    ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
    ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(agent?.id === undefined ? {} : { sessionId: agent.id }),
  });
  for await (const chunk of stream) {
    if (chunk?.type === 'text-delta') text += chunk.text;
  }
  return text;
}

/**
 * Extract the first balanced JSON object from free-form model text.
 * @returns {object|null}
 */
export function extractJsonObject(text) {
  const source = String(text ?? '');
  const start = source.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(source.slice(start, index + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/**
 * Ask the model for a JSON object, retrying twice (three attempts total).
 * Returns `{ ok:false }` instead of guessing — callers map that to
 * `unverified` / a readable error (design §11).
 */
export async function callLlmJson(ctx, agent, options = {}) {
  const attempts = options.attempts ?? 3;
  let lastText = '';
  let lastError = 'no attempts';
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      lastText = await callLlm(ctx, agent, options);
    } catch (error) {
      lastError = error?.message ?? String(error);
      if (error?.code === 'NO_ROUTE' || error?.code === 'NO_LLM') throw error;
      continue;
    }
    const parsed = extractJsonObject(lastText);
    if (parsed !== null) return { ok: true, value: parsed, text: lastText, attempts: attempt + 1 };
    lastError = '模型输出不是可解析的 JSON 对象';
  }
  return { ok: false, value: null, text: lastText, error: lastError, attempts };
}

/** Ask the human through `ctx.userQuestions` (main session only). */
export async function askUser(ctx, agent, questions, signal) {
  const service = ctx?.get?.('userQuestions') ?? ctx?.userQuestions;
  if (service === undefined || typeof service.ask !== 'function') {
    throw new OuroborosError('本会话没有 ctx.userQuestions，无法进行人对人问答', 'NO_QUESTION_SERVICE');
  }
  const answer = await service.ask({ questions, agent, ...(signal === undefined ? {} : { signal }) });
  return answer;
}

/** Flatten one answer batch into `{questionId: {selected, custom}}`. */
export function answerMap(answer) {
  const map = {};
  for (const item of answer?.answers ?? []) {
    map[item.id] = { selected: item.selected ?? [], custom: item.custom ?? '' };
  }
  return map;
}

/**
 * Resolve the per-call sandbox policy for this agent's session.
 * @returns {{ mode: string, workspaceRoot: string, sessionId?: string }}
 */
export function resolveSandboxPolicy(ctx, agent, root) {
  const service = ctx?.get?.('sandboxPolicy') ?? ctx?.sandboxPolicy;
  if (service !== undefined && typeof service.resolve === 'function') {
    const resolved = service.resolve({ session: agent?.session });
    return {
      mode: resolved.mode,
      workspaceRoot: resolved.workspaceRoot ?? root,
      ...(agent?.id === undefined ? {} : { sessionId: agent.id }),
    };
  }
  // No policy service: the fail-safe mode is workspace-write with the project
  // root as the boundary. The provider still fails closed if it cannot enforce.
  return { mode: 'workspace-write', workspaceRoot: root };
}

/**
 * Refuse to write state from a `read-only` session with a readable error.
 * The plugin's own writes run in-process, so the mode check is explicit here
 * rather than relying on the process sandbox (design §2.4 table).
 */
export function requireWritableSession(ctx, agent, root) {
  const policy = resolveSandboxPolicy(ctx, agent, root);
  if (policy.mode === 'read-only') {
    throw new OuroborosError(
      '当前会话是 read-only：ooo 无法写 .ouroboros/（账本、Seed、run）。把会话权限切到 workspace-write 后重试。',
      'READ_ONLY_SESSION',
    );
  }
  return policy;
}

/**
 * Spawn a Stage-1 command (or any confined argv) and collect its output.
 *
 * Fail-closed: when the resolved mode is confining, `ctx.sandbox.confine` must
 * succeed; a missing provider or a rejection is an error, never a bare spawn.
 *
 * @param {object} ctx
 * @param {object} input
 * @param {string[]} input.argv
 * @param {string} input.cwd
 * @param {object} input.policy `{mode, workspaceRoot, sessionId?}`
 * @param {number} input.timeoutMs
 * @param {AbortSignal} [input.signal]
 * @returns {Promise<{
 *   exitCode: number|null, timedOut: boolean, stdout: string, stderr: string,
 *   sandbox: { mode: string, enforcement: 'full'|'partial'|'none' }
 * }>}
 */
export async function runConfined(ctx, input) {
  const subprocess = ctx?.get?.('subprocess') ?? ctx?.subprocess;
  if (subprocess === undefined || typeof subprocess.spawn !== 'function') {
    throw new OuroborosError('本会话没有 ctx.subprocess，Stage1 无法执行', 'NO_SUBPROCESS');
  }

  let argv = [...input.argv];
  let sandbox;
  if (input.policy.mode === 'danger-full-access') {
    // The provider is not consulted in this mode; record the fact honestly.
    sandbox = { mode: 'danger-full-access', enforcement: 'none' };
  } else {
    const provider = ctx?.get?.('sandbox') ?? ctx?.sandbox;
    if (provider === undefined || typeof provider.confine !== 'function') {
      throw new OuroborosError(
        'ctx.sandbox 不可用：拒绝在未受限的情况下执行 Stage1（fail closed）',
        'SANDBOX_UNAVAILABLE',
      );
    }
    let confined;
    try {
      confined = await provider.confine(
        argv,
        {
          mode: input.policy.mode,
          workspaceRoot: input.policy.workspaceRoot,
          ...(input.policy.sessionId === undefined ? {} : { sessionId: input.policy.sessionId }),
        },
        input.signal,
      );
    } catch (error) {
      throw new OuroborosError(
        `沙箱 confine() 失败，拒绝降级为裸 spawn（fail closed）：${error?.message ?? error}`,
        'SANDBOX_UNAVAILABLE',
      );
    }
    if (confined === null || !Array.isArray(confined.argv) || confined.argv.length === 0) {
      throw new OuroborosError('沙箱 provider 未返回受限 argv（fail closed）', 'SANDBOX_UNAVAILABLE');
    }
    argv = confined.argv;
    sandbox = { mode: input.policy.mode, enforcement: confined.enforcement ?? 'partial' };
  }

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (input.signal !== undefined) {
    if (input.signal.aborted) controller.abort();
    else input.signal.addEventListener('abort', onAbort, { once: true });
  }

  let handle;
  try {
    handle = subprocess.spawn({
      argv,
      cwd: input.cwd,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: 200_000 },
        stderr: { maxBytes: 200_000 },
      },
      graceMs: 5_000,
      signal: controller.signal,
    });
  } finally {
    if (input.signal !== undefined) input.signal.removeEventListener('abort', onAbort);
  }

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    handle.terminate();
  }, input.timeoutMs);

  let outcome;
  try {
    outcome = await handle.done;
  } finally {
    clearTimeout(timer);
    try {
      await handle.waitForExit();
    } catch {
      // provider cannot observe the range any more; the outcome above stands
    }
  }

  return {
    exitCode: outcome.exitCode,
    timedOut,
    stdout: handle.collected.stdout?.readFrom(0).text ?? '',
    stderr: handle.collected.stderr?.readFrom(0).text ?? '',
    sandbox,
  };
}

/**
 * Worker prompt for one AC. Deliberately excludes `verify_command` and
 * `output_assertion`: the executor must not see how it will be judged
 * (design §5, acceptance §10 P2.1).
 */
export function buildWorkerPrompt(seed, ac, index) {
  const lines = [
    `你是 ooo_run 的执行子代理。只做第 ${index + 1} 条验收条件对应的实现。`,
    '',
    `## 目标`,
    seed.goal,
    '',
    `## 硬约束`,
    ...(seed.constraints.length === 0 ? ['- 无'] : seed.constraints.map((entry) => `- ${entry}`)),
    '',
    `## 本条验收条件`,
    ac.description,
    '',
    `## 必须产出的文件（workspace 相对路径）`,
    ...(ac.expected_artifacts.length === 0
      ? ['- 无显式产物；按验收条件实现即可']
      : ac.expected_artifacts.map((entry) => `- ${entry}`)),
    '',
    '只允许修改当前项目内的文件。完成后用一小段话总结你改了什么、改了哪些文件。',
  ];
  return lines.join('\n');
}

/** Count ledger events of one type. */
export function countLedgerByType(events, type) {
  return events.filter((event) => event.type === type).length;
}

/**
 * Build a registry-ready tool definition without importing `dsh-tools`.
 * Successful values are canonical JSON objects; the model sees pretty JSON.
 *
 * @param {object} spec
 * @param {string} spec.name
 * @param {string} spec.description
 * @param {object} spec.parameters raw JSON Schema (supported subset)
 * @param {(args: object, exec: object) => Promise<object>} spec.execute
 * @returns {object} ToolDefinition
 */
export function defineOooTool(spec) {
  return {
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    output: {
      schema: { type: 'object', additionalProperties: true },
      render(_args, value) {
        return [{ type: 'text', text: JSON.stringify(value, null, 2) }];
      },
    },
    async execute(args, exec) {
      const value = await spec.execute(args ?? {}, exec);
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new OuroborosError(`${spec.name} 必须返回一个 JSON 对象`, 'BAD_RESULT');
      }
      return value;
    },
  };
}
