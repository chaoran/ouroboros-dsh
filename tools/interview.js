/**
 * `ooo_interview` — one interview round:
 *   record the answer -> deterministic scoring -> generate the next question
 *   -> ask the human through `ctx.userQuestions`.
 *
 * The human answer is collected inside this tool (never delegated to the
 * model), and the score/readiness decision is made by core/ambiguity.js.
 */
import { DIMENSIONS } from '../core/constants.js';
import {
  describeAmbiguity,
  evaluateInterview,
  weakestDimension,
} from '../core/ambiguity.js';
import { makeInterviewId } from '../core/seed.js';
import {
  OuroborosError,
  answerMap,
  appendLedger,
  askUser,
  callLlmJson,
  countLedgerByType,
  defineOooTool,
  ensureStateDirs,
  loadInterview,
  nowIso,
  projectPaths,
  projectRoot,
  readLedger,
  requireAgent,
  requireWritableSession,
  requireMainSession,
  saveInterview,
} from './shared.js';

const QUESTION_ID = 'ooo_interview_q';

function transcriptOf(state, limit = 8) {
  return state.answers
    .slice(-limit)
    .map((entry) => `- 第 ${entry.round} 轮\n  问：${entry.question}\n  答：${entry.answer}`)
    .join('\n');
}

function clampUnit(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(1, value));
}

/** Deterministic fallback when the model does not return usable clarity. */
function bumpClarity(mode, clarity, dimension) {
  const next = {};
  for (const dim of DIMENSIONS[mode]) {
    const base = clampUnit(clarity?.[dim]) ?? 0;
    next[dim] = Math.min(1, Math.round((base + (dim === dimension ? 0.2 : 0.05)) * 1e4) / 1e4);
  }
  return next;
}

function fallbackQuestion(mode, clarity) {
  const dimension = weakestDimension(mode, clarity);
  const label = {
    goal: '目标',
    constraint: '约束',
    success: '成功标准',
    context: '上下文',
  }[dimension];
  return {
    dimension,
    question: `关于「${label}」：你能给一个更具体、可验证的说法吗？`,
    options: [
      `我直接补充${label}的细节`,
      `请给我${label}的候选写法`,
      `跳过这个问题，先聊别的`,
    ],
  };
}

async function generateQuestion(ctx, agent, state, evaluated, signal) {
  const dimension = weakestDimension(state.mode, evaluated.clarity);
  const dims = DIMENSIONS[state.mode];
  const fallback = fallbackQuestion(state.mode, evaluated.clarity);
  const result = await callLlmJson(ctx, agent, {
    temperature: 0.4,
    maxTokens: 800,
    signal,
    system:
      '你是 Ouroboros 访谈的提问器。只输出一个 JSON 对象，不要 Markdown。' +
      '你的提问只影响措辞与选项；歧义分数由外部代码计算。',
    prompt: [
      `目标：${state.goal}`,
      `访谈模式：${state.mode}`,
      `当前各维度清晰度：${dims.map((dim) => `${dim}=${evaluated.clarity[dim]}`).join(', ')}`,
      `当前歧义总分：${evaluated.total}`,
      `最需要补齐的维度：${dimension}`,
      '已有问答：',
      transcriptOf(state) || '（还没有）',
      '',
      '请针对最弱维度问下一个问题。输出 JSON：',
      `{"question":"一句中文问题","options":["2-4 个简短选项"],"dimension":"${dimension}"}`,
    ].join('\n'),
  });
  if (!result.ok || typeof result.value?.question !== 'string' || result.value.question.trim() === '') {
    return fallback;
  }
  const options = Array.isArray(result.value.options)
    ? result.value.options.filter((option) => typeof option === 'string' && option.trim() !== '').slice(0, 4)
    : [];
  return {
    dimension: dims.includes(result.value.dimension) ? result.value.dimension : dimension,
    question: result.value.question.trim(),
    options,
  };
}

async function scoreClarity(ctx, agent, state, answerText, signal) {
  const dims = DIMENSIONS[state.mode];
  const dimension =
    state.pending_question?.dimension !== undefined && dims.includes(state.pending_question.dimension)
      ? state.pending_question.dimension
      : weakestDimension(state.mode, state.clarity);
  const fallback = bumpClarity(state.mode, state.clarity, dimension);

  const result = await callLlmJson(ctx, agent, {
    temperature: 0.2,
    maxTokens: 700,
    signal,
    system:
      '你是 Ouroboros 访谈的清晰度评分器。只输出一个 JSON 对象，不要 Markdown。' +
      '你只提供 clarity 分量；总分、下限、就绪判定由外部代码计算，不要自己判断就绪。',
    prompt: [
      `目标：${state.goal}`,
      `访谈模式：${state.mode}`,
      `当前清晰度：${dims.map((dim) => `${dim}=${state.clarity?.[dim] ?? 0}`).join(', ')}`,
      `本轮追问的维度：${dimension}`,
      `用户本轮回答：${answerText}`,
      '',
      '结合全部问答，为每个维度给出 0..1 的清晰度（可保持不变）。输出 JSON：',
      `{"clarity":{${dims.map((dim) => `"${dim}":0.0`).join(',')}},"notes":"一句话理由"}`,
    ].join('\n'),
  });

  if (!result.ok || result.value?.clarity === null || typeof result.value?.clarity !== 'object') {
    return { clarity: fallback, source: 'deterministic_fallback' };
  }
  const clarity = {};
  for (const dim of dims) {
    const value = clampUnit(result.value.clarity[dim]);
    clarity[dim] = value === null ? (clampUnit(state.clarity?.[dim]) ?? 0) : value;
  }
  return { clarity, source: 'llm', notes: typeof result.value.notes === 'string' ? result.value.notes : null };
}

export function createInterviewTool(ctx) {
  return defineOooTool({
    name: 'ooo_interview',
    description:
      '一轮 Ouroboros 访谈：记录答案、确定性打分、生成下一问，并通过人对人问题卡片收集答复。' +
      '必须在主会话调用；子代理不能进行访谈。',
    parameters: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: '本次要做的事（首轮提供；后续可省略）' },
        session_id: { type: 'string', description: '访谈会话 id；省略时使用当前 agent id' },
        answer: {
          type: 'string',
          description: '可选：直接给出的本轮答案（省略时会向用户展示问题卡片并等待）',
        },
        mode: {
          type: 'string',
          enum: ['greenfield', 'brownfield'],
          description: '访谈模式，默认 greenfield',
        },
      },
      additionalProperties: false,
    },
    async execute(args, exec) {
      const agent = requireAgent(exec);
      requireMainSession(ctx, agent);
      const root = projectRoot(agent);
      const paths = projectPaths(root);
      requireWritableSession(ctx, agent, root);
      ensureStateDirs(paths);

      const sessionId = String(args.session_id ?? agent.id).replace(/[^A-Za-z0-9_-]/g, '_');
      let state = loadInterview(paths, sessionId);
      if (state === undefined) {
        state = {
          interview_id: makeInterviewId(),
          session_id: sessionId,
          goal: '',
          mode: 'greenfield',
          clarity: { goal: 0, constraint: 0, success: 0 },
          streak: 0,
          answered_rounds: 0,
          answers: [],
          pending_question: null,
          last_scored: null,
          created_at: nowIso(),
          updated_at: nowIso(),
        };
      }

      if (typeof args.goal === 'string' && args.goal.trim() !== '') state.goal = args.goal.trim();
      if (args.mode === 'greenfield' || args.mode === 'brownfield') state.mode = args.mode;
      if (state.goal === '') {
        throw new OuroborosError(
          '缺少 goal：先告诉 ooo_interview 你想做什么（例如 "ooo 我想做一个 markdown 预览器"）',
          'MISSING_GOAL',
        );
      }

      let question = state.pending_question ?? null;
      let answerText = typeof args.answer === 'string' ? args.answer.trim() : '';
      let answerSource = 'argument';

      if (answerText === '') {
        if (question === null) {
          question = await generateQuestion(ctx, agent, state, state.last_scored ?? evaluateInterview({ mode: state.mode, clarity: state.clarity }), exec.signal);
        }
        const answer = await askUser(
          ctx,
          agent,
          [
            {
              id: QUESTION_ID,
              header: 'ooo 访谈',
              question: question.question,
              options: (question.options ?? []).map((label) => ({ label })),
            },
          ],
          exec.signal,
        );
        const item = answerMap(answer)[QUESTION_ID];
        answerText = (item?.custom?.trim() || item?.selected?.[0]?.trim() || '').trim();
        answerSource = 'user_card';
        if (answerText === '') {
          throw new OuroborosError('用户没有提供答案；访谈没有推进，状态未改动', 'NO_ANSWER');
        }
      }

      const round = state.answered_rounds + 1;
      state.answers.push({
        round,
        question: question?.question ?? '（直接回答）',
        dimension: question?.dimension ?? null,
        answer: answerText,
        source: answerSource,
        at: nowIso(),
      });
      state.answered_rounds = round;

      const scored = await scoreClarity(ctx, agent, state, answerText, exec.signal);
      const evaluated = evaluateInterview({
        mode: state.mode,
        clarity: scored.clarity,
        answered_rounds: round,
        streak: state.streak,
        unanswered: false,
      });
      state.clarity = evaluated.clarity;
      state.streak = evaluated.streak;
      state.last_scored = evaluated;
      state.updated_at = nowIso();

      const nextQuestion = await generateQuestion(ctx, agent, state, evaluated, exec.signal);
      state.pending_question = nextQuestion;
      saveInterview(paths, sessionId, state);

      // One ledger line per answered round: the answer and the deterministic
      // score travel together, so `ledger.jsonl` line count == answered rounds
      // (design §10 P0.5). `interview.scored` remains a reserved event type for
      // external re-scoring, but this tool does not emit a second line here.
      appendLedger(paths, 'interview.answered', {
        interview_id: state.interview_id,
        round,
        question: state.answers[state.answers.length - 1].question,
        answer: answerText,
        source: answerSource,
        scoring_source: scored.source,
        score: {
          total: evaluated.total,
          clarity: evaluated.clarity,
          milestone: evaluated.milestone,
          streak: evaluated.streak,
          ready: evaluated.ready,
        },
      });
      const ledgerLines = countLedgerByType(readLedger(paths), 'interview.answered');

      return {
        session_id: sessionId,
        interview_id: state.interview_id,
        goal: state.goal,
        mode: state.mode,
        question: nextQuestion.question,
        options: nextQuestion.options ?? [],
        ambiguity: {
          total: evaluated.total,
          dimensions: evaluated.clarity,
          milestone: evaluated.milestone,
          pinned: evaluated.pinned,
          streak: evaluated.streak,
          ready_candidate: evaluated.ready_candidate,
          summary: describeAmbiguity(evaluated),
        },
        floors: evaluated.floors,
        milestone: evaluated.milestone,
        ready: evaluated.ready,
        answered_rounds: evaluated.answered_rounds,
        ledger_lines: ledgerLines,
        next_action: evaluated.ready ? 'ooo_seed' : 'ooo_interview',
      };
    },
  });
}
