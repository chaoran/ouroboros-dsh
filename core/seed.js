/**
 * Seed schema: validation, (de)serialization, `semantic_ac_key`, and the nine
 * Seed gates. Pure functions only — file IO belongs to tools/.
 *
 * Source of truth: docs/design.md §4.1 and §7.
 */
import { createHash } from 'node:crypto';
import { READY_MIN_ANSWERED_ROUNDS, READY_STREAK, READY_TOTAL_MAX, TASK_TYPES } from './constants.js';

const SEED_ID_RE = /^seed_[0-9a-f]{12}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/** Fresh Seed identity. Deterministic helper used by tools with an injected RNG. */
export function makeSeedId(randomBytes) {
  const bytes = randomBytes ?? globalThis.crypto.getRandomValues(new Uint8Array(6));
  return `seed_${Buffer.from(bytes).toString('hex').slice(0, 12)}`;
}

/** Fresh pseudo-identity for an interview session. */
export function makeInterviewId(randomBytes) {
  const bytes = randomBytes ?? globalThis.crypto.getRandomValues(new Uint8Array(8));
  return `interview_${Buffer.from(bytes).toString('hex').slice(0, 16)}`;
}

/** Stable JSON with a fixed key order — the exact payload `semantic_ac_key` hashes. */
export function successContractJson(ac) {
  return JSON.stringify({
    description: ac.description,
    verify_command: ac.verify_command ?? null,
    expected_artifacts: Array.isArray(ac.expected_artifacts) ? ac.expected_artifacts : [],
    output_assertion: ac.output_assertion ?? null,
  });
}

/**
 * `ac_` + first 16 hex chars of sha256 over the success contract.
 * Position in the array and metadata are deliberately excluded.
 */
export function semanticAcKey(ac) {
  const digest = createHash('sha256').update(successContractJson(ac), 'utf8').digest('hex');
  return `ac_${digest.slice(0, 16)}`;
}

/** A canonical Seed with every optional field present and every key derived. */
export function freezeSeed(seed) {
  const acs = Array.isArray(seed?.acceptance_criteria) ? seed.acceptance_criteria : [];
  return {
    goal: seed?.goal,
    task_type: seed?.task_type,
    constraints: Array.isArray(seed?.constraints) ? [...seed.constraints] : [],
    acceptance_criteria: acs.map((ac) => ({
      description: ac?.description,
      semantic_ac_key: semanticAcKey(ac ?? {}),
      verify_command: ac?.verify_command ?? null,
      expected_artifacts: Array.isArray(ac?.expected_artifacts) ? [...ac.expected_artifacts] : [],
      output_assertion: ac?.output_assertion ?? null,
      verify_exemption_reason: ac?.verify_exemption_reason ?? null,
    })),
    ontology_schema: {
      name: seed?.ontology_schema?.name,
      description: seed?.ontology_schema?.description,
      fields: (Array.isArray(seed?.ontology_schema?.fields) ? seed.ontology_schema.fields : []).map(
        (field) => ({
          name: field?.name,
          field_type: field?.field_type,
          description: field?.description,
          required: field?.required === true,
        }),
      ),
    },
    evaluation_principles: (Array.isArray(seed?.evaluation_principles)
      ? seed.evaluation_principles
      : []
    ).map((principle) => ({
      name: principle?.name,
      description: principle?.description,
      weight: principle?.weight,
    })),
    exit_conditions: (Array.isArray(seed?.exit_conditions) ? seed.exit_conditions : []).map(
      (condition) => ({
        name: condition?.name,
        description: condition?.description,
        evaluation_criteria: condition?.evaluation_criteria,
      }),
    ),
    metadata: {
      seed_id: seed?.metadata?.seed_id,
      version: seed?.metadata?.version ?? '1.0.0',
      created_at: seed?.metadata?.created_at,
      ambiguity_score: seed?.metadata?.ambiguity_score ?? 0,
      gate_forced: seed?.metadata?.gate_forced === true,
      interview_id: seed?.metadata?.interview_id,
      decision_provenance: {
        user_confirmed: seed?.metadata?.decision_provenance?.user_confirmed ?? 0,
        model_inferred: seed?.metadata?.decision_provenance?.model_inferred ?? 0,
        maintainer_policy: seed?.metadata?.decision_provenance?.maintainer_policy ?? 0,
      },
    },
  };
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isNullableString(value) {
  return value === null || value === undefined || typeof value === 'string';
}

function isRelativeWorkspacePath(value) {
  if (!isNonEmptyString(value)) return false;
  if (value.startsWith('/') || value.startsWith('\\')) return false;
  if (/^[A-Za-z]:[\\/]/.test(value)) return false;
  return !value.split(/[\\/]/).includes('..');
}

/**
 * Validate a Seed against the frozen schema. Returns every violation; the
 * caller refuses to write when the list is non-empty.
 * @param {unknown} seed
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateSeed(seed) {
  const errors = [];
  const fail = (message) => errors.push(message);

  if (seed === null || typeof seed !== 'object' || Array.isArray(seed)) {
    return { ok: false, errors: ['Seed 必须是一个对象'] };
  }

  if (!isNonEmptyString(seed.goal)) fail('goal 必须是非空字符串');
  if (!TASK_TYPES.includes(seed.task_type)) {
    fail(`task_type 必须是 ${TASK_TYPES.join(' | ')} 之一`);
  }

  if (!Array.isArray(seed.constraints)) fail('constraints 必须是数组');
  else if (seed.constraints.some((entry) => !isNonEmptyString(entry))) {
    fail('constraints 的每一项必须是非空字符串');
  }

  if (!Array.isArray(seed.acceptance_criteria) || seed.acceptance_criteria.length === 0) {
    fail('acceptance_criteria 必须是非空数组');
  } else {
    seed.acceptance_criteria.forEach((ac, index) => {
      const at = `acceptance_criteria[${index}]`;
      if (ac === null || typeof ac !== 'object') {
        fail(`${at} 必须是对象`);
        return;
      }
      if (!isNonEmptyString(ac.description)) fail(`${at}.description 必须是非空字符串`);
      if (!isNullableString(ac.verify_command)) fail(`${at}.verify_command 必须是字符串或 null`);
      if (!isNullableString(ac.output_assertion)) {
        fail(`${at}.output_assertion 必须是字符串或 null`);
      }
      if (!isNullableString(ac.verify_exemption_reason)) {
        fail(`${at}.verify_exemption_reason 必须是字符串或 null`);
      }
      if (!Array.isArray(ac.expected_artifacts)) {
        fail(`${at}.expected_artifacts 必须是数组`);
      } else if (!ac.expected_artifacts.every(isRelativeWorkspacePath)) {
        fail(`${at}.expected_artifacts 必须是 workspace 相对路径`);
      }
      if (isNonEmptyString(ac.output_assertion) && !isNonEmptyString(ac.verify_command)) {
        fail(`${at}: output_assertion 非空时 verify_command 必须非空`);
      }
      if (ac.semantic_ac_key !== undefined) {
        const derived = semanticAcKey(ac);
        if (ac.semantic_ac_key !== derived) {
          fail(`${at}.semantic_ac_key 与成功契约不一致（应为 ${derived}）`);
        }
      }
    });
  }

  const ontology = seed.ontology_schema;
  if (ontology === null || typeof ontology !== 'object') {
    fail('ontology_schema 必须是对象');
  } else {
    if (!isNonEmptyString(ontology.name)) fail('ontology_schema.name 必须是非空字符串');
    if (typeof ontology.description !== 'string') {
      fail('ontology_schema.description 必须是字符串');
    }
    if (!Array.isArray(ontology.fields)) fail('ontology_schema.fields 必须是数组');
    else {
      ontology.fields.forEach((field, index) => {
        const at = `ontology_schema.fields[${index}]`;
        if (!isNonEmptyString(field?.name)) fail(`${at}.name 必须是非空字符串`);
        if (!isNonEmptyString(field?.field_type)) fail(`${at}.field_type 必须是非空字符串`);
        if (typeof field?.description !== 'string') fail(`${at}.description 必须是字符串`);
        if (typeof field?.required !== 'boolean') fail(`${at}.required 必须是布尔值`);
      });
    }
  }

  if (!Array.isArray(seed.evaluation_principles)) {
    fail('evaluation_principles 必须是数组');
  } else {
    seed.evaluation_principles.forEach((principle, index) => {
      const at = `evaluation_principles[${index}]`;
      if (!isNonEmptyString(principle?.name)) fail(`${at}.name 必须是非空字符串`);
      if (typeof principle?.description !== 'string') fail(`${at}.description 必须是字符串`);
      if (typeof principle?.weight !== 'number' || !Number.isFinite(principle.weight)) {
        fail(`${at}.weight 必须是有限数值`);
      }
    });
  }

  if (!Array.isArray(seed.exit_conditions)) {
    fail('exit_conditions 必须是数组');
  } else {
    seed.exit_conditions.forEach((condition, index) => {
      const at = `exit_conditions[${index}]`;
      if (!isNonEmptyString(condition?.name)) fail(`${at}.name 必须是非空字符串`);
      if (typeof condition?.description !== 'string') fail(`${at}.description 必须是字符串`);
      if (!isNonEmptyString(condition?.evaluation_criteria)) {
        fail(`${at}.evaluation_criteria 必须是非空字符串`);
      }
    });
  }

  const metadata = seed.metadata;
  if (metadata === null || typeof metadata !== 'object') {
    fail('metadata 必须是对象');
  } else {
    if (!SEED_ID_RE.test(String(metadata.seed_id))) fail('metadata.seed_id 必须形如 seed_<12hex>');
    if (!isNonEmptyString(metadata.version)) fail('metadata.version 必须是非空字符串');
    if (!ISO_RE.test(String(metadata.created_at))) {
      fail('metadata.created_at 必须是 ISO8601 时间');
    }
    if (
      typeof metadata.ambiguity_score !== 'number' ||
      !Number.isFinite(metadata.ambiguity_score) ||
      metadata.ambiguity_score < 0 ||
      metadata.ambiguity_score > 1
    ) {
      fail('metadata.ambiguity_score 必须是 0..1 的数值');
    }
    if (typeof metadata.gate_forced !== 'boolean') fail('metadata.gate_forced 必须是布尔值');
    if (!isNonEmptyString(metadata.interview_id)) fail('metadata.interview_id 必须是非空字符串');
    const provenance = metadata.decision_provenance;
    if (provenance === null || typeof provenance !== 'object') {
      fail('metadata.decision_provenance 必须是对象');
    } else {
      for (const key of ['user_confirmed', 'model_inferred', 'maintainer_policy']) {
        if (!Number.isInteger(provenance[key]) || provenance[key] < 0) {
          fail(`metadata.decision_provenance.${key} 必须是非负整数`);
        }
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

/** Parse a Seed JSON document. */
export function parseSeed(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return { ok: false, errors: [`Seed 不是合法 JSON：${error.message}`] };
  }
  return validateSeed(value);
}

/** Canonical serialization: fixed key order, two-space indent, trailing newline. */
export function serializeSeed(seed) {
  return `${JSON.stringify(freezeSeed(seed), null, 2)}\n`;
}

/** Content hash used by `seed.lock.json` (the lock never carries the body). */
export function hashSeed(seed) {
  return `sha256:${createHash('sha256')
    .update(JSON.stringify(freezeSeed(seed)), 'utf8')
    .digest('hex')}`;
}

function gate(name, passed, detail) {
  return { name, passed: passed === true, detail: detail ?? null };
}

/**
 * The nine Seed gates (design §7 + upstream authoring gate order).
 *
 * `force=true` bypasses gates 1-4 and records the bypass as gate 9; the real
 * ambiguity score is still written to metadata (`gate_forced: true`).
 *
 * @param {object} input
 * @param {number} input.answered_rounds
 * @param {number} input.ambiguity_total
 * @param {object} input.floors  per-dimension `{ met }` result from core/ambiguity
 * @param {number} input.streak
 * @param {boolean} input.closure_audit_passed
 * @param {object} input.seed     the candidate Seed (already frozen)
 * @param {boolean} input.restate_approved
 * @param {boolean} input.client_gate
 * @param {boolean} input.force
 * @returns {{ gates: Array<{name: string, passed: boolean, detail: string|null}>, passed: boolean }}
 */
export function seedGates(input) {
  const {
    answered_rounds = 0,
    ambiguity_total = 1,
    floors = {},
    streak = 0,
    closure_audit_passed = false,
    seed = null,
    restate_approved = false,
    client_gate = false,
    force = false,
  } = input;
  const bypass = force === true;

  const floorFailures = Object.entries(floors)
    .filter(([, entry]) => entry && entry.met === false)
    .map(([dimension]) => dimension);

  const acs = Array.isArray(seed?.acceptance_criteria) ? seed.acceptance_criteria : [];
  const unverifiable = acs
    .map((ac, index) => ({ index, ac }))
    .filter(({ ac }) => !isNonEmptyString(ac?.verify_command) && !isNonEmptyString(ac?.verify_exemption_reason))
    .map(({ index }) => index);

  const gates = [
    gate(
      'answered_rounds',
      bypass || answered_rounds >= READY_MIN_ANSWERED_ROUNDS,
      bypass
        ? `force 绕过；${answered_rounds} 轮已答（通常要求 ≥${READY_MIN_ANSWERED_ROUNDS}）`
        : `${answered_rounds} 轮已答（要求 ≥${READY_MIN_ANSWERED_ROUNDS}）`,
    ),
    gate(
      'ambiguity_threshold',
      bypass || ambiguity_total <= READY_TOTAL_MAX,
      bypass
        ? `force 绕过；真实分数 ${ambiguity_total}`
        : `总分 ${ambiguity_total}（要求 ≤${READY_TOTAL_MAX}）`,
    ),
    gate(
      'clarity_floors',
      bypass || floorFailures.length === 0,
      bypass
        ? `force 绕过；未达下限的维度：${floorFailures.join(', ') || '无'}`
        : `未达下限的维度：${floorFailures.join(', ') || '无'}`,
    ),
    gate(
      'ready_streak',
      bypass || streak >= READY_STREAK,
      bypass ? `force 绕过；streak=${streak}` : `连续就绪候选 ${streak} 次（要求 ≥${READY_STREAK}）`,
    ),
    gate(
      'requirement_distillation',
      closure_audit_passed === true,
      closure_audit_passed === true ? 'closure 审计通过' : 'closure 审计未通过或未运行',
    ),
    gate(
      'ac_success_contract',
      unverifiable.length === 0,
      unverifiable.length === 0
        ? '每条 AC 都有 verify_command 或 verify_exemption_reason'
        : `缺成功契约的 AC 下标：${unverifiable.join(', ')}`,
    ),
    gate(
      'restate_approved',
      restate_approved === true,
      restate_approved === true ? '用户已显式批准 restate' : '缺少 restate + 显式批准',
    ),
    gate(
      'client_acceptance_gate',
      client_gate === true,
      client_gate === true ? '客户端就绪确认已通过' : '缺少 seed_ready_acceptance_guard 确认',
    ),
    gate(
      'explicit_force',
      true,
      bypass ? 'force=true 已记录（真实分数照录，gate_forced=true）' : '未使用 force',
    ),
  ];

  return { gates, passed: gates.every((entry) => entry.passed) };
}
