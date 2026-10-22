import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  appendEvent,
  encodeEvent,
  foldEvents,
  foldInterview,
  nextSeq,
  parseLedger,
  queryEvents,
  readEvents,
} from '../core/ledger.js';

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'ooo-ledger-'));
  return { dir, file: join(dir, 'ledger.jsonl') };
}

test('append：单行 JSON、seq 单调、O_APPEND 原子追加', () => {
  const { dir, file } = workspace();
  try {
    const first = appendEvent(file, 'interview.answered', { answer: 'x' }, { at: '2026-10-22T10:00:00.000Z' });
    const second = appendEvent(file, 'interview.scored', { total: 0.4 }, { at: '2026-10-22T10:00:01.000Z' });
    assert.equal(first.seq, 1);
    assert.equal(second.seq, 2);

    const text = readFileSync(file, 'utf8');
    assert.ok(text.endsWith('\n'));
    const lines = text.trimEnd().split('\n');
    assert.equal(lines.length, 2);
    for (const line of lines) assert.doesNotThrow(() => JSON.parse(line));

    const events = readEvents(file);
    assert.deepEqual(events.map((event) => event.seq), [1, 2]);
    assert.equal(events[0].type, 'interview.answered');
    assert.deepEqual(events[0].data, { answer: 'x' });

    // 不存在的账本按空账本处理
    assert.deepEqual(readEvents(join(dir, 'missing.jsonl')), []);
    assert.equal(nextSeq([]), 1);
    assert.equal(nextSeq(events), 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fold：按 seq 折叠，断号/重复/乱序即报错', () => {
  const parsed = parseLedger(
    [
      encodeEvent({ seq: 1, at: '2026-10-22T10:00:00.000Z', type: 'a', data: {} }),
      encodeEvent({ seq: 2, at: '2026-10-22T10:00:01.000Z', type: 'b', data: {} }),
    ].join(''),
  );
  assert.deepEqual(parsed.errors, []);
  assert.equal(foldEvents(parsed.events).length, 2);

  assert.throws(
    () =>
      foldEvents([
        { seq: 1, at: 'x', type: 'a' },
        { seq: 3, at: 'x', type: 'b' },
      ]),
    /断号/,
  );
  assert.throws(
    () =>
      foldEvents([
        { seq: 1, at: 'x', type: 'a' },
        { seq: 1, at: 'x', type: 'b' },
      ]),
    /断号/,
  );
});

test('parse：坏行与坏字段被报告，不静默修补', () => {
  const bad = parseLedger('{"seq":1,"at":"2026-10-22T10:00:00.000Z","type":"ok","data":{}}\nnot json\n');
  assert.equal(bad.events.length, 1);
  assert.equal(bad.errors.length, 1);
  assert.match(bad.errors[0], /不是合法 JSON/);

  const badShape = parseLedger('{"seq":0,"type":"","data":{}}\n');
  assert.equal(badShape.events.length, 0);
  assert.equal(badShape.errors.length >= 1, true);

  const { dir, file } = workspace();
  try {
    writeFileSync(file, 'garbage\n');
    assert.throws(() => readEvents(file), /ledger 解析失败/);
    assert.throws(() => appendEvent(file, 'run.started'), /ledger 解析失败/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('query：按 type / since_seq / limit 过滤', () => {
  const events = [
    { seq: 1, at: '2026-10-22T10:00:00.000Z', type: 'interview.answered', data: {} },
    { seq: 2, at: '2026-10-22T10:00:01.000Z', type: 'interview.scored', data: {} },
    { seq: 3, at: '2026-10-22T10:00:02.000Z', type: 'seed.locked', data: {} },
    { seq: 4, at: '2026-10-22T10:00:03.000Z', type: 'interview.answered', data: {} },
  ];
  assert.deepEqual(queryEvents(events, { type: 'interview.answered' }).map((event) => event.seq), [1, 4]);
  assert.deepEqual(queryEvents(events, { since_seq: 3 }).map((event) => event.seq), [3, 4]);
  assert.deepEqual(queryEvents(events, { limit: 2 }).map((event) => event.seq), [3, 4]);
  assert.equal(queryEvents(events, { type: ['seed.locked', 'interview.scored'] }).length, 2);
  assert.deepEqual(foldInterview(events), {
    answered_rounds: 2,
    last_scored: {},
  });
});
