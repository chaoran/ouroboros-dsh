import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createInterviewTool } from '../tools/interview.js';
import { createSeedTool } from '../tools/seed.js';
import { createRunTool } from '../tools/run.js';
import { createEvaluateTool } from '../tools/evaluate.js';
import { createStatusTool } from '../tools/status.js';
import { hashSeed } from '../core/seed.js';

const root = mkdtempSync(join(tmpdir(), 'ooo-tools-'));
const responses = [];
const answers = [];
let exitCode = 0;
let sandboxMode = 'danger-full-access';
let confineFails = false;
let confineEnforcement = 'full';

function llmResponse(value) {
  responses.push(typeof value === 'string' ? value : JSON.stringify(value));
}

const services = {
  llm: {
    stream() {
      const text = responses.length === 0 ? '{}' : responses.shift();
      return (async function* generate() {
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'text-delta', index: 0, text };
        yield { type: 'block-end', index: 0, block: { type: 'text', text } };
      })();
    },
  },
  userQuestions: {
    async ask() {
      if (answers.length === 0) throw new Error('test: unexpected user question');
      return answers.shift();
    },
  },
  sandboxPolicy: {
    resolve() {
      return { mode: sandboxMode, workspaceRoot: root };
    },
  },
  sandbox: {
    async confine(argv, _policy) {
      if (confineFails) throw new Error('SANDBOX_UNAVAILABLE');
      return { argv: ['bwrap', ...argv], enforcement: confineEnforcement };
    },
  },
  subprocess: {
    spawn() {
      const out = exitCode === 0 ? 'all good' : 'failure detail';
      const reader = (text) => ({
        readFrom() {
          return { text, nextOffset: text.length, lossy: false };
        },
      });
      return {
        collected: { stdout: reader(out), stderr: reader(exitCode === 0 ? '' : out) },
        done: Promise.resolve({ exitCode, signal: null }),
        terminate() {},
        waitForExit: async () => true,
      };
    },
  },
};

const ctx = { get: (name) => services[name] };
const agent = {
  id: 'agent-test',
  options: { provider: 'fake', model: 'fake-model' },
  session: { header: { cwd: root } },
};
const exec = { agent, signal: new AbortController().signal };

function draftSeed() {
  return {
    goal: '做一个 markdown 预览器',
    task_type: 'code',
    constraints: ['只用标准库'],
    acceptance_criteria: [
      {
        description: '标题被渲染成 h1',
        verify_command: 'node --test test/preview.test.js',
        expected_artifacts: ['preview.js'],
        output_assertion: '输出含 <h1>',
        verify_exemption_reason: null,
      },
    ],
    ontology_schema: {
      name: 'preview',
      description: '预览器能力模型',
      fields: [
        { name: 'renderer', field_type: 'module', description: '渲染入口', required: true },
      ],
    },
    evaluation_principles: [{ name: '可测试', description: '有机械检查', weight: 1 }],
    exit_conditions: [
      { name: 'done', description: 'AC 通过', evaluation_criteria: 'Stage1 全绿' },
    ],
  };
}

test.after(() => rmSync(root, { recursive: true, force: true }));

test('ooo_interview：4 轮问答 → 账本 4 行、就绪；未锁定 Seed 时 ooo_run 拒绝', async () => {
  const interview = createInterviewTool(ctx);
  const ready = { goal: 1, constraint: 1, success: 1 };
  const partial = { goal: 0.5, constraint: 0.5, success: 0.5 };

  // Round 1 generates a question; later rounds reuse the pending one. Each
  // round therefore consumes: [score, next-question] (plus the initial question).
  llmResponse({ question: 'Q1', options: ['选项 A', '选项 B'], dimension: 'goal' });
  answers.push({ answers: [{ id: 'ooo_interview_q', selected: ['选项 A'], custom: '' }] });
  llmResponse({ clarity: partial, notes: 'test' });
  llmResponse({ question: 'Next 1', options: ['ok'], dimension: 'constraint' });
  answers.push({ answers: [{ id: 'ooo_interview_q', selected: ['选项 A'], custom: '' }] });
  llmResponse({ clarity: ready, notes: 'test' });
  llmResponse({ question: 'Next 2', options: ['ok'], dimension: 'constraint' });
  answers.push({ answers: [{ id: 'ooo_interview_q', selected: ['选项 A'], custom: '' }] });
  llmResponse({ clarity: ready, notes: 'test' });
  llmResponse({ question: 'Next 3', options: ['ok'], dimension: 'constraint' });
  answers.push({ answers: [{ id: 'ooo_interview_q', selected: ['选项 A'], custom: '' }] });
  llmResponse({ clarity: ready, notes: 'test' });
  llmResponse({ question: 'Next 4', options: ['ok'], dimension: 'constraint' });

  let last;
  for (let round = 1; round <= 4; round += 1) {
    last = await interview.execute(
      { goal: round === 1 ? '做一个 markdown 预览器' : undefined, session_id: 's1' },
      exec,
    );
    assert.equal(last.ledger_lines, round);
    assert.equal(last.answered_rounds, round);
  }
  assert.equal(last.ready, true);
  assert.equal(last.ambiguity.total, 0);
  assert.equal(last.next_action, 'ooo_seed');

  const ledger = readFileSync(join(root, '.ouroboros', 'ledger.jsonl'), 'utf8').trim().split('\n');
  const parsed = ledger.map((line) => JSON.parse(line));
  const answered = parsed.filter((event) => event.type === 'interview.answered');
  assert.equal(answered.length, 4, '账本 answered 行数 = 已答轮数');
  assert.equal(ledger.length, 4, '§10 P0.5：ledger.jsonl 行数 = 已答轮数');
  assert.equal(answered[3].data.score.total, 0);
  assert.equal(answered[3].data.score.ready, true);

  const run = createRunTool(ctx);
  await assert.rejects(
    () => run.execute({ seed_id: 'seed_0123456789ab' }, exec),
    /没有已锁定的 Seed/,
  );
});

test('ooo_seed：九道门通过 → 写 seeds/ + seed.lock.json（锁不含正文）', async () => {
  llmResponse(draftSeed());
  llmResponse({ closed: true, gaps: [], notes: '覆盖完整' });
  answers.push({
    answers: [
      { id: 'restate', selected: ['批准并锁定'], custom: '' },
      { id: 'client_ready', selected: ['确认就绪'], custom: '' },
    ],
  });

  const seedTool = createSeedTool(ctx);
  const result = await seedTool.execute({ session_id: 's1' }, exec);
  assert.equal(result.passed, true);
  assert.match(result.seed_id, /^seed_[0-9a-f]{12}$/);
  assert.equal(result.gates.length, 9);
  assert.ok(existsSync(result.path));

  const lockPath = join(root, '.ouroboros', 'seed.lock.json');
  assert.ok(existsSync(lockPath));
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  assert.equal(lock.seed_id, result.seed_id);
  assert.match(lock.hash, /^sha256:/);
  assert.equal('goal' in lock, false, '锁文件不含 Seed 正文');
  assert.equal('acceptance_criteria' in lock, false);

  const seedBody = JSON.parse(readFileSync(result.path, 'utf8'));
  assert.match(seedBody.acceptance_criteria[0].semantic_ac_key, /^ac_[0-9a-f]{16}$/);
  assert.equal(lock.hash, hashSeed(seedBody));
  assert.equal(seedBody.metadata.gate_forced, false);
});

test('ooo_seed：未获批准时返回缺口、不写新的 Seed', async () => {
  // A fresh interview that is not ready yet, and a user who declines restate.
  const interview = createInterviewTool(ctx);
  llmResponse({ question: 'Q', options: ['a'], dimension: 'goal' });
  answers.push({ answers: [{ id: 'ooo_interview_q', selected: ['a'], custom: '' }] });
  llmResponse({ clarity: { goal: 0.2, constraint: 0.2, success: 0.2 } });
  llmResponse({ question: 'Next', options: ['a'], dimension: 'goal' });
  await interview.execute({ goal: '第二个项目', session_id: 's2' }, exec);

  const before = readFileSync(join(root, '.ouroboros', 'seed.lock.json'), 'utf8');
  llmResponse(draftSeed());
  llmResponse({ closed: true, gaps: [], notes: 'ok' });
  answers.push({
    answers: [
      { id: 'restate', selected: ['再改改'], custom: '' },
      { id: 'client_ready', selected: ['还没好'], custom: '' },
    ],
  });
  const seedTool = createSeedTool(ctx);
  const result = await seedTool.execute({ session_id: 's2' }, exec);
  assert.equal(result.passed, false);
  assert.equal(result.path, null);
  assert.ok(result.gates.some((gate) => gate.name === 'answered_rounds' && !gate.passed));
  assert.ok(result.gates.some((gate) => gate.name === 'restate_approved' && !gate.passed));
  assert.equal(readFileSync(join(root, '.ouroboros', 'seed.lock.json'), 'utf8'), before, '锁未被改动');
});

test('Seed 正文被改动（哈希不一致）→ ooo_run 拒绝执行', async () => {
  const lock = JSON.parse(readFileSync(join(root, '.ouroboros', 'seed.lock.json'), 'utf8'));
  const seedPath = join(root, '.ouroboros', 'seeds', `${lock.seed_id}.json`);
  const original = readFileSync(seedPath, 'utf8');
  const tampered = JSON.parse(original);
  tampered.goal = '被篡改的目标';
  writeFileSync(seedPath, JSON.stringify(tampered, null, 2));
  try {
    await assert.rejects(
      () => createRunTool(ctx).execute({ seed_id: lock.seed_id }, exec),
      /哈希不一致/,
    );
  } finally {
    writeFileSync(seedPath, original);
  }
});

test('ooo_evaluate：有 Stage1 执行证据 → approved；删掉 mechanical.toml → unverified', async () => {
  const seedPath = JSON.parse(readFileSync(join(root, '.ouroboros', 'seed.lock.json'), 'utf8'));
  const seedId = seedPath.seed_id;

  // Fabricate one completed run (ooo_run itself is covered by the guard test).
  const runId = 'run_aaaaaaaaaaaa';
  const runDir = join(root, '.ouroboros', 'runs', runId);
  mkdirSync(join(runDir, 'artifacts'), { recursive: true });
  const seedBody = JSON.parse(
    readFileSync(join(root, '.ouroboros', 'seeds', `${seedId}.json`), 'utf8'),
  );
  writeFileSync(join(runDir, 'seed_snapshot.json'), JSON.stringify(seedBody));
  writeFileSync(
    join(runDir, 'run.json'),
    JSON.stringify({
      run_id: runId,
      seed_id: seedId,
      children: [
        {
          ac_index: 0,
          semantic_ac_key: seedBody.acceptance_criteria[0].semantic_ac_key,
          child_id: 'child-prior',
          stop_reason: 'completed',
        },
      ],
    }),
  );
  writeFileSync(join(runDir, 'artifacts', 'ac.json'), JSON.stringify({ ac_index: 0, stop_reason: 'completed', output: 'done' }));
  writeFileSync(
    join(root, '.ouroboros', 'runs', 'index.json'),
    JSON.stringify({ runs: [{ run_id: runId, seed_id: seedId, at: new Date().toISOString() }] }),
  );
  writeFileSync(join(root, '.ouroboros', 'mechanical.toml'), 'test = "node --test test/"\n');

  exitCode = 0;
  sandboxMode = 'danger-full-access';
  llmResponse({
    score: 0.9,
    ac_compliance: true,
    goal_alignment: 0.9,
    drift_score: 0.1,
    uncertainty: 0.1,
    reward_hacking_risk: 0.1,
    reasoning: 'ok',
    items: [],
    flags: {},
  });

  const evaluate = createEvaluateTool(ctx);
  const approved = await evaluate.execute({ seed_id: seedId }, exec);
  assert.equal(approved.acceptance_state, 'approved');
  assert.deepEqual(approved.sandbox, { mode: 'danger-full-access', enforcement: 'none' });
  assert.equal(approved.stage1.has_executed_evidence, true);
  const verdict = JSON.parse(readFileSync(join(runDir, 'verdict.json'), 'utf8'));
  assert.equal(verdict.acceptance_state, 'approved');
  assert.deepEqual(verdict.sandbox, { mode: 'danger-full-access', enforcement: 'none' });

  // workspace-write: the argv goes through ctx.sandbox.confine and the
  // enforcement fact is recorded in stage1.json and verdict.sandbox.
  sandboxMode = 'workspace-write';
  confineEnforcement = 'partial';
  llmResponse({
    score: 0.9,
    ac_compliance: true,
    goal_alignment: 0.9,
    drift_score: 0,
    uncertainty: 0,
    reward_hacking_risk: 0.1,
    reasoning: 'ok',
    items: [],
    flags: {},
  });
  const confined = await evaluate.execute({ seed_id: seedId, run_id: runId }, exec);
  assert.equal(confined.acceptance_state, 'approved');
  assert.deepEqual(confined.sandbox, { mode: 'workspace-write', enforcement: 'partial' });
  const confinedStage1 = JSON.parse(readFileSync(join(runDir, 'stage1.json'), 'utf8'));
  assert.deepEqual(confinedStage1.sandbox, { mode: 'workspace-write', enforcement: 'partial' });
  sandboxMode = 'danger-full-access';
  confineEnforcement = 'full';

  // No mechanical.toml -> no executed evidence -> unverified, never approved.
  writeFileSync(join(root, '.ouroboros', 'mechanical.toml'), '# empty\n');
  llmResponse({
    score: 0.99,
    ac_compliance: true,
    goal_alignment: 1,
    drift_score: 0,
    uncertainty: 0,
    reward_hacking_risk: 0,
    reasoning: 'looks fine',
    items: [],
    flags: {},
  });
  const unverified = await evaluate.execute({ seed_id: seedId, run_id: runId }, exec);
  assert.equal(unverified.acceptance_state, 'unverified');
  assert.match(unverified.failure_reason, /没有 Stage1 执行证据/);
});

test('ooo_evaluate：Stage1 失败 → rejected；confine 失败 → fail closed 且不写 verdict', async () => {
  const seedId = JSON.parse(readFileSync(join(root, '.ouroboros', 'seed.lock.json'), 'utf8')).seed_id;
  const runId = 'run_aaaaaaaaaaaa';
  const runDir = join(root, '.ouroboros', 'runs', runId);
  writeFileSync(join(root, '.ouroboros', 'mechanical.toml'), 'test = "node --test test/"\n');

  exitCode = 1;
  llmResponse({
    score: 0.9,
    ac_compliance: true,
    goal_alignment: 0.9,
    drift_score: 0,
    uncertainty: 0,
    reward_hacking_risk: 0.1,
    reasoning: 'ok',
    items: [],
    flags: {},
  });
  const evaluate = createEvaluateTool(ctx);
  const rejected = await evaluate.execute({ seed_id: seedId, run_id: runId }, exec);
  assert.equal(rejected.acceptance_state, 'rejected');
  assert.match(rejected.failure_reason, /exit 1/);

  // workspace-write + failing confine: the run must refuse, and leave the
  // previous verdict untouched (fail closed, never a bare spawn).
  const verdictBefore = readFileSync(join(runDir, 'verdict.json'), 'utf8');
  sandboxMode = 'workspace-write';
  confineFails = true;
  await assert.rejects(
    () => evaluate.execute({ seed_id: seedId, run_id: runId }, exec),
    /fail closed|SANDBOX_UNAVAILABLE/,
  );
  assert.equal(readFileSync(join(runDir, 'verdict.json'), 'utf8'), verdictBefore);
  confineFails = false;
  sandboxMode = 'danger-full-access';
});

test('Stage1 命令被拒绝（shell 元字符）→ rejected；mechanical.toml 语法错误 → 拒绝评测', async () => {
  const seedId = JSON.parse(readFileSync(join(root, '.ouroboros', 'seed.lock.json'), 'utf8')).seed_id;
  const runId = 'run_aaaaaaaaaaaa';
  const runDir = join(root, '.ouroboros', 'runs', runId);
  writeFileSync(join(root, '.ouroboros', 'mechanical.toml'), 'test = "node --test test/ && rm -rf /"\n');
  llmResponse({
    score: 0.99,
    ac_compliance: true,
    goal_alignment: 1,
    drift_score: 0,
    uncertainty: 0,
    reward_hacking_risk: 0,
    reasoning: 'ok',
    items: [],
    flags: {},
  });
  const evaluate = createEvaluateTool(ctx);
  const rejected = await evaluate.execute({ seed_id: seedId, run_id: runId }, exec);
  assert.equal(rejected.acceptance_state, 'rejected');
  assert.match(rejected.failure_reason, /rejected: .*shell 元字符/);

  const verdictBefore = readFileSync(join(runDir, 'verdict.json'), 'utf8');
  writeFileSync(join(root, '.ouroboros', 'mechanical.toml'), 'bogus_key = "x"\n');
  await assert.rejects(
    () => evaluate.execute({ seed_id: seedId, run_id: runId }, exec),
    /mechanical\.toml 解析错误/,
  );
  assert.equal(readFileSync(join(runDir, 'verdict.json'), 'utf8'), verdictBefore);
  writeFileSync(join(root, '.ouroboros', 'mechanical.toml'), 'test = "node --test test/"\n');
});

test('ooo_status：只读汇总 + footer 恰为一行', async () => {
  const status = createStatusTool(ctx);
  const result = await status.execute({}, exec);
  assert.equal(result.locked, true);
  assert.ok(['approved', 'rejected', 'unverified', 'awaiting-evaluation'].includes(result.phase));
  assert.match(result.footer, /^◆ .+ → next: .+$/);
  assert.equal(result.footer.split('\n').length, 1);
});

test('read-only 会话：写状态的操作返回可读错误（§2.4 表）', async () => {
  sandboxMode = 'read-only';
  try {
    await assert.rejects(
      () => createInterviewTool(ctx).execute({ goal: '只读测试', session_id: 'ro' }, exec),
      /read-only/,
    );
    await assert.rejects(
      () => createRunTool(ctx).execute({ seed_id: 'seed_0123456789ab' }, exec),
      /read-only/,
    );
    // ooo_status is read-only itself and must still work.
    const status = await createStatusTool(ctx).execute({}, exec);
    assert.match(status.footer, /^◆ .+ → next: .+$/);
  } finally {
    sandboxMode = 'danger-full-access';
  }
});

test('P1-B：ooo_run 在 ledger 追加失败后释放 .lock（不再永久 BUSY）', async () => {
  const lock = JSON.parse(readFileSync(join(root, '.ouroboros', 'seed.lock.json'), 'utf8'));
  const ledgerPath = join(root, '.ouroboros', 'ledger.jsonl');
  const writerLock = join(root, '.ouroboros', '.lock');
  const originalLedger = readFileSync(ledgerPath, 'utf8');
  writeFileSync(ledgerPath, `${originalLedger}this is not json\n`);
  try {
    await assert.rejects(
      () => createRunTool(ctx).execute({ seed_id: lock.seed_id }, exec),
      /ledger 解析失败/,
    );
    assert.equal(existsSync(writerLock), false, '失败后必须释放 O_EXCL 写锁');
    await assert.rejects(
      () => createRunTool(ctx).execute({ seed_id: lock.seed_id }, exec),
      (error) => !/BUSY/.test(error.message) && /ledger 解析失败/.test(error.message),
    );
    assert.equal(existsSync(writerLock), false);
  } finally {
    writeFileSync(ledgerPath, originalLedger);
  }
});

test('P1-C：continuing:true 在 child 不在 registry 时仍走 sendMessage 续跑（冷恢复）', async () => {
  const lock = JSON.parse(readFileSync(join(root, '.ouroboros', 'seed.lock.json'), 'utf8'));
  let spawnCalls = 0;
  let sendTarget = null;
  let published = false;
  const events = [];
  const child = {
    async whenIdle() {
      events.push({
        type: 'assistant/message',
        data: { message: { content: [{ type: 'text', text: 'continued output' }] } },
      });
    },
    session: { snapshotEvents: () => events },
  };
  services.agents = {
    get: (id) => (published && id === 'child-prior' ? child : undefined),
  };
  services.subagents = {
    async sendMessage(sender, targetId, content, options) {
      sendTarget = targetId;
      assert.equal(sender, agent);
      assert.equal(content[0].type, 'text');
      assert.equal(typeof options.signal, 'object');
      published = true;
      return 'msg-continued';
    },
    async startActivation() {
      spawnCalls += 1;
      throw new Error('continuing:true must not spawn a new subagent');
    },
  };
  try {
    const result = await createRunTool(ctx).execute({ seed_id: lock.seed_id, continuing: true }, exec);
    assert.equal(spawnCalls, 0, '不得静默新建子代理');
    assert.equal(sendTarget, 'child-prior');
    assert.equal(result.children.length, 1);
    assert.equal(result.children[0].continued, true);
    assert.equal(result.children[0].child_id, 'child-prior');
    assert.equal(result.children[0].message_id, 'msg-continued');
    assert.match(result.children[0].output, /continued output/);
    assert.equal(existsSync(join(root, '.ouroboros', '.lock')), false);
  } finally {
    services.agents = undefined;
    services.subagents = undefined;
  }
});

test('P1-C：sendMessage 失败时报错而非静默新建子代理', async () => {
  const lock = JSON.parse(readFileSync(join(root, '.ouroboros', 'seed.lock.json'), 'utf8'));
  let spawnCalls = 0;
  services.agents = {
    get: () => ({ async whenIdle() {}, session: { snapshotEvents: () => [] } }),
  };
  services.subagents = {
    async sendMessage() {
      throw new Error('not a direct child');
    },
    async startActivation() {
      spawnCalls += 1;
      return { childId: 'new-child', result: Promise.resolve({ stopReason: 'completed', output: [] }) };
    },
  };
  try {
    await assert.rejects(
      () => createRunTool(ctx).execute({ seed_id: lock.seed_id, continuing: true }, exec),
      (error) =>
        /续跑失败/.test(error.message) &&
        /continuing:false/.test(error.message) &&
        /not a direct child/.test(error.message),
    );
    assert.equal(spawnCalls, 0, '续跑失败不得退回新建');
    assert.equal(existsSync(join(root, '.ouroboros', '.lock')), false);
  } finally {
    services.agents = undefined;
    services.subagents = undefined;
  }
});
