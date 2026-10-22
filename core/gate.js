/**
 * Acceptance gate: turns Stage-1 execution evidence plus model-layer
 * withholding into one of `approved | rejected | unverified`.
 *
 * Only Stage 1 can grant approval; the model layers may only withhold.
 * Source of truth: docs/design.md §7 (验收裁决) and §4.2.
 */
import { STAGE2_REWARD_HACKING_MAX, STAGE2_SCORE_MIN } from './constants.js';

export const ACCEPTANCE_STATES = Object.freeze(['approved', 'rejected', 'unverified']);

/** Whether the Stage-1 evidence contains at least one executed check. */
export function hasExecutedEvidence(stage1) {
  return Array.isArray(stage1?.checks) && stage1.checks.some((check) => check?.executed === true);
}

/** First failed executed check, if any. */
export function firstFailedCheck(stage1) {
  const checks = Array.isArray(stage1?.checks) ? stage1.checks : [];
  return (
    checks.find((check) => check?.executed === true && check?.passed !== true) ?? null
  );
}

/**
 * Every reason the model layer withholds approval, in priority order.
 * `stage2` absent means the semantic review did not produce a parsed judge.
 * @param {object|null|undefined} stage2
 * @param {object|null|undefined} stage3
 * @returns {string[]}
 */
export function withholdingReasons(stage2, stage3) {
  const reasons = [];
  if (stage2 === null || stage2 === undefined) {
    reasons.push('Stage2 评审结果缺失或无法解析（不猜，按未验证处理）');
  } else {
    if (stage2.ac_compliance === false) {
      reasons.push('Stage2: AC 合规性检查未通过（ac_compliance=false）');
    }
    if (typeof stage2.score === 'number' && stage2.score < STAGE2_SCORE_MIN) {
      reasons.push(`Stage2: 语义评分 ${stage2.score} < ${STAGE2_SCORE_MIN}`);
    }
    if (
      typeof stage2.reward_hacking_risk === 'number' &&
      stage2.reward_hacking_risk >= STAGE2_REWARD_HACKING_MAX
    ) {
      reasons.push(
        `Stage2: reward_hacking_risk ${stage2.reward_hacking_risk} ≥ ${STAGE2_REWARD_HACKING_MAX}`,
      );
    }
  }
  if (stage3 !== undefined && stage3 !== null) {
    if (stage3.error) {
      reasons.push(`Stage3: ${stage3.error}`);
    } else if (stage3.approved !== true) {
      const ratio = typeof stage3.majority_ratio === 'number' ? stage3.majority_ratio : 0;
      reasons.push(`Stage3: 共识未通过（赞成比例 ${ratio}）`);
    }
  }
  return reasons;
}

/**
 * Decide the acceptance state.
 *
 * Rule (design §7):
 *   no executed Stage-1 evidence            -> unverified
 *   an executed check failed                -> rejected
 *   Stage 2 missing/unparsable              -> unverified  (never approve on a guess)
 *   any model-layer withholding             -> rejected
 *   otherwise                               -> approved
 *
 * @param {object} input
 * @param {object} input.stage1 `{ checks: [...] }`
 * @param {object|null} [input.stage2]
 * @param {object|null} [input.stage3]
 * @returns {{ acceptance_state: string, failure_reason: string|null, reasons: string[] }}
 */
export function decide({ stage1, stage2, stage3 = null } = {}) {
  const executed = hasExecutedEvidence(stage1);
  if (!executed) {
    return {
      acceptance_state: 'unverified',
      failure_reason: '没有 Stage1 执行证据：mechanical.toml 缺失或没有配置任何机械检查',
      reasons: ['stage1: no executed evidence'],
    };
  }

  const failed = firstFailedCheck(stage1);
  if (failed !== null) {
    const detail =
      failed.message !== undefined && failed.message !== null && failed.message !== ''
        ? failed.message
        : `${failed.check_type} 退出码 ${failed.exit_code}`;
    return {
      acceptance_state: 'rejected',
      failure_reason: detail,
      reasons: [`stage1:${failed.check_type}`],
    };
  }

  const modelReasons = withholdingReasons(stage2, stage3);
  if (modelReasons.length > 0) {
    const unparsed = stage2 === null || stage2 === undefined;
    return {
      acceptance_state: unparsed ? 'unverified' : 'rejected',
      failure_reason: modelReasons[0],
      reasons: modelReasons,
    };
  }

  return { acceptance_state: 'approved', failure_reason: null, reasons: [] };
}

/** Whether the model layer withholds (used by evolve/run bookkeeping). */
export function modelWithholds(stage2, stage3 = null) {
  return withholdingReasons(stage2, stage3).length > 0;
}
