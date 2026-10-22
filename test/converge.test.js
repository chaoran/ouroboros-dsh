import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BLOCK_GATE_NAMES,
  acCoverage,
  blockGates,
  isOscillating,
  isPlateau,
  isStalled,
  perAcAuthority,
  seedSimilarity,
  similarity,
  stopReason,
} from '../core/converge.js';
import {
  CONVERGE_SIMILARITY,
  MAX_GENERATIONS,
  MIN_GENERATIONS,
  PLATEAU_SCORE_DELTA,
} from '../core/constants.js';

const CLEAR_BLOCKS = {
  evaluated: true,
  verdict: 'approved',
  ac_coverage_complete: true,
  per_ac_authority: true,
  score: 0.9,
  regression: false,
  validation_passed: true,
};

function generation(similarityValue, score, approved = false, evaluated = true) {
  return { similarity: similarityValue, score, approved, evaluated };
}

test('相似度 = 0.5×名称重合 + 0.3×类型匹配 + 0.2×完全一致，分母 |旧 ∪ 新|', () => {
  const unchanged = [{ name: 'a', field_type: 'x', description: 'd' }];
  assert.equal(similarity(unchanged, unchanged), 1);
  assert.equal(similarity([], []), 1);

  const added = [
    { name: 'a', field_type: 'x', description: 'd' },
    { name: 'b', field_type: 'y', description: 'e' },
  ];
  // union=2, common=1, type=1, exact=1 -> 0.5*0.5 + 0.3*0.5 + 0.2*0.5 = 0.5
  assert.equal(similarity(unchanged, added), 0.5);

  const retyped = [{ name: 'a', field_type: 'z', description: 'd' }];
  // union=1, common=1, type=0, exact=0
  assert.equal(similarity(unchanged, retyped), 0.5);

  const redescribed = [{ name: 'a', field_type: 'x', description: 'other' }];
  // union=1, common=1, type=1, exact=0 -> 0.5+0.3 = 0.8
  assert.equal(similarity(unchanged, redescribed), 0.8);

  const seedA = { ontology_schema: { fields: unchanged } };
  const seedB = { ontology_schema: { fields: added } };
  assert.equal(seedSimilarity(seedA, seedB), 0.5);
});

test('block gate 六项：全部清空才算收敛资格', () => {
  assert.deepEqual(BLOCK_GATE_NAMES, [
    'evaluation_approved',
    'seed_ac_coverage',
    'per_ac_authority',
    'score_threshold',
    'no_regression',
    'validation_passed',
  ]);
  const clear = blockGates(CLEAR_BLOCKS);
  assert.equal(clear.all_clear, true);
  assert.deepEqual(clear.blockers, []);

  assert.deepEqual(blockGates({ ...CLEAR_BLOCKS, score: 0.69 }).blockers, ['score_threshold']);
  assert.equal(blockGates({ ...CLEAR_BLOCKS, score: 0.7 }).all_clear, true);
  assert.deepEqual(blockGates({ ...CLEAR_BLOCKS, verdict: 'rejected' }).blockers, [
    'evaluation_approved',
  ]);
  assert.deepEqual(blockGates({ ...CLEAR_BLOCKS, evaluated: false }).blockers, [
    'evaluation_approved',
  ]);
  assert.deepEqual(blockGates({ ...CLEAR_BLOCKS, regression: true }).blockers, ['no_regression']);
  assert.deepEqual(blockGates({ ...CLEAR_BLOCKS, validation_passed: false }).blockers, [
    'validation_passed',
  ]);
  // 缺字段一律 fail closed
  assert.equal(blockGates({}).all_clear, false);
});

test('收敛 = 相似度 ≥0.95 且 block 全清空；相似度 0.949 不收敛', () => {
  const history = [generation(0.96, 0.9, true)];
  const converged = stopReason({ history, generation: 5, blocks: CLEAR_BLOCKS });
  assert.equal(converged.converged, true);
  assert.equal(converged.reason, 'converged');
  assert.equal(converged.stop, true);

  const justBelow = stopReason({
    history: [generation(0.949, 0.9, true)],
    generation: 5,
    blocks: CLEAR_BLOCKS,
  });
  assert.equal(justBelow.converged, false);

  const blocked = stopReason({ history, generation: 5, blocks: { ...CLEAR_BLOCKS, score: 0.69 } });
  assert.equal(blocked.converged, false);
  assert.deepEqual(blocked.blockers, ['score_threshold']);
});

test('提前收敛：第 1 代就正确也能停（early_converged）', () => {
  const early = stopReason({
    history: [generation(1, 0.95, true)],
    generation: 1,
    blocks: CLEAR_BLOCKS,
    minGenerations: MIN_GENERATIONS,
  });
  assert.equal(early.reason, 'early_converged');
  assert.equal(early.stop, true);

  const atMin = stopReason({
    history: [generation(1, 0.95, true)],
    generation: MIN_GENERATIONS,
    blocks: CLEAR_BLOCKS,
    minGenerations: MIN_GENERATIONS,
  });
  assert.equal(atMin.reason, 'converged');
});

test('停滞：相似度 ≥0.95 连续 3 代（非终态，lineage 保留）', () => {
  const history = [generation(0.96, 0.5, false), generation(0.97, 0.6, false), generation(0.98, 0.75, false)];
  assert.equal(isStalled(history), true);
  assert.equal(isPlateau(history), false, '构造用例与平台期区分开');
  const stop = stopReason({ history, generation: 6, blocks: { ...CLEAR_BLOCKS, verdict: 'rejected' } });
  assert.equal(stop.reason, 'stalled');
  assert.equal(stop.converged, false);

  assert.equal(
    isStalled([generation(0.96, 0.5), generation(0.94, 0.6), generation(0.98, 0.7)]),
    false,
  );
});

test('振荡：第 N 代 ≈ 第 N−2 代 → 停止并报告', () => {
  const history = [generation(0.5, 0.5), generation(0.6, 0.6), generation(0.501, 0.5)];
  assert.equal(isOscillating(history), true);
  const stop = stopReason({ history, generation: 6, blocks: { ...CLEAR_BLOCKS, verdict: 'rejected' } });
  assert.equal(stop.reason, 'oscillating');

  assert.equal(isOscillating([generation(0.5, 0.5), generation(0.6, 0.6), generation(0.7, 0.7)]), false);
});

test('平台期：最近 3 代均未 approved 且相邻分差 <0.01 → 停止并报告', () => {
  const history = [
    generation(0.6, 0.4, false),
    generation(0.7, 0.408, false),
    generation(0.65, 0.415, false),
  ];
  assert.equal(isPlateau(history), true);
  assert.equal(isOscillating(history), false, '构造用例与振荡区分开');
  const stop = stopReason({ history, generation: 6, blocks: { ...CLEAR_BLOCKS, verdict: 'rejected' } });
  assert.equal(stop.reason, 'plateau');

  const approvedInWindow = [
    generation(0.6, 0.4, false),
    generation(0.7, 0.408, true),
    generation(0.65, 0.415, false),
  ];
  assert.equal(isPlateau(approvedInWindow), false);

  const tooMuchDelta = [
    generation(0.6, 0.4, false),
    generation(0.7, 0.42, false),
    generation(0.65, 0.44, false),
  ];
  assert.equal(isPlateau(tooMuchDelta), false);
  assert.equal(0.42 - 0.4 < PLATEAU_SCORE_DELTA, false);
});

test('代数上限：max_generations=30；默认上限 30，默认目标 8 由工具层传入', () => {
  const history = [generation(0.5, 0.5), generation(0.6, 0.6), generation(0.7, 0.7)];
  const capped = stopReason({ history, generation: MAX_GENERATIONS, blocks: { ...CLEAR_BLOCKS, verdict: 'rejected' } });
  assert.equal(capped.reason, 'max_generations');
  assert.equal(capped.stop, true);

  const notYet = stopReason({ history, generation: 29, maxGenerations: MAX_GENERATIONS, blocks: { ...CLEAR_BLOCKS, verdict: 'rejected' } });
  assert.equal(notYet.stop, false);
  assert.equal(notYet.reason, null);
});

test('Seed 级 AC 覆盖与每 AC 权威', () => {
  const seed = {
    acceptance_criteria: [
      { description: 'a' },
      { description: 'b' },
    ],
  };
  const complete = acCoverage(seed, [
    { ac_index: 0, authoritative_pass: true },
    { ac_index: 1, unresolved: true },
  ]);
  assert.equal(complete.complete, true);

  const missing = acCoverage(seed, [{ ac_index: 0, authoritative_pass: true }]);
  assert.equal(missing.complete, false);
  assert.deepEqual(missing.missing, [1]);

  assert.equal(perAcAuthority(seed, [
    { ac_index: 0, authoritative_pass: true },
    { ac_index: 1, authoritative_pass: false, unresolved: true },
  ]), false);
  assert.equal(perAcAuthority(seed, [
    { ac_index: 0, authoritative_pass: true },
    { ac_index: 1, authoritative_pass: true },
  ]), true);
  assert.equal(acCoverage({}, []).complete, false);
});

test('相似度阈值常量', () => {
  assert.equal(CONVERGE_SIMILARITY, 0.95);
});
