import test from 'node:test';
import assert from 'node:assert/strict';

import { TRIGGER_ORDER, stage3Trigger, triggerFromStage2 } from '../core/trigger.js';
import { TRIGGER_DRIFT, TRIGGER_UNCERTAINTY } from '../core/constants.js';

test('触发矩阵优先级顺序固定', () => {
  assert.deepEqual(TRIGGER_ORDER, [
    'manual',
    'seed_modified',
    'ontology_evolved',
    'goal_reinterpreted',
    'drift',
    'uncertainty',
    'lateral_adopted',
  ]);
});

test('首个命中即停：manual 压过所有其它信号', () => {
  const trigger = stage3Trigger({
    manual: true,
    seed_modified: true,
    ontology_evolved: true,
    goal_reinterpreted: true,
    drift_score: 0.9,
    uncertainty: 0.9,
    lateral_adopted: true,
  });
  assert.equal(trigger.trigger, 'manual');
});

test('优先级：seed 修改 > ontology 演化 > goal 重解释 > drift > uncertainty > lateral', () => {
  assert.equal(
    stage3Trigger({ seed_modified: true, ontology_evolved: true, drift_score: 0.9 }).trigger,
    'seed_modified',
  );
  assert.equal(
    stage3Trigger({ ontology_evolved: true, goal_reinterpreted: true, drift_score: 0.9 }).trigger,
    'ontology_evolved',
  );
  assert.equal(
    stage3Trigger({ goal_reinterpreted: true, drift_score: 0.9, uncertainty: 0.9 }).trigger,
    'goal_reinterpreted',
  );
  assert.equal(stage3Trigger({ drift_score: 0.9, uncertainty: 0.9, lateral_adopted: true }).trigger, 'drift');
  assert.equal(stage3Trigger({ uncertainty: 0.9, lateral_adopted: true }).trigger, 'uncertainty');
  assert.equal(stage3Trigger({ lateral_adopted: true }).trigger, 'lateral_adopted');
});

test('两个 0.3 阈值都是严格大于', () => {
  assert.equal(stage3Trigger({ drift_score: TRIGGER_DRIFT }).triggered, false);
  assert.equal(stage3Trigger({ drift_score: 0.3001 }).trigger, 'drift');
  assert.equal(stage3Trigger({ uncertainty: TRIGGER_UNCERTAINTY }).triggered, false);
  assert.equal(stage3Trigger({ uncertainty: 0.3001 }).trigger, 'uncertainty');
  assert.equal(stage3Trigger({}).triggered, false);
  assert.equal(stage3Trigger({ drift_score: '0.5' }).triggered, false);
});

test('从 Stage2 评审字段派生触发输入', () => {
  const trigger = triggerFromStage2({ drift_score: 0.31, uncertainty: 0 }, { seed_modified: false });
  assert.equal(trigger.trigger, 'drift');
  assert.equal(triggerFromStage2({ drift_score: 0, uncertainty: 0 }).triggered, false);
});
