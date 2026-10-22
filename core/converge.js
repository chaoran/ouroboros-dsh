/**
 * Evolution convergence: similarity, block gates, stall / oscillation /
 * plateau / generation cap.
 *
 * Source of truth: docs/design.md §7 (相似度 / 收敛 / 提前收敛 / 停滞 / 振荡 /
 * 平台期 / 代数 / 回归).
 */
import {
  BLOCK_SCORE_MIN,
  CONVERGE_SIMILARITY,
  MIN_GENERATIONS,
  OSCILLATION_EPSILON,
  PLATEAU_SCORE_DELTA,
  PLATEAU_WINDOW,
  SIMILARITY_WEIGHTS,
  STALL_GENERATIONS,
} from './constants.js';

function round4(value) {
  return Math.round((value + Number.EPSILON) * 1e4) / 1e4;
}

/**
 * Similarity between two field/AC lists:
 *   0.5 × name overlap + 0.3 × type match + 0.2 × exact match,
 * every denominator |old ∪ new|. An empty union is fully similar (1.0).
 *
 * @param {Array<{name: string, field_type?: string, description?: string}>} oldItems
 * @param {Array<{name: string, field_type?: string, description?: string}>} newItems
 * @returns {number} similarity in 0..1
 */
export function similarity(oldItems, newItems) {
  const toMap = (items) => {
    const map = new Map();
    for (const item of Array.isArray(items) ? items : []) {
      if (item && typeof item.name === 'string') map.set(item.name, item);
    }
    return map;
  };
  const oldMap = toMap(oldItems);
  const newMap = toMap(newItems);
  const union = new Set([...oldMap.keys(), ...newMap.keys()]);
  if (union.size === 0) return 1;

  let common = 0;
  let typeMatches = 0;
  let exactMatches = 0;
  for (const [name, oldItem] of oldMap) {
    const newItem = newMap.get(name);
    if (newItem === undefined) continue;
    common += 1;
    if (oldItem.field_type === newItem.field_type) typeMatches += 1;
    if (
      oldItem.field_type === newItem.field_type &&
      oldItem.description === newItem.description
    ) {
      exactMatches += 1;
    }
  }

  const denominator = union.size;
  const nameScore = common / denominator;
  const typeScore = typeMatches / denominator;
  const exactScore = exactMatches / denominator;
  return round4(
    SIMILARITY_WEIGHTS.name * nameScore +
      SIMILARITY_WEIGHTS.type * typeScore +
      SIMILARITY_WEIGHTS.exact * exactScore,
  );
}

/** Similarity of two Seeds, measured on their ontology fields (upstream shape). */
export function seedSimilarity(oldSeed, newSeed) {
  return similarity(
    oldSeed?.ontology_schema?.fields,
    newSeed?.ontology_schema?.fields,
  );
}

/** Stable identity of one AC for cross-generation comparison. */
export function acIdentity(ac) {
  if (typeof ac?.semantic_ac_key === 'string' && ac.semantic_ac_key !== '') {
    return ac.semantic_ac_key;
  }
  return JSON.stringify(ac ?? null);
}

/**
 * Seed-level AC coverage: every Seed AC must appear in the per-AC result set,
 * as either an authoritative pass or an unresolved failure.
 * @param {object} seed
 * @param {Array<{ac_index: number, authoritative_pass?: boolean, unresolved?: boolean}>} acResults
 */
export function acCoverage(seed, acResults) {
  const acs = Array.isArray(seed?.acceptance_criteria) ? seed.acceptance_criteria : [];
  const byIndex = new Map();
  for (const result of Array.isArray(acResults) ? acResults : []) {
    if (Number.isInteger(result?.ac_index)) byIndex.set(result.ac_index, result);
  }
  const missing = [];
  for (let index = 0; index < acs.length; index += 1) {
    const result = byIndex.get(index);
    if (result === undefined || (result.authoritative_pass !== true && result.unresolved !== true)) {
      missing.push(index);
    }
  }
  return {
    complete: acs.length > 0 && missing.length === 0,
    missing,
    reason:
      acs.length === 0
        ? 'Seed 没有 AC'
        : missing.length === 0
          ? 'ok'
          : `以下 AC 没有可判定的结果：${missing.join(', ')}`,
  };
}

/** Whether every Seed AC has an authoritative pass this generation. */
export function perAcAuthority(seed, acResults) {
  const acs = Array.isArray(seed?.acceptance_criteria) ? seed.acceptance_criteria : [];
  const passed = new Set(
    (Array.isArray(acResults) ? acResults : [])
      .filter((result) => result?.authoritative_pass === true)
      .map((result) => result.ac_index),
  );
  return acs.length > 0 && acs.every((_, index) => passed.has(index));
}

/** Names of the six block gates. All must clear before convergence counts. */
export const BLOCK_GATE_NAMES = Object.freeze([
  'evaluation_approved',
  'seed_ac_coverage',
  'per_ac_authority',
  'score_threshold',
  'no_regression',
  'validation_passed',
]);

/**
 * Evaluate the block gates.
 * @param {object} state
 * @param {boolean} [state.evaluated]
 * @param {string} [state.verdict] approved | rejected | unverified
 * @param {boolean} [state.ac_coverage_complete]
 * @param {boolean} [state.per_ac_authority]
 * @param {number} [state.score]
 * @param {boolean} [state.regression]
 * @param {boolean} [state.validation_passed]
 * @returns {{ blockers: string[], blocks: Record<string, boolean>, all_clear: boolean }}
 */
export function blockGates(state = {}) {
  const blocks = {
    evaluation_approved: state.evaluated === true && state.verdict === 'approved',
    seed_ac_coverage: state.ac_coverage_complete === true,
    per_ac_authority: state.per_ac_authority === true,
    score_threshold:
      typeof state.score === 'number' && Number.isFinite(state.score) && state.score >= BLOCK_SCORE_MIN,
    no_regression: state.regression === false,
    validation_passed: state.validation_passed === true,
  };
  const blockers = BLOCK_GATE_NAMES.filter((name) => blocks[name] !== true);
  return { blocks, blockers, all_clear: blockers.length === 0 };
}

/** Similarity >= 0.95 for three consecutive generations. */
export function isStalled(history) {
  const list = Array.isArray(history) ? history : [];
  if (list.length < STALL_GENERATIONS) return false;
  return list
    .slice(-STALL_GENERATIONS)
    .every((entry) => typeof entry?.similarity === 'number' && entry.similarity >= CONVERGE_SIMILARITY);
}

/** Generation N is about generation N-2 (similarity and score both within epsilon). */
export function isOscillating(history) {
  const list = Array.isArray(history) ? history : [];
  if (list.length < 3) return false;
  const latest = list[list.length - 1];
  const before = list[list.length - 3];
  const similarityDelta = Math.abs((latest?.similarity ?? 0) - (before?.similarity ?? 0));
  const scoreDelta = Math.abs((latest?.score ?? 1) - (before?.score ?? 1));
  return similarityDelta < OSCILLATION_EPSILON && scoreDelta < OSCILLATION_EPSILON;
}

/** The last 3 generations are not approved and adjacent score deltas < 0.01. */
export function isPlateau(history) {
  const list = Array.isArray(history) ? history : [];
  if (list.length < PLATEAU_WINDOW) return false;
  const window = list.slice(-PLATEAU_WINDOW);
  if (window.some((entry) => entry?.approved === true)) return false;
  if (window.some((entry) => entry?.evaluated !== true)) return false;
  for (let index = 1; index < window.length; index += 1) {
    const delta = Math.abs((window[index]?.score ?? 0) - (window[index - 1]?.score ?? 0));
    if (!(delta < PLATEAU_SCORE_DELTA)) return false;
  }
  return true;
}

/**
 * Decide whether to stop the evolution loop after a generation.
 *
 * @param {object} input
 * @param {Array<{similarity: number, score: number, approved: boolean, evaluated: boolean}>} input.history
 * @param {number} input.generation 1-based current generation
 * @param {object} input.blocks     block-gate state (see {@link blockGates})
 * @param {number} [input.minGenerations]
 * @param {number} [input.maxGenerations]
 * @returns {{
 *   stop: boolean, reason: string|null, converged: boolean, similarity: number,
 *   blockers: string[], blocks: Record<string, boolean>
 * }}
 */
export function stopReason(input = {}) {
  const history = Array.isArray(input.history) ? input.history : [];
  const generation = Number.isInteger(input.generation) ? input.generation : history.length;
  const minGenerations = Number.isInteger(input.minGenerations) ? input.minGenerations : MIN_GENERATIONS;
  const maxGenerations = Number.isInteger(input.maxGenerations) ? input.maxGenerations : 30;
  const latest = history[history.length - 1] ?? {};
  const similarityValue = typeof latest.similarity === 'number' ? latest.similarity : 0;
  const gateState = blockGates(input.blocks ?? {});
  const converged = similarityValue >= CONVERGE_SIMILARITY && gateState.all_clear;

  const base = {
    converged,
    similarity: similarityValue,
    blockers: gateState.blockers,
    blocks: gateState.blocks,
  };

  if (converged) {
    return {
      ...base,
      stop: true,
      reason: generation < minGenerations ? 'early_converged' : 'converged',
    };
  }
  if (isOscillating(history)) return { ...base, stop: true, reason: 'oscillating' };
  if (isPlateau(history)) return { ...base, stop: true, reason: 'plateau' };
  if (isStalled(history)) return { ...base, stop: true, reason: 'stalled' };
  if (generation >= maxGenerations) return { ...base, stop: true, reason: 'max_generations' };
  return { ...base, stop: false, reason: null };
}
