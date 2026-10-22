/**
 * `ooo_run` — dispatch one execution subagent per acceptance criterion,
 * collect artifacts, and record them under `runs/<run_id>/artifacts/`.
 *
 * Worker prompts never contain `verify_command` or `output_assertion`
 * (design §5; acceptance §10 P2.1). Execution subagents inherit the session's
 * sandbox policy (design §2.4).
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { hashSeed, validateSeed } from '../core/seed.js';
import {
  OuroborosError,
  acquireWriterLock,
  appendLedger,
  assertSafeId,
  buildWorkerPrompt,
  defineOooTool,
  ensureStateDirs,
  loadSeed,
  newId,
  nowIso,
  projectPaths,
  projectRoot,
  readJson,
  requireAgent,
  requireWritableSession,
  writeJsonAtomic,
} from './shared.js';

const DEFAULT_PARALLEL = 4;
const MAX_PARALLEL = 8;
const CHILD_TIMEOUT_MS = 30 * 60 * 1000;

function startActivation(ctx, agent, root, prompt, label, signal) {
  const subagents = ctx?.get?.('subagents') ?? ctx?.subagents;
  if (subagents === undefined || typeof subagents.startActivation !== 'function') {
    throw new OuroborosError('本会话没有 ctx.subagents，无法派执行子代理', 'NO_SUBAGENTS');
  }
  return subagents.startActivation({
    provider: 'spawn',
    label,
    request: {
      prompt: [{ type: 'text', text: prompt }],
      parent: agent,
      cwd: root,
    },
    signal,
    delivery: 'caller',
  });
}

function finishResult(activation) {
  return activation.result.then(
    (result) => ({ activation, result }),
    (error) => ({ activation, result: { stopReason: 'error', output: [], diagnostic: String(error?.message ?? error) } }),
  );
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

function outputText(result) {
  const blocks = Array.isArray(result?.output) ? result.output : [];
  const text = blocks
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
  return text.trim();
}

function priorRunWithChildren(paths, seedId) {
  const index = readJson(join(paths.runs_dir, 'index.json'));
  const entries = Array.isArray(index?.runs) ? index.runs : [];
  for (let position = entries.length - 1; position >= 0; position -= 1) {
    const entry = entries[position];
    if (entry?.seed_id !== seedId) continue;
    const record = readJson(join(paths.runs_dir, entry.run_id, 'run.json'));
    if (record !== undefined) return record;
  }
  return undefined;
}

function rememberRun(paths, record) {
  const indexPath = join(paths.runs_dir, 'index.json');
  const index = readJson(indexPath) ?? { runs: [] };
  index.runs = Array.isArray(index.runs) ? index.runs : [];
  index.runs.push({
    run_id: record.run_id,
    seed_id: record.seed_id,
    at: record.started_at,
  });
  writeJsonAtomic(indexPath, index);
}

/**
 * Resolve a cold-resumed continuation child. `ctx.agents.get()` may be empty
 * for a few ticks while the continuation manager materializes the child, so
 * poll briefly rather than interpreting "not in the registry yet" as failure.
 */
async function resolveChildForContinuation(ctx, childId, attempts = 100) {
  const agents = ctx?.get?.('agents') ?? ctx?.agents;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const child = agents?.get?.(childId);
    if (child !== undefined) return child;
    if (attempt < attempts - 1) await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return undefined;
}

/** Wait for one continuation turn to settle. */
async function waitForChildTurn(child, signal) {
  if (child === undefined || typeof child.whenIdle !== 'function') return 'unobservable';
  if (signal?.aborted === true) return 'aborted';
  let timer;
  let onAbort;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve('timeout'), CHILD_TIMEOUT_MS);
  });
  const aborted = new Promise((resolve) => {
    if (signal === undefined) return;
    onAbort = () => resolve('aborted');
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    const idle = Promise.resolve()
      .then(() => child.whenIdle())
      .then(() => 'idle');
    return await Promise.race([idle, timeout, aborted]);
  } finally {
    clearTimeout(timer);
    if (signal !== undefined && onAbort !== undefined) signal.removeEventListener('abort', onAbort);
  }
}

function latestAssistantText(agent, fromIndex = 0) {
  const events = agent?.session?.snapshotEvents?.() ?? [];
  for (let index = events.length - 1; index >= fromIndex; index -= 1) {
    const event = events[index];
    if (event?.type !== 'assistant/message') continue;
    const content = event.data?.message?.content;
    if (!Array.isArray(content)) continue;
    const text = content
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n')
      .trim();
    if (text !== '') return text;
  }
  return '';
}

export function createRunTool(ctx) {
  return defineOooTool({
    name: 'ooo_run',
    description:
      '按 Seed 的每条验收条件派一个执行子代理，把产物写进 runs/<id>/artifacts/。' +
      'Seed 未锁定或被批准前拒绝执行。worker prompt 不含 verify_command / output_assertion。',
    parameters: {
      type: 'object',
      properties: {
        seed_id: { type: 'string', description: '已锁定的 Seed id' },
        max_parallel: { type: 'integer', description: '并发子代理数，默认 4，最大 8' },
        continuing: {
          type: 'boolean',
          description: '续跑：对上一轮已有子代理的 AC 用 sendMessage 继续同一个子代理',
        },
      },
      required: ['seed_id'],
      additionalProperties: false,
    },
    async execute(args, exec) {
      const agent = requireAgent(exec);
      const root = projectRoot(agent);
      const paths = projectPaths(root);
      requireWritableSession(ctx, agent, root);
      ensureStateDirs(paths);

      const seedId = assertSafeId(args.seed_id, 'seed_id');
      const lock = readJson(paths.lock_file);
      if (lock === undefined) {
        throw new OuroborosError(
          '没有已锁定的 Seed（缺 .ouroboros/seed.lock.json）：ooo_run 拒绝在未锁定 Seed 上执行。' +
            '先跑 ooo_seed；它会返回九道门的状态：' +
            'answered_rounds / ambiguity_threshold / clarity_floors / ready_streak / ' +
            'requirement_distillation / ac_success_contract / restate_approved / ' +
            'client_acceptance_gate / explicit_force。',
          'SEED_NOT_LOCKED',
        );
      }
      if (lock.seed_id !== seedId) {
        throw new OuroborosError(
          `锁定的 Seed 是 ${lock.seed_id}，不是 ${seedId}；拒绝执行（缺：seed_id 匹配）。`,
          'SEED_MISMATCH',
        );
      }
      const seed = loadSeed(paths, seedId);
      if (seed === undefined) {
        throw new OuroborosError(`找不到 Seed 正文 ${seedId}.json；不猜，也不执行。`, 'SEED_MISSING');
      }
      if (typeof lock.hash === 'string' && lock.hash !== hashSeed(seed)) {
        throw new OuroborosError(
          `Seed 正文与锁文件哈希不一致（${seedId}）：Seed 冻结后不可变，拒绝执行。`,
          'SEED_TAMPERED',
        );
      }
      const validation = validateSeed(seed);
      if (!validation.ok) {
        throw new OuroborosError(
          `Seed 校验未通过，拒绝执行：\n- ${validation.errors.join('\n- ')}`,
          'SEED_INVALID',
        );
      }

      const maxParallel = Math.max(
        1,
        Math.min(MAX_PARALLEL, Number.isInteger(args.max_parallel) ? args.max_parallel : DEFAULT_PARALLEL),
      );
      const release = acquireWriterLock(paths, 'run');
      try {
        const runId = newId('run');
        const runDir = join(paths.runs_dir, runId);
        const artifactsDir = join(runDir, 'artifacts');
        mkdirSync(artifactsDir, { recursive: true });
        writeJsonAtomic(join(runDir, 'seed_snapshot.json'), seed);
        appendLedger(paths, 'run.started', { run_id: runId, seed_id: seedId, max_parallel: maxParallel });

        const previous = args.continuing === true ? priorRunWithChildren(paths, seedId) : undefined;
        const previousByIndex = new Map(
          (previous?.children ?? []).map((child) => [child.ac_index, child]),
        );
        if (args.continuing === true) {
          if (previous === undefined) {
            throw new OuroborosError(
              `没有可续跑的上一轮 run（seed ${seedId}）：continuing:true 只在已有 run 时有效。` +
                '本轮没有新建任何子代理；请用 continuing:false 重新派发整轮。',
              'NO_PREVIOUS_RUN',
            );
          }
          const missing = seed.acceptance_criteria
            .map((_, index) => index)
            .filter((index) => previousByIndex.get(index)?.child_id === undefined);
          if (missing.length > 0) {
            throw new OuroborosError(
              `continuing:true 需要上一轮每个 AC 都有 child_id；缺少 AC ${missing
                .map((index) => index + 1)
                .join(', ')}。本轮没有静默新建；请用 continuing:false 重新派发。`,
              'NO_PREVIOUS_CHILD',
            );
          }
        }

        const children = [];
        const settled = await mapLimit(
          seed.acceptance_criteria,
          maxParallel,
          async (ac, index) => {
            if (exec.signal?.aborted) throw new OuroborosError('已取消', 'CANCELLED');
            const label = `ooo AC ${index + 1}`;
            const prompt = buildWorkerPrompt(seed, ac, index);

            if (args.continuing === true) {
              const prior = previousByIndex.get(index);
              const subagents = ctx?.get?.('subagents') ?? ctx?.subagents;
              if (subagents === undefined || typeof subagents.sendMessage !== 'function') {
                throw new OuroborosError(
                  '本会话没有 ctx.subagents.sendMessage，无法续跑；本轮没有新建子代理。',
                  'NO_SUBAGENTS',
                );
              }
              const existingChild = ctx?.get?.('agents')?.get?.(prior.child_id);
              const beforeCount = existingChild?.session?.snapshotEvents?.().length;
              let messageId;
              try {
                // Do not require the child to be live: sendMessage cold-resumes
                // a missing direct child (design §12; SubagentRuntime docs).
                messageId = await subagents.sendMessage(
                  agent,
                  prior.child_id,
                  [{ type: 'text', text: prompt }],
                  { signal: exec.signal },
                );
              } catch (error) {
                throw new OuroborosError(
                  `续跑失败（AC ${index + 1}, child ${prior.child_id}）：${error?.message ?? error}。` +
                    '本轮不会静默新建子代理；请用 continuing:false 重新派发整轮。',
                  'CONTINUATION_FAILED',
                );
              }
              const child = await resolveChildForContinuation(ctx, prior.child_id);
              if (child === undefined) {
                throw new OuroborosError(
                  `续跑消息已送达但无法观察到子代理 child ${prior.child_id}（AC ${index + 1}）；` +
                    '本轮没有产物，也未自动新建。请用 continuing:false 重新派发。',
                  'CONTINUATION_UNOBSERVABLE',
                );
              }
              // Read only assistant messages emitted after this continuation
              // message was admitted; otherwise a stale prior-turn summary
              // could be reported as this run's output.
              const outputOffset =
                beforeCount ?? (child?.session?.snapshotEvents?.().length ?? 0);
              const settledState = await waitForChildTurn(child, exec.signal);
              if (settledState === 'aborted') {
                throw new OuroborosError('已取消：续跑被中止', 'CANCELLED');
              }
              if (settledState === 'timeout') {
                throw new OuroborosError(
                  `续跑等待超时（AC ${index + 1}, child ${prior.child_id}）；本轮没有产物。`,
                  'CONTINUATION_TIMEOUT',
                );
              }
              if (settledState !== 'idle') {
                throw new OuroborosError(
                  `无法等待续跑子代理 child ${prior.child_id}（AC ${index + 1}）；本轮没有产物。`,
                  'CONTINUATION_UNOBSERVABLE',
                );
              }
              return {
                ac_index: index,
                semantic_ac_key: ac.semantic_ac_key,
                child_id: prior.child_id,
                message_id: messageId,
                continued: true,
                stop_reason: 'completed',
                output: latestAssistantText(child, outputOffset),
              };
            }

            let activation;
            try {
              activation = await startActivation(ctx, agent, root, prompt, label, exec.signal);
              const { result } = await finishResult(activation);
              return {
                ac_index: index,
                semantic_ac_key: ac.semantic_ac_key,
                child_id: activation.childId,
                message_id: activation.messageId ?? null,
                continued: false,
                stop_reason: result?.stopReason ?? 'error',
                output: outputText(result),
                ...(result?.diagnostic === undefined ? {} : { diagnostic: result.diagnostic }),
              };
            } finally {
              if (activation !== undefined) {
                try {
                  await activation.dispose();
                } catch {
                  // teardown failure must not replace the captured result
                }
              }
            }
          },
        );
        children.push(...settled);

        const artifacts = [];
        for (const child of settled) {
          const path = join(artifactsDir, `${child.semantic_ac_key ?? `ac_${child.ac_index}`}.json`);
          writeJsonAtomic(path, {
            ac_index: child.ac_index,
            semantic_ac_key: child.semantic_ac_key,
            child_id: child.child_id,
            stop_reason: child.stop_reason,
            output: child.output,
            at: nowIso(),
          });
          artifacts.push(path);
        }

        writeJsonAtomic(join(runDir, 'run.json'), {
          run_id: runId,
          seed_id: seedId,
          started_at: nowIso(),
          finished_at: nowIso(),
          max_parallel: maxParallel,
          acs: seed.acceptance_criteria.map((ac, index) => ({
            ac_index: index,
            semantic_ac_key: ac.semantic_ac_key,
            description: ac.description,
            expected_artifacts: ac.expected_artifacts,
          })),
          children,
        });
        rememberRun(paths, { run_id: runId, seed_id: seedId, started_at: nowIso() });
        appendLedger(paths, 'run.completed', { run_id: runId, seed_id: seedId, acs: children.length });

        return {
          run_id: runId,
          path: runDir,
          acs: seed.acceptance_criteria.map((ac, index) => ({
            ac_index: index,
            semantic_ac_key: ac.semantic_ac_key,
            description: ac.description,
          })),
          artifacts,
          children,
          next_action: 'ooo_evaluate',
        };
      } finally {
        release();
      }
    },
  });
}
