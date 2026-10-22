/**
 * Interview ambiguity arithmetic: score, four-dimension floors, consecutive
 * ready-candidate streak, the 0.21 unanswered pin, milestones, readiness.
 *
 * Pure functions only. LLM output (a clarity component and question wording)
 * may influence the *inputs*; every decision below is code-owned.
 *
 * Source of truth: docs/design.md §7.
 */
import {
  AMBIGUITY_WEIGHTS,
  DIMENSIONS,
  INTERVIEW_MODES,
  MILESTONES,
  READY_FLOORS,
  READY_MIN_ANSWERED_ROUNDS,
  READY_STREAK,
  READY_TOTAL_MAX,
  UNANSWERED_PIN,
} from './constants.js';

/** Round to 4 decimal places (the spec's `round(x, 4)`). */
export function round4(value) {
  return Math.round((value + Number.EPSILON) * 1e4) / 1e4;
}

function clampUnit(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/** Normalize caller-supplied clarity values to the declared dimensions. */
export function normalizeClarity(mode, clarity = {}) {
  const dimensions = DIMENSIONS[mode] ?? DIMENSIONS.greenfield;
  const normalized = {};
  for (const dimension of dimensions) normalized[dimension] = clampUnit(clarity[dimension]);
  return normalized;
}

/**
 * total = round(1 - Σ(clarity × weight), 4)
 * @param {string} mode greenfield | brownfield
 * @param {object} clarity per-dimension clarity in 0..1
 */
export function ambiguityTotal(mode, clarity) {
  const weights = AMBIGUITY_WEIGHTS[mode] ?? AMBIGUITY_WEIGHTS.greenfield;
  const dims = DIMENSIONS[mode] ?? DIMENSIONS.greenfield;
  let covered = 0;
  for (const dimension of dims) {
    covered += clampUnit(clarity?.[dimension]) * weights[dimension];
  }
  return round4(Math.max(0, Math.min(1, 1 - covered)));
}

/** Milestone name for a total. Display only. */
export function milestoneOf(total) {
  // Bands are declared with descending upper bounds; the narrowest band wins.
  for (let index = MILESTONES.length - 1; index >= 0; index -= 1) {
    if (total <= MILESTONES[index].max) return MILESTONES[index].name;
  }
  return 'initial';
}

/**
 * Per-dimension floor check for the mode's dimensions.
 * @returns {{ met: boolean, dimensions: Record<string, { clarity: number, min: number, met: boolean }> }}
 */
export function checkFloors(mode, clarity) {
  const dims = DIMENSIONS[mode] ?? DIMENSIONS.greenfield;
  const dimensions = {};
  let met = true;
  for (const dimension of dims) {
    const value = clampUnit(clarity?.[dimension]);
    const min = READY_FLOORS[dimension];
    const ok = value >= min;
    dimensions[dimension] = { clarity: value, min, met: ok };
    if (!ok) met = false;
  }
  return { met, dimensions };
}

/**
 * Evaluate one interview round.
 *
 * @param {object} input
 * @param {string} [input.mode='greenfield']
 * @param {object} input.clarity per-dimension clarity in 0..1
 * @param {number} [input.answered_rounds=0] answered rounds after this one
 * @param {boolean} [input.unanswered=false] an earlier question is still unanswered
 * @param {number} [input.streak=0] streak carried in from previous rounds
 * @returns {{
 *   total: number, clarity: object, floors: object, milestone: string,
 *   pinned: boolean, ready_candidate: boolean, streak: number, ready: boolean,
 *   unanswered: boolean, answered_rounds: number, mode: string
 * }}
 */
export function evaluateInterview(input = {}) {
  const mode = INTERVIEW_MODES.includes(input.mode) ? input.mode : 'greenfield';
  const clarity = normalizeClarity(mode, input.clarity);
  const answeredRounds = Number.isInteger(input.answered_rounds) ? input.answered_rounds : 0;
  const unanswered = input.unanswered === true;
  const carriedStreak = Number.isInteger(input.streak) && input.streak > 0 ? input.streak : 0;

  let total = ambiguityTotal(mode, clarity);
  // The unanswered pin applies from the second round on (non-first round).
  const pinned = unanswered && answeredRounds > 0;
  if (pinned) total = round4(Math.max(total, UNANSWERED_PIN));

  const floors = checkFloors(mode, clarity);
  const readyCandidate =
    total <= READY_TOTAL_MAX &&
    floors.met &&
    answeredRounds >= READY_MIN_ANSWERED_ROUNDS &&
    !unanswered;
  const streak = readyCandidate ? carriedStreak + 1 : 0;

  return {
    mode,
    total,
    clarity,
    floors: floors.dimensions,
    milestone: milestoneOf(total),
    pinned,
    ready_candidate: readyCandidate,
    streak,
    ready: readyCandidate && streak >= READY_STREAK,
    unanswered,
    answered_rounds: answeredRounds,
  };
}

/** A short human-readable summary used by tool results and the ledger. */
export function describeAmbiguity(result) {
  const floorText = Object.entries(result.floors)
    .map(([dimension, entry]) => `${dimension} ${entry.clarity.toFixed(2)}/${entry.min}`)
    .join(' · ');
  return `总分 ${result.total.toFixed(2)}（${result.milestone}）· ${floorText} · streak ${result.streak}/${READY_STREAK}`;
}

/** The next dimension to ask about: lowest clarity among the mode's dimensions. */
export function weakestDimension(mode, clarity) {
  const dims = DIMENSIONS[mode] ?? DIMENSIONS.greenfield;
  let weakest = dims[0];
  for (const dimension of dims) {
    if (clampUnit(clarity?.[dimension]) < clampUnit(clarity?.[weakest])) weakest = dimension;
  }
  return weakest;
}
