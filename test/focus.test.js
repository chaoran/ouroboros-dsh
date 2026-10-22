import test from 'node:test';
import assert from 'node:assert/strict';

import { rewindProjection, selectFocus } from '../core/focus.js';

const ac = (description) => ({ description, semantic_ac_key: `ac_${description}` });

test('无 per-AC 证据 → 全量 active（fail closed）', () => {
  const focus = selectFocus({
    parentAcs: [ac('a'), ac('b')],
    candidateAcs: [ac('a'), ac('b')],
    acResults: [],
  });
  assert.deepEqual(focus.active, [0, 1]);
  assert.deepEqual(focus.frozen, []);
  assert.match(focus.reason, /no per-AC PASS evidence/);

  const disabled = selectFocus({
    parentAcs: [ac('a')],
    candidateAcs: [ac('a')],
    acResults: [{ ac_index: 0, authoritative_pass: true }],
    enabled: false,
  });
  assert.deepEqual(disabled.active, [0]);
});

test('AC 覆盖不完整 → 全量 active', () => {
  const focus = selectFocus({
    parentAcs: [ac('a'), ac('b')],
    candidateAcs: [ac('a'), ac('b')],
    acResults: [{ ac_index: 0, authoritative_pass: true }],
  });
  assert.deepEqual(focus.active, [0, 1]);
  assert.deepEqual(focus.frozen, []);
  assert.match(focus.reason, /覆盖不完整/);
});

test('没有失败的 AC → 全量 active（聚合失败无节点目标）', () => {
  const focus = selectFocus({
    parentAcs: [ac('a'), ac('b')],
    candidateAcs: [ac('a'), ac('b')],
    acResults: [
      { ac_index: 0, authoritative_pass: true },
      { ac_index: 1, authoritative_pass: true },
    ],
  });
  assert.deepEqual(focus.active, [0, 1]);
  assert.match(focus.reason, /no failed AC target/);
});

test('已通过且未被挑战/回归/修改的 AC 冻结，其余 active', () => {
  const focus = selectFocus({
    parentAcs: [ac('a'), ac('b'), ac('c')],
    candidateAcs: [ac('a'), ac('b'), ac('c')],
    acResults: [
      { ac_index: 0, authoritative_pass: true },
      { ac_index: 1, authoritative_pass: true },
      { ac_index: 2, unresolved: true },
    ],
  });
  assert.deepEqual(focus.frozen, [0, 1]);
  assert.deepEqual(focus.active, [2]);
  assert.match(focus.reason, /2 active|1 active/);
});

test('challenge / regression / 内容修改 / 新增 都会重新打开 AC', () => {
  const parent = [ac('a'), ac('b'), ac('c'), ac('d')];
  const candidate = [ac('a'), ac('b'), { description: 'c', semantic_ac_key: 'ac_c_changed' }, ac('d'), ac('e')];
  const focus = selectFocus({
    parentAcs: parent,
    candidateAcs: candidate,
    acResults: [
      { ac_index: 0, authoritative_pass: true },
      { ac_index: 1, authoritative_pass: true },
      { ac_index: 2, unresolved: true },
      { ac_index: 3, authoritative_pass: true },
    ],
    challengedIndices: [0],
    regressedIndices: [1],
  });
  assert.deepEqual(focus.frozen, []);
  assert.deepEqual(focus.active, [0, 1, 2, 3, 4]);

  const unchanged = selectFocus({
    parentAcs: parent,
    candidateAcs: [ac('a'), ac('b'), { description: 'c', semantic_ac_key: 'ac_c_changed' }, ac('d')],
    acResults: [
      { ac_index: 0, authoritative_pass: true },
      { ac_index: 1, authoritative_pass: true },
      { ac_index: 2, unresolved: true },
      { ac_index: 3, authoritative_pass: true },
    ],
  });
  assert.deepEqual(unchanged.frozen, [0, 1, 3]);
  assert.deepEqual(unchanged.active, [2]);
});

test('rewind 只截断投影，不删事件', () => {
  const records = [{ generation: 1 }, { generation: 2 }, { generation: 3 }];
  assert.deepEqual(rewindProjection(records, 2), [{ generation: 1 }, { generation: 2 }]);
  assert.equal(records.length, 3, '原数组保持不变');
  assert.deepEqual(rewindProjection([], 5), []);
});
