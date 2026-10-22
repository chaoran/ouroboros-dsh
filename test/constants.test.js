import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AMBIGUITY_WEIGHTS,
  COVERAGE_THRESHOLD,
  CONVERGE_SIMILARITY,
  DEFAULT_GENERATIONS,
  MAX_GENERATIONS,
  MIN_GENERATIONS,
  PLATEAU_SCORE_DELTA,
  READY_FLOORS,
  READY_MIN_ANSWERED_ROUNDS,
  READY_STREAK,
  READY_TOTAL_MAX,
  SIMILARITY_WEIGHTS,
  STAGE2_REWARD_HACKING_MAX,
  STAGE2_SCORE_MIN,
  STAGE3_APPROVAL_RATIO,
  STAGE3_MIN_VOTES,
  STAGE1_TIMEOUT_MS,
  STALL_GENERATIONS,
  TRIGGER_DRIFT,
  TRIGGER_UNCERTAINTY,
  UNANSWERED_PIN,
} from '../core/constants.js';

test('§7 阈值逐条固定', () => {
  assert.equal(READY_TOTAL_MAX, 0.2);
  assert.deepEqual(READY_FLOORS, { goal: 0.75, constraint: 0.65, success: 0.7, context: 0.6 });
  assert.equal(READY_STREAK, 2);
  assert.equal(READY_MIN_ANSWERED_ROUNDS, 3);
  assert.equal(UNANSWERED_PIN, 0.21);
  assert.equal(STAGE2_SCORE_MIN, 0.8);
  assert.equal(STAGE2_REWARD_HACKING_MAX, 0.7);
  assert.equal(TRIGGER_DRIFT, 0.3);
  assert.equal(TRIGGER_UNCERTAINTY, 0.3);
  assert.equal(STAGE3_APPROVAL_RATIO, 0.66);
  assert.equal(STAGE3_MIN_VOTES, 2);
  assert.equal(STAGE1_TIMEOUT_MS, 300_000);
  assert.equal(COVERAGE_THRESHOLD, 0.7);
  assert.deepEqual(SIMILARITY_WEIGHTS, { name: 0.5, type: 0.3, exact: 0.2 });
  assert.equal(CONVERGE_SIMILARITY, 0.95);
  assert.equal(STALL_GENERATIONS, 3);
  assert.equal(PLATEAU_SCORE_DELTA, 0.01);
  assert.equal(MIN_GENERATIONS, 3);
  assert.equal(MAX_GENERATIONS, 30);
  assert.equal(DEFAULT_GENERATIONS, 8);
});

test('§7 权重：greenfield 0.40/0.30/0.30，brownfield 0.35/0.25/0.25/0.15', () => {
  assert.deepEqual(AMBIGUITY_WEIGHTS.greenfield, { goal: 0.4, constraint: 0.3, success: 0.3 });
  assert.deepEqual(AMBIGUITY_WEIGHTS.brownfield, {
    goal: 0.35,
    constraint: 0.25,
    success: 0.25,
    context: 0.15,
  });
});
