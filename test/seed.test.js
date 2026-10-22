import test from 'node:test';
import assert from 'node:assert/strict';

import {
  freezeSeed,
  hashSeed,
  makeInterviewId,
  makeSeedId,
  parseSeed,
  seedGates,
  semanticAcKey,
  serializeSeed,
  successContractJson,
  validateSeed,
} from '../core/seed.js';

function goodSeed(overrides = {}) {
  return freezeSeed({
    goal: '做一个可验证的 markdown 预览器',
    task_type: 'code',
    constraints: ['只用标准库'],
    acceptance_criteria: [
      {
        description: '预览器渲染标题',
        verify_command: 'node --test test/preview.test.js',
        expected_artifacts: ['packages/preview/index.js'],
        output_assertion: 'stdout 含 <h1>',
        verify_exemption_reason: null,
      },
      {
        description: '文件结构达标',
        verify_command: 'node --check packages/preview/index.js',
        expected_artifacts: [],
        output_assertion: null,
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
      { name: 'done', description: '全部 AC 通过', evaluation_criteria: 'Stage1 全绿' },
    ],
    metadata: {
      seed_id: 'seed_0123456789ab',
      version: '1.0.0',
      created_at: '2026-10-22T10:00:00.000Z',
      ambiguity_score: 0.18,
      gate_forced: false,
      interview_id: 'interview_0123456789abcdef',
      decision_provenance: { user_confirmed: 3, model_inferred: 4, maintainer_policy: 0 },
    },
    ...overrides,
  });
}

test('semantic_ac_key = ac_ + sha256(成功后契约)[:16]，与位置和 metadata 无关', () => {
  const ac = {
    description: '预览器渲染标题',
    verify_command: 'node --test test/preview.test.js',
    expected_artifacts: ['packages/preview/index.js'],
    output_assertion: 'stdout 含 <h1>',
  };
  const key = semanticAcKey(ac);
  assert.match(key, /^ac_[0-9a-f]{16}$/);
  assert.equal(key, semanticAcKey({ ...ac, metadata: { position: 9 } }));
  assert.notEqual(key, semanticAcKey({ ...ac, output_assertion: 'stdout 含 <h2>' }));
  assert.notEqual(key, semanticAcKey({ ...ac, verify_command: 'node --test other.js' }));
  assert.equal(
    successContractJson(ac),
    '{"description":"预览器渲染标题","verify_command":"node --test test/preview.test.js","expected_artifacts":["packages/preview/index.js"],"output_assertion":"stdout 含 <h1>"}',
  );
});

test('freezeSeed 计算每条 AC 的 key；重排数组不改变身份', () => {
  const seed = goodSeed();
  assert.match(seed.acceptance_criteria[0].semantic_ac_key, /^ac_/);
  const reordered = goodSeed();
  reordered.acceptance_criteria.reverse();
  const keys = seed.acceptance_criteria.map((ac) => ac.semantic_ac_key).sort();
  const reorderedKeys = reordered.acceptance_criteria.map((ac) => ac.semantic_ac_key).sort();
  assert.deepEqual(keys, reorderedKeys);
});

test('validateSeed：合法 Seed 通过，序列化可往返', () => {
  const seed = goodSeed();
  assert.deepEqual(validateSeed(seed), { ok: true, errors: [] });
  const roundTrip = parseSeed(serializeSeed(seed));
  assert.equal(roundTrip.ok, true);
  assert.deepEqual(roundTrip.errors, []);
  assert.match(serializeSeed(seed), /\n$/);
});

test('validateSeed：不变量逐条拒绝', () => {
  const emptyGoal = { ...goodSeed(), goal: '' };
  assert.equal(validateSeed(emptyGoal).ok, false);
  assert.match(validateSeed(emptyGoal).errors.join('\n'), /goal/);

  const badType = { ...goodSeed(), task_type: 'misc' };
  assert.equal(validateSeed(badType).ok, false);

  const assertionWithoutCommand = goodSeed();
  assertionWithoutCommand.acceptance_criteria[0].verify_command = null;
  const invalid = validateSeed(assertionWithoutCommand);
  assert.equal(invalid.ok, false);
  assert.match(invalid.errors.join('\n'), /output_assertion 非空时 verify_command 必须非空/);

  const absoluteArtifact = goodSeed();
  absoluteArtifact.acceptance_criteria[0].expected_artifacts = ['/etc/passwd'];
  assert.equal(validateSeed(absoluteArtifact).ok, false);

  const escapedArtifact = goodSeed();
  escapedArtifact.acceptance_criteria[0].expected_artifacts = ['../outside.js'];
  assert.equal(validateSeed(escapedArtifact).ok, false);

  const tamperedKey = goodSeed();
  tamperedKey.acceptance_criteria[0].semantic_ac_key = 'ac_deadbeefdeadbeef';
  assert.equal(validateSeed(tamperedKey).ok, false);

  assert.equal(validateSeed(null).ok, false);
  assert.equal(parseSeed('{not json').ok, false);
});

test('seed ids 与内容哈希', () => {
  assert.match(makeSeedId(), /^seed_[0-9a-f]{12}$/);
  assert.match(makeInterviewId(), /^interview_[0-9a-f]{16}$/);
  assert.match(makeSeedId(new Uint8Array([1, 2, 3, 4, 5, 6])), /^seed_010203040506$/);
  const seed = goodSeed();
  assert.equal(hashSeed(seed), hashSeed(goodSeed()));
  assert.match(hashSeed(seed), /^sha256:[0-9a-f]{64}$/);
  const changed = goodSeed();
  changed.goal = '另一个目标';
  assert.notEqual(hashSeed(seed), hashSeed(changed));
});

test('九道门：全部满足才通过，force 只绕过 2/3/4 且如实记录', () => {
  const seed = goodSeed();
  const passInput = {
    answered_rounds: 3,
    ambiguity_total: 0.18,
    floors: { goal: { met: true }, constraint: { met: true }, success: { met: true } },
    streak: 2,
    closure_audit_passed: true,
    seed,
    restate_approved: true,
    client_gate: true,
    force: false,
  };
  const passed = seedGates(passInput);
  assert.equal(passed.gates.length, 9);
  assert.equal(passed.passed, true);
  assert.deepEqual(
    passed.gates.map((gate) => gate.name),
    [
      'answered_rounds',
      'ambiguity_threshold',
      'clarity_floors',
      'ready_streak',
      'requirement_distillation',
      'ac_success_contract',
      'restate_approved',
      'client_acceptance_gate',
      'explicit_force',
    ],
  );

  const forced = seedGates({
    ...passInput,
    answered_rounds: 1,
    ambiguity_total: 0.55,
    floors: { goal: { met: false }, constraint: { met: true }, success: { met: true } },
    streak: 0,
    force: true,
  });
  assert.equal(forced.passed, true);
  assert.equal(forced.gates[1].detail.includes('force 绕过'), true);
  assert.match(forced.gates[1].detail, /真实分数 0\.55/);
  assert.match(forced.gates[8].detail, /gate_forced=true/);

  const noClosure = seedGates({ ...passInput, closure_audit_passed: false });
  assert.equal(noClosure.passed, false);
  assert.equal(noClosure.gates[4].passed, false);

  const unverifiable = seedGates({
    ...passInput,
    seed: goodSeed({
      acceptance_criteria: [
        {
          description: '没有成功契约的 AC',
          verify_command: null,
          expected_artifacts: [],
          output_assertion: null,
          verify_exemption_reason: null,
        },
      ],
    }),
  });
  assert.equal(unverifiable.passed, false);
  assert.equal(unverifiable.gates[5].passed, false);

  const exempted = seedGates({
    ...passInput,
    seed: goodSeed({
      acceptance_criteria: [
        {
          description: '主观产物',
          verify_command: null,
          expected_artifacts: [],
          output_assertion: null,
          verify_exemption_reason: '美观度无法机械判定',
        },
      ],
    }),
  });
  assert.equal(exempted.gates[5].passed, true);
});
