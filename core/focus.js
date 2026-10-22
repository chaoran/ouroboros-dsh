/**
 * Evolution focus: the frozen/active AC set algebra and lineage rewind.
 *
 * Scoping is fail-closed: without per-AC evidence, or when no AC is named as
 * the failure target, every AC stays active.
 *
 * Source of truth: docs/design.md §7 (focus 集合代数), upstream
 * `evolution/focus.py` semantics.
 */

function sameAc(left, right) {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

/**
 * Select the smallest evidence-backed working set for the next generation.
 *
 * @param {object} input
 * @param {Array<object>} input.parentAcs previous generation's ACs
 * @param {Array<object>} input.candidateAcs next generation's ACs
 * @param {Array<{ac_index: number, authoritative_pass?: boolean, unresolved?: boolean}>} [input.acResults]
 * @param {number[]} [input.challengedIndices] AC indices challenged by `wonder`
 * @param {number[]} [input.regressedIndices] AC indices that regressed
 * @param {boolean} [input.enabled=true]
 * @returns {{ active: number[], frozen: number[], reason: string }}
 */
export function selectFocus(input = {}) {
  const parentAcs = Array.isArray(input.parentAcs) ? input.parentAcs : [];
  const candidateAcs = Array.isArray(input.candidateAcs) ? input.candidateAcs : [];
  const allCandidate = candidateAcs.map((_, index) => index);
  const full = (reason) => ({ active: allCandidate, frozen: [], reason });

  if (input.enabled === false) return full('full generation: focus disabled');
  const acResults = Array.isArray(input.acResults) ? input.acResults : [];
  if (acResults.length === 0) {
    return full('full generation: no per-AC PASS evidence available');
  }

  const byIndex = new Map();
  for (const result of acResults) {
    if (Number.isInteger(result?.ac_index)) byIndex.set(result.ac_index, result);
  }
  const uncovered = allCandidate.filter((index) => {
    const result = byIndex.get(index);
    return result === undefined || (result.authoritative_pass !== true && result.unresolved !== true);
  });
  if (uncovered.length > 0) {
    return full(`full generation: AC 覆盖不完整（缺 ${uncovered.join(', ')}）`);
  }

  const passed = new Set(
    acResults
      .filter(
        (result) =>
          result?.authoritative_pass === true &&
          result.ac_index >= 0 &&
          result.ac_index < parentAcs.length,
      )
      .map((result) => result.ac_index),
  );
  const failed = new Set(
    acResults
      .filter(
        (result) =>
          result?.unresolved === true && result.ac_index >= 0 && result.ac_index < parentAcs.length,
      )
      .map((result) => result.ac_index),
  );
  if (failed.size === 0) {
    return full('full generation: aggregate gate has no failed AC target');
  }

  const challenged = new Set(input.challengedIndices ?? []);
  const regressed = new Set(input.regressedIndices ?? []);
  const changed = new Set();
  const compareLength = Math.min(parentAcs.length, candidateAcs.length);
  for (let index = 0; index < compareLength; index += 1) {
    if (!sameAc(parentAcs[index], candidateAcs[index])) changed.add(index);
  }
  const added = new Set();
  for (let index = parentAcs.length; index < candidateAcs.length; index += 1) {
    added.add(index);
  }

  const reopened = new Set([...challenged, ...regressed, ...changed, ...added]);
  const frozen = [...passed].filter((index) => !reopened.has(index) && allCandidate.includes(index)).sort((a, b) => a - b);
  const frozenSet = new Set(frozen);
  const active = allCandidate.filter((index) => !frozenSet.has(index));

  return {
    active,
    frozen,
    reason: `focused generation: ${active.length} active / ${frozen.length} frozen from prior per-AC gate`,
  };
}

/**
 * Rewind the lineage projection: keep records up to and including `generation`.
 * Events are never deleted — only the projection is truncated.
 *
 * @param {Array<{generation: number}>} records
 * @param {number} generation
 * @returns {Array<object>}
 */
export function rewindProjection(records, generation) {
  const list = Array.isArray(records) ? records : [];
  return list.filter((record) => Number.isInteger(record?.generation) && record.generation <= generation);
}
