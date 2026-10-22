/**
 * Stage-3 voting: tally and reviewer-independence labelling.
 *
 * Approval needs approve/valid >= 0.66 AND at least 2 valid votes; fewer valid
 * votes is an error, not a rejection to be smoothed over.
 * Source of truth: docs/design.md §7 (Stage3 通过) and §4.2.
 */
import { STAGE3_APPROVAL_RATIO, STAGE3_MIN_VOTES } from './constants.js';

/** Normalize the two accepted vote spellings into `true | false | null`. */
export function voteValue(vote) {
  if (vote === true || vote?.approved === true || vote?.vote === 'approve' || vote?.vote === 'approved') {
    return true;
  }
  if (vote === false || vote?.approved === false || vote?.vote === 'reject' || vote?.vote === 'rejected') {
    return false;
  }
  return null;
}

/**
 * @param {Array<{approved?: boolean, vote?: string, reviewer_id?: string, valid?: boolean}>} votes
 * @returns {{
 *   ok: boolean, approved: boolean, valid_votes: number, total_votes: number,
 *   approve_votes: number, reject_votes: number, majority_ratio: number,
 *   reviewer_independence: string, error: string|null
 * }}
 */
export function tally(votes) {
  const list = Array.isArray(votes) ? votes : [];
  const valid = list.filter((vote) => vote?.valid !== false && voteValue(vote) !== null);
  const approveVotes = valid.filter((vote) => voteValue(vote) === true).length;
  const rejectVotes = valid.length - approveVotes;
  const majorityRatio = valid.length === 0 ? 0 : approveVotes / valid.length;

  let error = null;
  if (valid.length < STAGE3_MIN_VOTES) {
    error = `有效票不足：${valid.length} < ${STAGE3_MIN_VOTES}`;
  }

  return {
    ok: error === null,
    approved: error === null && majorityRatio >= STAGE3_APPROVAL_RATIO,
    valid_votes: valid.length,
    total_votes: list.length,
    approve_votes: approveVotes,
    reject_votes: rejectVotes,
    majority_ratio: Math.round(majorityRatio * 1e4) / 1e4,
    reviewer_independence: independenceOf(valid),
    error,
  };
}

/**
 * Label reviewer independence: distinct reviewers are independent; duplicated
 * reviewer ids share one context; votes without ids cannot be classified.
 * @param {Array<{reviewer_id?: string}>} votes
 * @returns {'independent'|'shared-context'|'unlabeled'|'insufficient'}
 */
export function independenceOf(votes) {
  const list = Array.isArray(votes) ? votes : [];
  if (list.length < STAGE3_MIN_VOTES) return 'insufficient';
  const ids = list.map((vote) => vote?.reviewer_id).filter((id) => typeof id === 'string' && id !== '');
  if (ids.length !== list.length) return 'unlabeled';
  return new Set(ids).size === ids.length ? 'independent' : 'shared-context';
}

/** Stage-3 block for `stage3.json` / `verdict.json`. */
export function stage3Result(votes) {
  const result = tally(votes);
  return {
    approved: result.approved,
    majority_ratio: result.majority_ratio,
    votes: Array.isArray(votes) ? votes : [],
    reviewer_independence: result.reviewer_independence,
    ...(result.error === null ? {} : { error: result.error }),
  };
}
