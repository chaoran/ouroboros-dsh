import test from 'node:test';
import assert from 'node:assert/strict';

import { independenceOf, stage3Result, tally, voteValue } from '../core/consensus.js';

function vote(approved, reviewer_id) {
  return { approved, reviewer_id };
}

test('计票：赞成/有效票 ≥0.66 且有效票 ≥2', () => {
  const result = tally([vote(true, 'r1'), vote(true, 'r2'), vote(false, 'r3')]);
  assert.equal(result.approved, true);
  assert.equal(result.majority_ratio, 0.6667);
  assert.equal(result.valid_votes, 3);
  assert.equal(result.approve_votes, 2);
  assert.equal(result.error, null);

  const half = tally([vote(true, 'r1'), vote(false, 'r2')]);
  assert.equal(half.approved, false);
  assert.equal(half.majority_ratio, 0.5);

  const unanimous = tally([vote(true, 'r1'), vote(true, 'r2'), vote(true, 'r3')]);
  assert.equal(unanimous.majority_ratio, 1);
  assert.equal(unanimous.approved, true);
});

test('有效票不足 = 错误', () => {
  const one = tally([vote(true, 'r1')]);
  assert.equal(one.valid_votes, 1);
  assert.equal(one.approved, false);
  assert.equal(one.ok, false);
  assert.match(one.error, /有效票不足/);

  const invalidated = tally([vote(true, 'r1'), { ...vote(true, 'r2'), valid: false }]);
  assert.equal(invalidated.valid_votes, 1);
  assert.equal(invalidated.error !== null, true);

  const empty = tally([]);
  assert.equal(empty.valid_votes, 0);
  assert.equal(empty.error !== null, true);
});

test('两种票面写法都识别，非法票不计入有效票', () => {
  assert.equal(voteValue({ vote: 'approve' }), true);
  assert.equal(voteValue({ vote: 'reject' }), false);
  assert.equal(voteValue({ approved: true }), true);
  assert.equal(voteValue({}), null);
  const result = tally([{ vote: 'approve', reviewer_id: 'a' }, { vote: 'approve', reviewer_id: 'b' }, {}]);
  assert.equal(result.valid_votes, 2);
  assert.equal(result.total_votes, 3);
  assert.equal(result.approved, true);
});

test('独立性标注：distinct=independent，重复=shared-context，缺 id=unlabeled', () => {
  assert.equal(independenceOf([vote(true, 'r1'), vote(false, 'r2')]), 'independent');
  assert.equal(independenceOf([vote(true, 'r1'), vote(false, 'r1')]), 'shared-context');
  assert.equal(independenceOf([{ approved: true }, { approved: false }]), 'unlabeled');
  assert.equal(independenceOf([vote(true, 'r1')]), 'insufficient');
});

test('stage3.json 结构', () => {
  const votes = [vote(true, 'r1'), vote(true, 'r2'), vote(false, 'r3')];
  const stage3 = stage3Result(votes);
  assert.equal(stage3.approved, true);
  assert.equal(stage3.majority_ratio, 0.6667);
  assert.equal(stage3.votes.length, 3);
  assert.equal(stage3.reviewer_independence, 'independent');
  assert.equal('error' in stage3, false);

  const insufficient = stage3Result([vote(true, 'r1')]);
  assert.equal(insufficient.approved, false);
  assert.match(insufficient.error, /有效票不足/);
});
