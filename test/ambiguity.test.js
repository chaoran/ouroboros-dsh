import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ambiguityTotal,
  checkFloors,
  describeAmbiguity,
  evaluateInterview,
  milestoneOf,
  normalizeClarity,
  round4,
  weakestDimension,
} from '../core/ambiguity.js';

const ALL_CLEAR = { goal: 1, constraint: 1, success: 1 };

test('总分 = round(1 − Σ(clarity×weight), 4)：greenfield 权重', () => {
  assert.equal(ambiguityTotal('greenfield', { goal: 0, constraint: 0, success: 0 }), 1);
  assert.equal(ambiguityTotal('greenfield', ALL_CLEAR), 0);
  // 1 - (0.7*0.4 + 0.9*0.3 + 0.9*0.3) = 1 - 0.82 = 0.18
  assert.equal(ambiguityTotal('greenfield', { goal: 0.7, constraint: 0.9, success: 0.9 }), 0.18);
  assert.equal(round4(0.123456), 0.1235);
});

test('总分：brownfield 权重与 context 维度', () => {
  // 1 - (0.35 + 0.25 + 0.25) = 0.15
  assert.equal(
    ambiguityTotal('brownfield', { goal: 1, constraint: 1, success: 1, context: 0 }),
    0.15,
  );
  assert.equal(
    ambiguityTotal('brownfield', { goal: 1, constraint: 1, success: 1, context: 1 }),
    0,
  );
});

test('四维下限：goal 0.75 / constraint 0.65 / success 0.70 / context 0.60', () => {
  const green = checkFloors('greenfield', { goal: 0.75, constraint: 0.65, success: 0.7 });
  assert.equal(green.met, true);
  assert.deepEqual(
    Object.fromEntries(Object.entries(green.dimensions).map(([k, v]) => [k, v.clarity])),
    { goal: 0.75, constraint: 0.65, success: 0.7 },
  );

  const below = checkFloors('greenfield', { goal: 0.7499, constraint: 0.65, success: 0.7 });
  assert.equal(below.met, false);
  assert.equal(below.dimensions.goal.met, false);

  const brown = checkFloors('brownfield', {
    goal: 0.8,
    constraint: 0.7,
    success: 0.7,
    context: 0.59,
  });
  assert.equal(brown.met, false);
  assert.equal(brown.dimensions.context.min, 0.6);
});

test('验收 §10 P0.4：总分 0.18 但 goal clarity 0.70 → 仍未就绪', () => {
  const result = evaluateInterview({
    mode: 'greenfield',
    clarity: { goal: 0.7, constraint: 0.9, success: 0.9 },
    answered_rounds: 5,
    streak: 5,
    unanswered: false,
  });
  assert.equal(result.total, 0.18);
  assert.equal(result.floors.goal.met, false);
  assert.equal(result.ready_candidate, false);
  assert.equal(result.ready, false);
});

test('就绪 = 总分≤0.2 ∧ 四维下限 ∧ 连续2次 ∧ ≥3轮已答 ∧ 无未答', () => {
  const second = evaluateInterview({
    clarity: ALL_CLEAR,
    answered_rounds: 3,
    streak: 1,
  });
  assert.equal(second.ready_candidate, true);
  assert.equal(second.streak, 2);
  assert.equal(second.ready, true);

  const first = evaluateInterview({ clarity: ALL_CLEAR, answered_rounds: 3, streak: 0 });
  assert.equal(first.streak, 1);
  assert.equal(first.ready, false, '连续就绪候选只有 1 次时不得就绪');

  const tooFewRounds = evaluateInterview({ clarity: ALL_CLEAR, answered_rounds: 2, streak: 5 });
  assert.equal(tooFewRounds.ready_candidate, false);
  assert.equal(tooFewRounds.streak, 0, '不满足条件会重置 streak');
});

test('0.21 钉子：非首轮存在未答 → 总分 ≥0.21，永不就绪', () => {
  const pinned = evaluateInterview({
    clarity: ALL_CLEAR,
    answered_rounds: 2,
    streak: 0,
    unanswered: true,
  });
  assert.equal(pinned.total, 0.21);
  assert.equal(pinned.pinned, true);
  assert.equal(pinned.milestone, 'refined');
  assert.equal(pinned.ready, false);

  const higher = evaluateInterview({
    clarity: { goal: 0, constraint: 0, success: 0 },
    answered_rounds: 1,
    unanswered: true,
  });
  assert.equal(higher.total, 1, '钉子只抬高下限，不降低真实分数');

  const firstRound = evaluateInterview({
    clarity: ALL_CLEAR,
    answered_rounds: 0,
    unanswered: true,
  });
  assert.equal(firstRound.pinned, false, '首轮不适用钉子');
  assert.equal(firstRound.total, 0);
});

test('milestone：≤1.0 initial / ≤0.4 progress / ≤0.3 refined / ≤0.2 ready', () => {
  assert.equal(milestoneOf(1.0), 'initial');
  assert.equal(milestoneOf(0.41), 'initial');
  assert.equal(milestoneOf(0.4), 'progress');
  assert.equal(milestoneOf(0.31), 'progress');
  assert.equal(milestoneOf(0.3), 'refined');
  assert.equal(milestoneOf(0.21), 'refined');
  assert.equal(milestoneOf(0.2), 'ready');
  assert.equal(milestoneOf(0), 'ready');
});

test('辅助函数：clamp、最弱维度、摘要', () => {
  assert.deepEqual(normalizeClarity('greenfield', { goal: 2, constraint: -1, success: 0.5 }), {
    goal: 1,
    constraint: 0,
    success: 0.5,
  });
  assert.equal(weakestDimension('greenfield', { goal: 0.9, constraint: 0.2, success: 0.7 }), 'constraint');
  const result = evaluateInterview({ clarity: ALL_CLEAR, answered_rounds: 3, streak: 1 });
  assert.match(describeAmbiguity(result), /总分 0\.00（ready）/);
});
