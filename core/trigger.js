/**
 * Stage2 -> Stage3 trigger matrix.
 *
 * Priority (first hit wins, later rows are never reported):
 *   manual > seed 修改 > ontology 演化 > goal 重解释
 *          > drift > 0.3 > uncertainty > 0.3 > lateral 采纳
 *
 * Both 0.3 comparisons are STRICT (`>`), matching the spec.
 * Source of truth: docs/design.md §7 (Stage3 触发).
 */
import { TRIGGER_DRIFT, TRIGGER_UNCERTAINTY } from './constants.js';

/** Ordered trigger names, highest priority first. */
export const TRIGGER_ORDER = Object.freeze([
  'manual',
  'seed_modified',
  'ontology_evolved',
  'goal_reinterpreted',
  'drift',
  'uncertainty',
  'lateral_adopted',
]);

/**
 * @param {object} input
 * @param {boolean} [input.manual]
 * @param {boolean} [input.seed_modified]
 * @param {boolean} [input.ontology_evolved]
 * @param {boolean} [input.goal_reinterpreted]
 * @param {number} [input.drift_score]
 * @param {number} [input.uncertainty]
 * @param {boolean} [input.lateral_adopted]
 * @returns {{ triggered: boolean, trigger: string|null, detail: string|null }}
 */
export function stage3Trigger(input = {}) {
  const checks = [
    ['manual', input.manual === true, 'manual 请求'],
    ['seed_modified', input.seed_modified === true, 'Seed 被修改'],
    ['ontology_evolved', input.ontology_evolved === true, 'ontology 演化'],
    ['goal_reinterpreted', input.goal_reinterpreted === true, 'goal 被重新解释'],
    [
      'drift',
      typeof input.drift_score === 'number' && input.drift_score > TRIGGER_DRIFT,
      `drift_score ${input.drift_score} > ${TRIGGER_DRIFT}`,
    ],
    [
      'uncertainty',
      typeof input.uncertainty === 'number' && input.uncertainty > TRIGGER_UNCERTAINTY,
      `uncertainty ${input.uncertainty} > ${TRIGGER_UNCERTAINTY}`,
    ],
    ['lateral_adopted', input.lateral_adopted === true, 'lateral 建议被采纳'],
  ];

  for (const [name, hit, detail] of checks) {
    if (hit) return { triggered: true, trigger: name, detail };
  }
  return { triggered: false, trigger: null, detail: null };
}

/**
 * Derive trigger inputs from a Stage-2 review object.
 * `seed_modified` / `ontology_evolved` / `goal_reinterpreted` are caller flags
 * (the review may raise them explicitly, e.g. `stage2.flags`).
 */
export function triggerFromStage2(stage2 = {}, flags = {}) {
  return stage3Trigger({
    manual: flags.manual === true,
    seed_modified: flags.seed_modified === true,
    ontology_evolved: flags.ontology_evolved === true,
    goal_reinterpreted: flags.goal_reinterpreted === true,
    drift_score: stage2?.drift_score,
    uncertainty: stage2?.uncertainty,
    lateral_adopted: flags.lateral_adopted === true,
  });
}
