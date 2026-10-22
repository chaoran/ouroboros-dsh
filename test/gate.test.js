import test from 'node:test';
import assert from 'node:assert/strict';

import {
  decide,
  firstFailedCheck,
  hasExecutedEvidence,
  modelWithholds,
  withholdingReasons,
} from '../core/gate.js';

const passingStage1 = {
  has_executed_evidence: true,
  checks: [
    { check_type: 'test', passed: true, executed: true, exit_code: 0, message: 'exit 0' },
    { check_type: 'lint', passed: true, executed: false, exit_code: null, message: 'skipped' },
  ],
};

const cleanStage2 = {
  score: 0.9,
  ac_compliance: true,
  goal_alignment: 0.9,
  drift_score: 0.1,
  uncertainty: 0.1,
  reward_hacking_risk: 0.1,
  reasoning: 'ok',
};

const approvedStage3 = {
  approved: true,
  majority_ratio: 0.6667,
  votes: [],
  reviewer_independence: 'independent',
};

test('无 Stage1 执行证据 → unverified（删掉 mechanical.toml 的情形）', () => {
  const noChecks = { has_executed_evidence: false, checks: [] };
  assert.equal(hasExecutedEvidence(noChecks), false);
  const verdict = decide({ stage1: noChecks, stage2: null });
  assert.equal(verdict.acceptance_state, 'unverified');
  assert.match(verdict.failure_reason, /没有 Stage1 执行证据/);

  const skippedOnly = {
    has_executed_evidence: false,
    checks: [
      { check_type: 'test', passed: true, executed: false, exit_code: null, message: 'skipped' },
    ],
  };
  assert.equal(decide({ stage1: skippedOnly, stage2: cleanStage2 }).acceptance_state, 'unverified');
});

test('有执行证据 + 模型层无扣留 → approved', () => {
  const verdict = decide({ stage1: passingStage1, stage2: cleanStage2, stage3: null });
  assert.equal(verdict.acceptance_state, 'approved');
  assert.equal(verdict.failure_reason, null);
});

test('AC 不满足（Stage1 失败）→ rejected，failure_reason 指向首个失败', () => {
  const stage1 = {
    has_executed_evidence: true,
    checks: [
      { check_type: 'lint', passed: true, executed: true, exit_code: 0, message: 'exit 0' },
      { check_type: 'test', passed: false, executed: true, exit_code: 1, message: 'exit 1: 3 tests failed' },
      { check_type: 'build', passed: false, executed: true, exit_code: 2, message: 'exit 2' },
    ],
  };
  assert.equal(firstFailedCheck(stage1).check_type, 'test');
  const verdict = decide({ stage1, stage2: cleanStage2 });
  assert.equal(verdict.acceptance_state, 'rejected');
  assert.equal(verdict.failure_reason, 'exit 1: 3 tests failed');
});

test('Stage2 扣留：ac_compliance=false ∨ score<0.8 ∨ reward_hacking_risk≥0.7', () => {
  const failCompliance = decide({
    stage1: passingStage1,
    stage2: { ...cleanStage2, ac_compliance: false },
  });
  assert.equal(failCompliance.acceptance_state, 'rejected');
  assert.match(failCompliance.failure_reason, /ac_compliance/);

  const lowScore = decide({ stage1: passingStage1, stage2: { ...cleanStage2, score: 0.79 } });
  assert.equal(lowScore.acceptance_state, 'rejected');
  assert.match(lowScore.failure_reason, /0\.79 < 0\.8/);

  const boundaryScore = decide({ stage1: passingStage1, stage2: { ...cleanStage2, score: 0.8 } });
  assert.equal(boundaryScore.acceptance_state, 'approved', 'score 恰好 0.8 不扣留');

  const hacking = decide({
    stage1: passingStage1,
    stage2: { ...cleanStage2, reward_hacking_risk: 0.7 },
  });
  assert.equal(hacking.acceptance_state, 'rejected', 'reward_hacking_risk=0.7 否决');

  const belowHacking = decide({
    stage1: passingStage1,
    stage2: { ...cleanStage2, reward_hacking_risk: 0.69 },
  });
  assert.equal(belowHacking.acceptance_state, 'approved', '0.69 不否决');
});

test('Stage3 全票赞成不能推翻 Stage2 扣留', () => {
  const verdict = decide({
    stage1: passingStage1,
    stage2: { ...cleanStage2, score: 0.5 },
    stage3: { ...approvedStage3, approved: true, majority_ratio: 1 },
  });
  assert.equal(verdict.acceptance_state, 'rejected');
  assert.match(verdict.failure_reason, /Stage2/);
});

test('Stage3 未通过 → rejected；有效票不足 → rejected 且原因可见', () => {
  const stage3Rejected = decide({
    stage1: passingStage1,
    stage2: cleanStage2,
    stage3: { approved: false, majority_ratio: 0.5, votes: [], reviewer_independence: 'independent' },
  });
  assert.equal(stage3Rejected.acceptance_state, 'rejected');
  assert.match(stage3Rejected.failure_reason, /Stage3/);

  const insufficient = decide({
    stage1: passingStage1,
    stage2: cleanStage2,
    stage3: {
      approved: false,
      majority_ratio: 0,
      votes: [],
      reviewer_independence: 'insufficient',
      error: '有效票不足：1 < 2',
    },
  });
  assert.equal(insufficient.acceptance_state, 'rejected');
  assert.match(insufficient.failure_reason, /有效票不足/);
});

test('Stage2 缺失/无法解析 → unverified，不猜', () => {
  assert.equal(decide({ stage1: passingStage1, stage2: null }).acceptance_state, 'unverified');
  assert.equal(decide({ stage1: passingStage1, stage2: undefined }).acceptance_state, 'unverified');
  assert.equal(modelWithholds(null, null), true);
  assert.deepEqual(withholdingReasons(null, null), [
    'Stage2 评审结果缺失或无法解析（不猜，按未验证处理）',
  ]);
});

test('failure_reason 优先级：Stage1 失败先于 Stage2', () => {
  const stage1 = {
    has_executed_evidence: true,
    checks: [
      { check_type: 'build', passed: false, executed: true, exit_code: 1, message: 'build broke' },
    ],
  };
  const verdict = decide({
    stage1,
    stage2: { ...cleanStage2, score: 0.1 },
    stage3: { approved: false, majority_ratio: 0, votes: [], reviewer_independence: 'insufficient' },
  });
  assert.equal(verdict.acceptance_state, 'rejected');
  assert.equal(verdict.failure_reason, 'build broke');
});
