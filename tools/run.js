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

async function waitForChildTurn(child, signal) {
  if (child === undefined || typeof child.whenIdle !== 'function') return false;
  let timer;
  let onAbort;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(false), CHILD_TIMEOUT_MS);
  });
  const aborted = new Promise((resolve) => {
    if (signal === undefined) return;
    onAbort = () => resolve(false);
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    const idle = child.whenIdle().then(() => true);
    return await Promise.race([idle, timeout, aborted]);
  } finally {
    clearTimeout(timer);
    if (signal !== undefined && onAbort !== undefined) signal.removeEventListener('abort', onAbort);
  }
}

function latestAssistantText(agent) {
  const events = agent?.session?.snapshotEvents?.() ?? [];
  for (let index = events.length - 1; index >= 0; index -= 1) {
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

      const children = [];
      try {
        const settled = await mapLimit(
          seed.acceptance_criteria,
          maxParallel,
          async (ac, index) => {
            if (exec.signal?.aborted) throw new OuroborosError('已取消', 'CANCELLED');
            const label = `ooo AC ${index + 1}`;
            const prompt = buildWorkerPrompt(seed, ac, index);
            const prior = previousByIndex.get(index);

            if (args.continuing === true && prior?.child_id !== undefined) {
              const subagents = ctx?.get?.('subagents') ?? ctx?.subagents;
              const child = ctx?.get?.('agents')?.get?.(prior.child_id);
              if (subagents !== undefined && child !== undefined) {
                const messageId = await subagents.sendMessage(
                  agent,
                  prior.child_id,
                  [{ type: 'text', text: prompt }],
                  { signal: exec.signal },
                );
                const finished = await waitForChildTurn(child, exec.signal);
                const text = finished ? latestAssistantText(child) : '';
                return {
                  ac_index: index,
                  semantic_ac_key: ac.semantic_ac_key,
                  child_id: prior.child_id,
                  message_id: messageId,
                  continued: true,
                  stop_reason: finished ? 'completed' : 'unfinished',
                  output: text,
                };
              }
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
