/**
 * `ooo_seed` — nine gates -> restate + explicit approval -> validation -> lock.
 *
 * Nothing is written unless every gate passes. `force` bypasses gates 1-4 and
 * is recorded truthfully (`gate_forced: true`, real ambiguity score kept).
 */
import {
  freezeSeed,
  hashSeed,
  makeSeedId,
  seedGates,
  semanticAcKey,
  serializeSeed,
  validateSeed,
} from '../core/seed.js';
import { evaluateInterview } from '../core/ambiguity.js';
import {
  OuroborosError,
  answerMap,
  appendLedger,
  askUser,
  callLlmJson,
  defineOooTool,
  ensureStateDirs,
  loadInterview,
  nowIso,
  projectPaths,
  projectRoot,
  requireAgent,
  requireWritableSession,
  requireMainSession,
  writeJsonAtomic,
  writeSeedLock,
} from './shared.js';
import { join } from 'node:path';

const APPROVE_LABEL = '批准并锁定';
const CLIENT_GATE_LABEL = '确认就绪';

function transcriptOf(state, limit = 12) {
  return state.answers
    .slice(-limit)
    .map((entry) => `- 第 ${entry.round} 轮\n  问：${entry.question}\n  答：${entry.answer}`)
    .join('\n');
}

function draftSeedPrompt(state) {
  return [
    `目标：${state.goal}`,
    `访谈模式：${state.mode}`,
    `歧义总分：${state.last_scored?.total ?? 'unknown'}`,
    '完整问答：',
    transcriptOf(state) || '（没有问答）',
    '',
    '把上面的访谈结晶成一个 Seed。只输出 JSON 对象，不要 Markdown，不要额外解释。',
    'schema（逐字段照做）：',
    '{',
    '  "goal": "非空字符串",',
    '  "task_type": "code|research|analysis|artifact|document|documentation|presentation",',
    '  "constraints": ["硬约束"],',
    '  "acceptance_criteria": [{"description":"可验证的一句话",',
    '    "verify_command":"一条无 shell 元字符的命令（如 node --test test/x.test.js）或 null",',
    '    "expected_artifacts":["workspace 相对路径"],',
    '    "output_assertion":"字符串或 null",',
    '    "verify_exemption_reason":"无法机械验证时的理由或 null"}],',
    '  "ontology_schema": {"name":"…","description":"…","fields":[{"name":"…","field_type":"…","description":"…","required":true}]},',
    '  "evaluation_principles": [{"name":"…","description":"…","weight":1.0}],',
    '  "exit_conditions": [{"name":"…","description":"…","evaluation_criteria":"…"}]',
    '}',
    '规则：output_assertion 非空时 verify_command 必须非空；expected_artifacts 只能是 workspace 相对路径；',
    '每条 AC 必须有 verify_command 或 verify_exemption_reason。',
  ].join('\n');
}

async function draftSeed(ctx, agent, state, signal) {
  const result = await callLlmJson(ctx, agent, {
    temperature: 0.2,
    maxTokens: 4000,
    signal,
    system:
      '你是 Ouroboros 的 Seed 起草器。只输出一个 JSON 对象。' +
      'Seed 是不可变规格：goal / AC / ontology / constraints / 评测原则 / 退出条件。',
    prompt: draftSeedPrompt(state),
  });
  if (!result.ok) {
    throw new OuroborosError(
      `Seed 起草失败：模型连续 3 次没有返回可解析的 JSON（${result.error}）。不猜，也不写盘。`,
      'SEED_DRAFT_FAILED',
    );
  }
  return result.value;
}

async function closureAudit(ctx, agent, state, seed, signal) {
  const result = await callLlmJson(ctx, agent, {
    temperature: 0.2,
    maxTokens: 1200,
    signal,
    system:
      '你是 Ouroboros 的 closure 审计器。只做只读判断：访谈里的需求是否已被 Seed 完整覆盖。' +
      '只输出一个 JSON 对象。',
    prompt: [
      `目标：${state.goal}`,
      '访谈问答：',
      transcriptOf(state) || '（没有问答）',
      '',
      '候选 Seed 的 AC：',
      ...seed.acceptance_criteria.map((ac, index) => `${index + 1}. ${ac.description}`),
      '',
      '判断是否有未解决的需求缺口。输出 JSON：',
      '{"closed": true 或 false, "gaps": ["缺口"], "notes": "一句话"}',
    ].join('\n'),
  });
  if (!result.ok || typeof result.value?.closed !== 'boolean') {
    return { passed: false, gaps: ['closure 审计未能完成（模型没有返回可解析结果）'], notes: null };
  }
  const gaps = Array.isArray(result.value.gaps)
    ? result.value.gaps.filter((gap) => typeof gap === 'string' && gap.trim() !== '')
    : [];
  return {
    passed: result.value.closed === true,
    gaps,
    notes: typeof result.value.notes === 'string' ? result.value.notes : null,
  };
}

function restateText(seed) {
  return [
    `目标：${seed.goal}`,
    `任务类型：${seed.task_type}`,
    `验收条件（${seed.acceptance_criteria.length} 条）：`,
    ...seed.acceptance_criteria.map(
      (ac, index) => `${index + 1}. ${ac.description}（产物：${ac.expected_artifacts.join(', ') || '无'}）`,
    ),
  ].join('\n');
}

export function createSeedTool(ctx) {
  return defineOooTool({
    name: 'ooo_seed',
    description:
      '把访谈结晶成 Seed：九道门 -> restate + 显式批准 -> 校验 -> 写 seeds/ 并锁定。' +
      '任何一道门不过就不写盘，返回缺口清单。',
    parameters: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: '访谈会话 id' },
        force: {
          type: 'boolean',
          description: '显式绕过歧义阈值/下限/连续就绪/轮数四道门；真实分数照录，gate_forced=true',
        },
      },
      required: ['session_id'],
      additionalProperties: false,
    },
    async execute(args, exec) {
      const agent = requireAgent(exec);
      requireMainSession(ctx, agent);
      const root = projectRoot(agent);
      const paths = projectPaths(root);
      requireWritableSession(ctx, agent, root);
      ensureStateDirs(paths);

      const sessionId = String(args.session_id).replace(/[^A-Za-z0-9_-]/g, '_');
      const state = loadInterview(paths, sessionId);
      if (state === undefined) {
        throw new OuroborosError(
          `访谈会话 ${sessionId} 不存在：先跑 ooo_interview 完成访谈，再生成 Seed`,
          'NO_INTERVIEW',
        );
      }
      const scored =
        state.last_scored ??
        evaluateInterview({
          mode: state.mode,
          clarity: state.clarity,
          answered_rounds: state.answered_rounds,
          streak: 0,
        });

      const drafted = await draftSeed(ctx, agent, state, exec.signal);
      const seedId = makeSeedId();
      const seed = freezeSeed({
        ...drafted,
        metadata: {
          seed_id: seedId,
          version: '1.0.0',
          created_at: nowIso(),
          ambiguity_score: scored.total,
          gate_forced: args.force === true,
          interview_id: state.interview_id,
          decision_provenance: {
            user_confirmed: state.answered_rounds,
            model_inferred: Array.isArray(drafted.acceptance_criteria)
              ? drafted.acceptance_criteria.length
              : 0,
            maintainer_policy: 0,
          },
        },
      });

      const validation = validateSeed(seed);
      if (!validation.ok) {
        throw new OuroborosError(
          `Seed 校验未通过，未写盘：\n- ${validation.errors.join('\n- ')}`,
          'SEED_INVALID',
        );
      }

      const audit = await closureAudit(ctx, agent, state, seed, exec.signal);

      const answer = await askUser(
        ctx,
        agent,
        [
          {
            id: 'restate',
            header: 'Seed restate',
            question: '下面是即将锁定的 Seed。请显式批准（只批准这一份 restate）：',
            detail: restateText(seed),
            options: [{ label: APPROVE_LABEL }, { label: '再改改' }],
            intent: { kind: 'plan-review', approve: APPROVE_LABEL },
          },
          {
            id: 'client_ready',
            header: '就绪确认',
            question: `歧义总分 ${scored.total}，四维下限与连续就绪已检查。确认进入 Seed 就绪验收？`,
            options: [{ label: CLIENT_GATE_LABEL }, { label: '还没好' }],
          },
        ],
        exec.signal,
      );
      const answers = answerMap(answer);
      const restateApproved = (answers.restate?.selected ?? []).includes(APPROVE_LABEL);
      const clientGate = (answers.client_ready?.selected ?? []).includes(CLIENT_GATE_LABEL);

      const floors = scored.floors ?? {};
      const gateInput = {
        answered_rounds: state.answered_rounds,
        ambiguity_total: scored.total,
        floors,
        streak: scored.streak,
        closure_audit_passed: audit.passed,
        seed,
        restate_approved: restateApproved,
        client_gate: clientGate,
        force: args.force === true,
      };
      const gateResult = seedGates(gateInput);
      const qualityNotes = [
        ...audit.gaps,
        ...(audit.notes === null ? [] : [audit.notes]),
        ...gateResult.gates.filter((gate) => !gate.passed).map((gate) => `${gate.name}: ${gate.detail}`),
      ];

      if (!gateResult.passed) {
        return {
          seed_id: null,
          path: null,
          gates: gateResult.gates,
          forced: args.force === true,
          passed: false,
          quality_notes: qualityNotes,
          next_action: 'ooo_interview',
        };
      }

      const seedPath = join(paths.seeds_dir, `${seedId}.json`);
      writeJsonAtomic(seedPath, JSON.parse(serializeSeed(seed)));
      writeSeedLock(paths, {
        seed_id: seedId,
        hash: hashSeed(seed),
        gates_passed: gateResult.gates.map((gate) => gate.name),
        gate_forced: args.force === true,
        ambiguity_score: scored.total,
        interview_id: state.interview_id,
        created_at: nowIso(),
      });
      appendLedger(paths, 'seed.locked', {
        seed_id: seedId,
        hash: hashSeed(seed),
        ambiguity_score: scored.total,
        gate_forced: args.force === true,
        gates_passed: gateResult.gates.map((gate) => gate.name),
      });

      return {
        seed_id: seedId,
        path: seedPath,
        gates: gateResult.gates,
        forced: args.force === true,
        passed: true,
        quality_notes: qualityNotes,
        ac_keys: seed.acceptance_criteria.map((ac) => semanticAcKey(ac)),
        next_action: 'ooo_run',
      };
    },
  });
}
