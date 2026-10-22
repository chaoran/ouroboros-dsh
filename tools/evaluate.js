/**
 * `ooo_evaluate` — three-stage evaluation with a deterministic verdict.
 *
 * Stage 1 runs `.ouroboros/mechanical.toml` commands with no shell, inside the
 * session's sandbox policy (fail closed). Stage 2 and Stage 3 are pure
 * `ctx.llm` calls: no tools, no processes, no files.
 *
 * Stage 1 is the only stage that can grant approval; Stage 2/3 may only
 * withhold (design §7).
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { decide } from '../core/gate.js';
import { triggerFromStage2 } from '../core/trigger.js';
import { stage3Result } from '../core/consensus.js';
import { summarizeStage1, buildCheck, planStage1 } from '../core/stage1.js';
import { hashSeed, validateSeed } from '../core/seed.js';
import {
  OuroborosError,
  acquireWriterLock,
  appendLedger,
  assertSafeId,
  callLlmJson,
  defineOooTool,
  ensureStateDirs,
  loadSeed,
  projectPaths,
  projectRoot,
  readJson,
  readText,
  requireAgent,
  requireWritableSession,
  resolveSandboxPolicy,
  runConfined,
  writeJsonAtomic,
} from './shared.js';

const STAGE2_SYSTEM =
  '你是 Ouroboros 的 Stage2 语义评审。只看「声明的成功契约 + 执行证据」，不要执行命令、不要写文件。' +
  '只输出一个 JSON 对象，不要 Markdown。数值决定是否扣留；P0/P1/P2 条目决定给人看什么。';

const STAGE3_SYSTEM =
  '你是 Ouroboros Stage3 的独立评审之一。只根据给定的 Seed 与执行证据投票。' +
  '只输出一个 JSON 对象，不要 Markdown。';

function latestRun(paths, seedId) {
  const index = readJson(join(paths.runs_dir, 'index.json'));
  const entries = Array.isArray(index?.runs) ? index.runs : [];
  for (let position = entries.length - 1; position >= 0; position -= 1) {
    const entry = entries[position];
    if (entry?.seed_id === seedId) {
      const record = readJson(join(paths.runs_dir, entry.run_id, 'run.json'));
      if (record !== undefined) return record;
    }
  }
  return undefined;
}

function collectArtifacts(paths, run) {
  const dir = join(paths.runs_dir, run.run_id, 'artifacts');
  let names;
  try {
    names = readdirSync(dir).sort();
  } catch {
    return [];
  }
  return names.map((name) => {
    const json = readJson(join(dir, name));
    return {
      file: name,
      ac_index: json?.ac_index ?? null,
      stop_reason: json?.stop_reason ?? null,
      output: String(json?.output ?? '').slice(0, 4000),
    };
  });
}

function stage2Prompt(seed, stage1, artifacts) {
  const executed = stage1.checks
    .filter((check) => check.executed)
    .map((check) => `- ${check.check_type}: exit ${check.exit_code}; ${check.message}`)
    .join('\n');
  return [
    `目标：${seed.goal}`,
    `任务类型：${seed.task_type}`,
    `硬约束：${seed.constraints.join('；') || '无'}`,
    '',
    '## DECLARED SUCCESS CONTRACT（评审可见，执行侧不可见）',
    ...seed.acceptance_criteria.map(
      (ac, index) =>
        `${index + 1}. ${ac.description}\n   verify_command: ${ac.verify_command ?? 'null'}\n   expected_artifacts: ${ac.expected_artifacts.join(', ') || '无'}\n   output_assertion: ${ac.output_assertion ?? 'null'}`,
    ),
    '',
    '## EXECUTED EVIDENCE',
    executed === '' ? '（没有可执行的 Stage1 证据）' : executed,
    '',
    '## RUN ARTIFACTS',
    ...(artifacts.length === 0
      ? ['（没有 artifacts）']
      : artifacts.map(
          (artifact) =>
            `- ${artifact.file} (AC ${artifact.ac_index}, ${artifact.stop_reason}):\n  ${artifact.output.slice(0, 1500)}`,
        )),
    '',
    '## REVIEW OUTPUT CONTRACT',
    '只输出 JSON：',
    '{',
    '  "score": 0.0, "ac_compliance": true,',
    '  "goal_alignment": 0.0, "drift_score": 0.0, "uncertainty": 0.0,',
    '  "reward_hacking_risk": 0.0, "reasoning": "一句话",',
    '  "items": [{"level":"P0|P1|P2","title":"…","detail":"…"}],',
    '  "flags": {"manual": false, "seed_modified": false, "ontology_evolved": false,',
    '            "goal_reinterpreted": false, "lateral_adopted": false}',
    '}',
    '所有数值在 0..1。没有条目就给空数组。',
  ].join('\n');
}

function normalizeStage2(value) {
  if (value === null || typeof value !== 'object') return null;
  const number = (input, fallback) =>
    typeof input === 'number' && Number.isFinite(input) ? Math.max(0, Math.min(1, input)) : fallback;
  return {
    score: number(value.score, 0),
    ac_compliance: value.ac_compliance === true,
    goal_alignment: number(value.goal_alignment, 0),
    drift_score: number(value.drift_score, 0),
    uncertainty: number(value.uncertainty, 0),
    reward_hacking_risk: number(value.reward_hacking_risk, 1),
    reasoning: typeof value.reasoning === 'string' ? value.reasoning : '',
    items: Array.isArray(value.items)
      ? value.items
          .filter((item) => item !== null && typeof item === 'object')
          .map((item) => ({
            level: ['P0', 'P1', 'P2'].includes(item.level) ? item.level : 'P2',
            title: typeof item.title === 'string' ? item.title : '',
            detail: typeof item.detail === 'string' ? item.detail : '',
          }))
      : [],
    flags: value.flags !== null && typeof value.flags === 'object' ? value.flags : {},
  };
}

async function vote(ctx, agent, seed, stage1, reviewerId, signal) {
  const result = await callLlmJson(ctx, agent, {
    temperature: 0.7,
    maxTokens: 1200,
    signal,
    system: STAGE3_SYSTEM,
    prompt: [
      `评审者 id：${reviewerId}`,
      `目标：${seed.goal}`,
      '验收条件：',
      ...seed.acceptance_criteria.map((ac, index) => `${index + 1}. ${ac.description}`),
      '',
      '机械证据：',
      ...stage1.checks
        .filter((check) => check.executed)
        .map((check) => `- ${check.check_type}: exit ${check.exit_code}; ${check.message}`),
      '',
      '你独立判断这份交付是否满足全部验收条件。输出 JSON：',
      '{"approved": true 或 false, "reasoning": "一句话"}',
    ].join('\n'),
  });
  if (!result.ok || typeof result.value?.approved !== 'boolean') {
    return { reviewer_id: reviewerId, valid: false, approved: false, reasoning: '无法解析投票' };
  }
  return {
    reviewer_id: reviewerId,
    valid: true,
    approved: result.value.approved,
    reasoning: typeof result.value.reasoning === 'string' ? result.value.reasoning : '',
  };
}

export function createEvaluateTool(ctx) {
  return defineOooTool({
    name: 'ooo_evaluate',
    description:
      '三阶段评测：Stage1 机械命令（沙箱内、无 shell）→ Stage2 语义评审（纯 LLM）→ 触发矩阵 → Stage3 三票共识 → 确定性裁决。' +
      '只有 Stage1 执行证据能授予 approved；缺证据一律 unverified。',
    parameters: {
      type: 'object',
      properties: {
        seed_id: { type: 'string', description: '已锁定的 Seed id' },
        run_id: { type: 'string', description: '要评测的 run id；省略时用该 Seed 最近一次 run' },
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
      if (lock === undefined || lock.seed_id !== seedId) {
        throw new OuroborosError(
          `Seed ${seedId} 没有锁定（或锁定的不是它）；先跑 ooo_seed。`,
          'SEED_NOT_LOCKED',
        );
      }
      const seed = loadSeed(paths, seedId);
      if (seed === undefined) {
        throw new OuroborosError(`找不到 Seed 正文 ${seedId}.json`, 'SEED_MISSING');
      }
      if (typeof lock.hash === 'string' && lock.hash !== hashSeed(seed)) {
        throw new OuroborosError(
          `Seed 正文与锁文件哈希不一致（${seedId}）：Seed 冻结后不可变，拒绝评测。`,
          'SEED_TAMPERED',
        );
      }
      const validation = validateSeed(seed);
      if (!validation.ok) {
        throw new OuroborosError(`Seed 校验未通过：\n- ${validation.errors.join('\n- ')}`, 'SEED_INVALID');
      }

      const runRecord =
        args.run_id === undefined
          ? latestRun(paths, seedId)
          : readJson(join(paths.runs_dir, assertSafeId(args.run_id, 'run_id'), 'run.json'));
      if (runRecord === undefined) {
        throw new OuroborosError('没有可评测的 run：先跑 ooo_run 产出 artifacts', 'NO_RUN');
      }
      if (runRecord.seed_id !== seedId) {
        throw new OuroborosError(
          `run ${runRecord.run_id} 属于 Seed ${runRecord.seed_id}，不是 ${seedId}；拒绝跨 Seed 评测。`,
          'RUN_SEED_MISMATCH',
        );
      }
      const runId = runRecord.run_id;
      const runDir = join(paths.runs_dir, runId);
      const runSeed = readJson(join(runDir, 'seed_snapshot.json')) ?? seed;

      const release = acquireWriterLock(paths, 'evaluate');
      try {
        // ---- Stage 1: mechanical checks through the sandbox policy ----
        const mechanical = readText(paths.mechanical_file) ?? '';
        const plan = planStage1(mechanical);
        if (plan.errors.length > 0) {
          throw new OuroborosError(
            `mechanical.toml 解析错误，拒绝评测（fail closed）：\n- ${plan.errors.join('\n- ')}`,
            'MECHANICAL_INVALID',
          );
        }
        const policy = resolveSandboxPolicy(ctx, agent, root);
        const checks = [];
        let sandbox = {
          mode: policy.mode,
          enforcement: policy.mode === 'danger-full-access' ? 'none' : null,
        };

        for (const entry of plan.checks) {
          if (!entry.configured) {
            checks.push(buildCheck(entry, {}));
            continue;
          }
          const result = await runConfined(ctx, {
            argv: entry.argv,
            cwd: root,
            policy,
            timeoutMs: plan.timeout_ms,
            signal: exec.signal,
          });
          sandbox = result.sandbox;
          checks.push(
            buildCheck(entry, {
              exitCode: result.exitCode,
              timedOut: result.timedOut,
              stdout: result.stdout,
              stderr: result.stderr,
              timeoutMs: plan.timeout_ms,
            }),
          );
        }

        const stage1 = { ...summarizeStage1(checks), sandbox };
        writeJsonAtomic(join(runDir, 'stage1.json'), stage1);
        appendLedger(paths, 'evaluate.stage1', {
          run_id: runId,
          seed_id: seedId,
          has_executed_evidence: stage1.has_executed_evidence,
          sandbox,
          checks: checks.map((check) => ({
            check_type: check.check_type,
            executed: check.executed,
            passed: check.passed,
            exit_code: check.exit_code,
          })),
        });

        // ---- Stage 2: pure LLM review, sees the declared contract + evidence ----
        const artifacts = collectArtifacts(paths, runRecord);
        const review = await callLlmJson(ctx, agent, {
          temperature: 0.2,
          maxTokens: 3000,
          signal: exec.signal,
          system: STAGE2_SYSTEM,
          prompt: stage2Prompt(runSeed, stage1, artifacts),
        });
        const stage2 = review.ok ? normalizeStage2(review.value) : null;
        const stage2Error = review.ok ? null : review.error;
        writeJsonAtomic(
          join(runDir, 'stage2.json'),
          stage2 === null ? { error: stage2Error } : stage2,
        );
        appendLedger(paths, 'evaluate.stage2', {
          run_id: runId,
          seed_id: seedId,
          parsed: stage2 !== null,
          score: stage2?.score ?? null,
          ac_compliance: stage2?.ac_compliance ?? null,
          reward_hacking_risk: stage2?.reward_hacking_risk ?? null,
          error: stage2Error,
        });

        // ---- Trigger matrix -> Stage 3: three independent pure LLM votes ----
        let stage3 = null;
        if (stage2 !== null) {
          const trigger = triggerFromStage2(stage2, stage2.flags ?? {});
          if (trigger.triggered) {
            const votes = await Promise.all(
              ['reviewer-1', 'reviewer-2', 'reviewer-3'].map((reviewerId) =>
                vote(ctx, agent, runSeed, stage1, reviewerId, exec.signal),
              ),
            );
            stage3 = { ...stage3Result(votes), triggered_by: trigger.trigger };
            writeJsonAtomic(join(runDir, 'stage3.json'), stage3);
            appendLedger(paths, 'evaluate.stage3', {
              run_id: runId,
              seed_id: seedId,
              trigger: trigger.trigger,
              approved: stage3.approved,
              majority_ratio: stage3.majority_ratio,
              reviewer_independence: stage3.reviewer_independence,
              error: stage3.error ?? null,
            });
          }
        }

        // ---- Deterministic verdict ----
        const gate = decide({ stage1, stage2, stage3 });
        const verdict = {
          acceptance_state: gate.acceptance_state,
          failure_reason: gate.failure_reason,
          stage1,
          stage2,
          stage3,
          sandbox,
          run_id: runId,
          seed_id: seedId,
          decided_at: new Date().toISOString(),
        };
        writeJsonAtomic(join(runDir, 'verdict.json'), verdict);
        appendLedger(paths, 'evaluate.verdict', {
          run_id: runId,
          seed_id: seedId,
          acceptance_state: gate.acceptance_state,
          failure_reason: gate.failure_reason,
        });

        return {
          run_id: runId,
          acceptance_state: verdict.acceptance_state,
          failure_reason: verdict.failure_reason,
          stage1,
          ...(stage2 === null ? { stage2_error: stage2Error } : { stage2 }),
          ...(stage3 === null ? {} : { stage3 }),
          sandbox,
          next_action: verdict.acceptance_state === 'approved' ? 'ooo_evolve' : 'ooo_run',
        };
      } finally {
        release();
      }
    },
  });
}
