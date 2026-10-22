/**
 * `ooo_evolve` — generation loop: run -> evaluate -> reflect a candidate Seed
 * -> convergence check. Stops on convergence, stall, oscillation, plateau, or
 * the generation cap; every generation appends one lineage record with its
 * similarity and grade.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { DEFAULT_GENERATIONS, MAX_GENERATIONS, MIN_GENERATIONS } from '../core/constants.js';
import { seedSimilarity, stopReason as decideStop } from '../core/converge.js';
import { selectFocus } from '../core/focus.js';
import { freezeSeed, hashSeed, makeSeedId, serializeSeed, validateSeed } from '../core/seed.js';
import {
  OuroborosError,
  appendLedger,
  assertSafeId,
  callLlmJson,
  defineOooTool,
  ensureStateDirs,
  loadSeed,
  newId,
  nowIso,
  projectPaths,
  projectRoot,
  readJson,
  requireAgent,
  requireWritableSession,
  writeJsonAtomic,
  writeSeedLock,
} from './shared.js';
import { createEvaluateTool } from './evaluate.js';
import { createRunTool } from './run.js';

function clampGenerations(value) {
  const requested = Number.isInteger(value) ? value : DEFAULT_GENERATIONS;
  return Math.max(1, Math.min(MAX_GENERATIONS, requested));
}

function acResultsFromRun(verdict, runRecord) {
  const artifacts = Array.isArray(runRecord?.children) ? runRecord.children : [];
  return artifacts.map((child) => ({
    ac_index: child.ac_index,
    authoritative_pass: verdict.acceptance_state === 'approved' && child.stop_reason === 'completed',
    unresolved: !(verdict.acceptance_state === 'approved' && child.stop_reason === 'completed'),
  }));
}

async function reflectCandidate(ctx, agent, seed, verdict, focus, signal) {
  const result = await callLlmJson(ctx, agent, {
    temperature: 0.3,
    maxTokens: 4000,
    signal,
    system:
      '你是 Ouroboros 的 reflect 阶段。根据评测结果修订 Seed；只输出完整 Seed 的 JSON 对象，不要 Markdown。' +
      'goal / task_type / constraints / acceptance_criteria / ontology_schema / evaluation_principles / exit_conditions 都要给全。',
    prompt: [
      `当前 Seed：${JSON.stringify({
        goal: seed.goal,
        task_type: seed.task_type,
        constraints: seed.constraints,
        acceptance_criteria: seed.acceptance_criteria,
        ontology_schema: seed.ontology_schema,
        evaluation_principles: seed.evaluation_principles,
        exit_conditions: seed.exit_conditions,
      })}`,
      `最近裁决：${verdict.acceptance_state}`,
      `扣留原因：${verdict.failure_reason ?? '无'}`,
      `Stage2 评审：${JSON.stringify(verdict.stage2 ?? null)}`,
      `本轮 active AC 下标：${focus.active.join(', ')}；frozen：${focus.frozen.join(', ')}`,
      '',
      '只修改需要修改的 AC 与 ontology 字段；frozen 的 AC 不得改动。输出完整 Seed JSON。',
    ].join('\n'),
  });
  if (!result.ok) return null;
  return result.value;
}

function appendLine(path, record) {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(record)}\n`);
}

function normalizeCandidate(raw, previous, seedId) {
  const candidate = freezeSeed({
    ...raw,
    metadata: {
      seed_id: seedId,
      version: previous.metadata?.version ?? '1.0.0',
      created_at: nowIso(),
      ambiguity_score: previous.metadata?.ambiguity_score ?? 0,
      gate_forced: previous.metadata?.gate_forced === true,
      interview_id: previous.metadata?.interview_id,
      decision_provenance: {
        user_confirmed: previous.metadata?.decision_provenance?.user_confirmed ?? 0,
        model_inferred: (previous.metadata?.decision_provenance?.model_inferred ?? 0) + 1,
        maintainer_policy: previous.metadata?.decision_provenance?.maintainer_policy ?? 0,
      },
    },
  });
  const validation = validateSeed(candidate);
  return validation.ok ? candidate : null;
}

export function createEvolveTool(ctx) {
  return defineOooTool({
    name: 'ooo_evolve',
    description:
      '演化循环：run -> evaluate -> reflect 出新 Seed，按相似度/停滞/振荡/平台期/代数上限停止。' +
      'lineage/<id>.jsonl 每代一行，含相似度与 grade。',
    parameters: {
      type: 'object',
      properties: {
        seed_id: { type: 'string', description: '起始 Seed id（必须已锁定）' },
        lineage_id: { type: 'string', description: '血缘 id；省略时新建' },
        max_generations: { type: 'integer', description: `最大代数，默认 ${DEFAULT_GENERATIONS}，上限 ${MAX_GENERATIONS}` },
      },
      required: ['seed_id'],
      additionalProperties: false,
    },
    async execute(args, exec) {
      const agent = requireAgent(exec);
      const root = projectRoot(agent);
      const paths = projectPaths(root);
      requireWritableSession(ctx, agent, root);
      ensureStateDirs(paths);

      const startId = assertSafeId(args.seed_id, 'seed_id');
      const lock = readJson(paths.lock_file);
      if (lock === undefined || lock.seed_id !== startId) {
        throw new OuroborosError(
          `Seed ${startId} 未锁定（或锁定的不是它）；演化开始前必须有已锁定的 Seed。`,
          'SEED_NOT_LOCKED',
        );
      }
      let currentSeed = loadSeed(paths, startId);
      if (currentSeed === undefined) {
        throw new OuroborosError(`找不到 Seed 正文 ${startId}.json`, 'SEED_MISSING');
      }

      const lineageId =
        args.lineage_id === undefined
          ? newId('lineage')
          : assertSafeId(args.lineage_id, 'lineage_id');
      const maxGenerations = clampGenerations(args.max_generations);
      const lineagePath = join(paths.lineage_dir, `${lineageId}.jsonl`);

      const runTool = createRunTool(ctx);
      const evaluateTool = createEvaluateTool(ctx);

      const history = [];
      let similarity = 1;
      let converged = false;
      let lastStop = null;
      let grade = null;
      let everApproved = false;
      let generation = 0;

      for (generation = 1; generation <= maxGenerations; generation += 1) {
        const seedId = currentSeed.metadata.seed_id;
        const run = await runTool.execute({ seed_id: seedId }, exec);
        const verdict = await evaluateTool.execute({ seed_id: seedId, run_id: run.run_id }, exec);
        const runRecord = readJson(join(paths.runs_dir, run.run_id, 'run.json'));
        const acResults = acResultsFromRun(verdict, runRecord);

        grade = verdict.acceptance_state;
        const approved = grade === 'approved';
        const score = typeof verdict.stage2?.score === 'number' ? verdict.stage2.score : 0;
        const regression = everApproved && !approved;
        if (approved) everApproved = true;

        const focus = selectFocus({
          parentAcs: currentSeed.acceptance_criteria,
          candidateAcs: currentSeed.acceptance_criteria,
          acResults,
        });

        history.push({ generation, similarity, score, approved, evaluated: true });
        const stop = decideStop({
          history,
          generation,
          blocks: {
            evaluated: true,
            verdict: grade,
            ac_coverage_complete: acResults.length > 0,
            per_ac_authority: approved && acResults.every((result) => result.authoritative_pass === true),
            score,
            regression,
            validation_passed: approved,
          },
          minGenerations: MIN_GENERATIONS,
          maxGenerations,
        });
        lastStop = stop;
        converged = stop.converged;

        const record = {
          generation,
          at: nowIso(),
          lineage_id: lineageId,
          seed_id: seedId,
          run_id: run.run_id,
          similarity,
          grade,
          acceptance_state: grade,
          score,
          blocks: stop.blocks,
          blockers: stop.blockers,
          focus: { active: focus.active, frozen: focus.frozen, reason: focus.reason },
          stop_reason: stop.reason,
          converged: stop.converged,
        };
        appendLine(lineagePath, record);
        appendLedger(paths, 'evolve.generation', {
          lineage_id: lineageId,
          generation,
          seed_id: seedId,
          similarity,
          grade,
          stop_reason: stop.reason,
        });

        if (stop.stop) break;

        // Produce the next candidate from the evaluated Seed.
        const focusWithCandidate = selectFocus({
          parentAcs: currentSeed.acceptance_criteria,
          candidateAcs: currentSeed.acceptance_criteria,
          acResults,
          challengedIndices: focus.active,
        });
        const raw = await reflectCandidate(ctx, agent, currentSeed, verdict, focusWithCandidate, exec.signal);
        const nextSeedId = makeSeedId();
        const candidate = raw === null ? null : normalizeCandidate(raw, currentSeed, nextSeedId);
        if (candidate === null) {
          // Reflect failed or produced an invalid Seed: keep the current Seed.
          // Similarity 1 will surface as a stall instead of a false convergence.
          similarity = 1;
        } else {
          similarity = seedSimilarity(currentSeed, candidate);
          const seedPath = join(paths.seeds_dir, `${candidate.metadata.seed_id}.json`);
          writeJsonAtomic(seedPath, JSON.parse(serializeSeed(candidate)));
          writeSeedLock(paths, {
            seed_id: candidate.metadata.seed_id,
            hash: hashSeed(candidate),
            gates_passed: [],
            gate_forced: candidate.metadata.gate_forced === true,
            ambiguity_score: candidate.metadata.ambiguity_score,
            interview_id: candidate.metadata.interview_id,
            created_at: nowIso(),
            parent_seed_id: currentSeed.metadata.seed_id,
            lineage_id: lineageId,
            generation: generation + 1,
          });
          currentSeed = candidate;
        }
      }

      const finalGeneration = Math.min(generation, maxGenerations);
      appendLedger(paths, 'evolve.converged', {
        lineage_id: lineageId,
        generations: finalGeneration,
        converged,
        similarity: lastStop?.similarity ?? similarity,
        stop_reason: lastStop?.reason ?? null,
      });

      return {
        lineage_id: lineageId,
        path: lineagePath,
        generations: finalGeneration,
        converged,
        similarity: lastStop?.similarity ?? similarity,
        stop_reason: lastStop?.reason ?? null,
        blockers: lastStop?.blockers ?? [],
        grade,
        next_action: converged ? 'done' : 'ooo_evolve',
      };
    },
  });
}
