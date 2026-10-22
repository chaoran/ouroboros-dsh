/**
 * Append-only ledger (`.ouroboros/ledger.jsonl`).
 *
 * One JSON object per line, written with a single `O_APPEND` write. Reads fold
 * by `seq`; a gap, duplicate, or out-of-order sequence is an error, never
 * silently repaired.
 *
 * Source of truth: docs/design.md §4.3 and §8.
 */
import { closeSync, openSync, readFileSync, writeSync } from 'node:fs';

/** Serialize one event as one narrow line (key order fixed). */
export function encodeEvent(event) {
  return `${JSON.stringify({
    seq: event.seq,
    at: event.at,
    type: event.type,
    data: event.data ?? {},
  })}\n`;
}

/**
 * Parse ledger text without folding.
 * @param {string} text
 * @returns {{ events: object[], errors: string[] }}
 */
export function parseLedger(text) {
  const events = [];
  const errors = [];
  const lines = String(text ?? '').split('\n');
  lines.forEach((line, index) => {
    if (line.trim() === '') return;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      errors.push(`第 ${index + 1} 行不是合法 JSON：${error.message}`);
      return;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      errors.push(`第 ${index + 1} 行不是对象`);
      return;
    }
    if (!Number.isInteger(parsed.seq) || parsed.seq < 1) {
      errors.push(`第 ${index + 1} 行 seq 必须是正整数`);
      return;
    }
    if (typeof parsed.type !== 'string' || parsed.type === '') {
      errors.push(`第 ${index + 1} 行 type 必须是非空字符串`);
      return;
    }
    if (typeof parsed.at !== 'string' || Number.isNaN(Date.parse(parsed.at))) {
      errors.push(`第 ${index + 1} 行 at 必须是 ISO8601 时间`);
      return;
    }
    events.push(parsed);
  });
  return { events, errors };
}

/**
 * Fold parsed events by `seq`: they must be 1..n contiguous in file order.
 * @param {object[]} events
 * @returns {object[]}
 * @throws when a sequence is out of order, duplicated, or gapped
 */
export function foldEvents(events) {
  const list = Array.isArray(events) ? events : [];
  list.forEach((event, index) => {
    const expected = index + 1;
    if (event.seq !== expected) {
      throw new Error(
        `ledger seq 断号：第 ${index + 1} 行的 seq 是 ${event.seq}，应为 ${expected}（账本只能追加，不能修补）`,
      );
    }
  });
  return list;
}

/** Next sequence number for an existing event list. */
export function nextSeq(events) {
  const list = Array.isArray(events) ? events : [];
  if (list.length === 0) return 1;
  return list[list.length - 1].seq + 1;
}

/** Read and fold the whole ledger. A missing file is an empty ledger. */
export function readEvents(filePath) {
  let text;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const parsed = parseLedger(text);
  if (parsed.errors.length > 0) {
    throw new Error(`ledger 解析失败：${parsed.errors[0]}`);
  }
  return foldEvents(parsed.events);
}

/**
 * Append one event. The whole line is one `write` on a descriptor opened with
 * `O_APPEND`, so a crash can at worst lose this last line.
 *
 * @param {string} filePath
 * @param {string} type
 * @param {object} [data]
 * @param {object} [options]
 * @param {string} [options.at] ISO8601 timestamp (injected for tests)
 * @returns {object} the appended event
 */
export function appendEvent(filePath, type, data = {}, options = {}) {
  if (typeof type !== 'string' || type === '') throw new Error('ledger 事件 type 必须是非空字符串');
  const events = readEvents(filePath);
  const event = {
    seq: nextSeq(events),
    at: options.at ?? new Date().toISOString(),
    type,
    data: data ?? {},
  };
  const line = Buffer.from(encodeEvent(event), 'utf8');
  const fd = openSync(filePath, 'a');
  try {
    let offset = 0;
    while (offset < line.length) offset += writeSync(fd, line, offset, line.length - offset);
  } finally {
    closeSync(fd);
  }
  return event;
}

/**
 * Query events.
 * @param {object[]} events folded ledger
 * @param {object} [filter]
 * @param {string[]|string} [filter.type]
 * @param {number} [filter.since_seq]
 * @param {number} [filter.limit]
 */
export function queryEvents(events, filter = {}) {
  const types = filter.type === undefined ? null : new Set(Array.isArray(filter.type) ? filter.type : [filter.type]);
  let result = Array.isArray(events) ? events : [];
  if (types !== null) result = result.filter((event) => types.has(event.type));
  if (Number.isInteger(filter.since_seq)) result = result.filter((event) => event.seq >= filter.since_seq);
  if (Number.isInteger(filter.limit) && filter.limit >= 0) result = result.slice(-filter.limit);
  return result;
}

/** Reduce the ledger to the interview state bits the tools need. */
export function foldInterview(events) {
  const answered = queryEvents(events, { type: 'interview.answered' });
  const scored = queryEvents(events, { type: 'interview.scored' });
  const fromAnswered = answered
    .map((event) => event.data?.score)
    .filter((score) => score !== null && typeof score === 'object');
  const latestScore =
    scored.length > 0
      ? scored[scored.length - 1].data
      : fromAnswered.length > 0
        ? fromAnswered[fromAnswered.length - 1]
        : null;
  return {
    answered_rounds: answered.length,
    last_scored: latestScore,
  };
}
