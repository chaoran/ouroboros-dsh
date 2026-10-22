/**
 * `ooo_status` — read-only summary of the project's Ouroboros state.
 * Returns the exact footer line the skill requires at the end of each reply.
 */
import { readdirSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

import {
  defineOooTool,
  footer,
  localeStrings,
  projectPaths,
  projectRoot,
  readJson,
  readText,
  requireAgent,
} from './shared.js';

function listRuns(paths) {
  const index = readJson(join(paths.runs_dir, 'index.json'));
  const entries = Array.isArray(index?.runs) ? index.runs : [];
  return entries
    .map((entry) => {
      const record = readJson(join(paths.runs_dir, entry.run_id, 'run.json'));
      const verdict = readJson(join(paths.runs_dir, entry.run_id, 'verdict.json'));
      return { entry, record, verdict };
    })
    .filter((item) => item.record !== undefined);
}

function latestVerdict(runs) {
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    if (runs[index].verdict !== undefined) {
      return {
        run_id: runs[index].record.run_id,
        acceptance_state: runs[index].verdict.acceptance_state,
        failure_reason: runs[index].verdict.failure_reason ?? null,
        decided_at: runs[index].verdict.decided_at ?? null,
      };
    }
  }
  return null;
}

function interviewAmbiguity(paths) {
  let names;
  try {
    names = readdirSync(paths.interviews_dir).filter((name) => name.endsWith('.json'));
  } catch {
    return null;
  }
  let latest = null;
  for (const name of names) {
    const state = readJson(join(paths.interviews_dir, name));
    if (state === undefined || state.last_scored === null || state.last_scored === undefined) continue;
    if (latest === null || String(state.updated_at ?? '') > String(latest.updated_at ?? '')) {
      latest = state;
    }
  }
  if (latest === null) return null;
  return {
    interview_id: latest.interview_id,
    total: latest.last_scored.total,
    clarity: latest.last_scored.clarity,
    milestone: latest.last_scored.milestone,
    answered_rounds: latest.last_scored.answered_rounds,
    ready: latest.last_scored.ready,
  };
}

function lineageSummary(paths) {
  let names;
  try {
    names = readdirSync(paths.lineage_dir).filter((name) => name.endsWith('.jsonl'));
  } catch {
    return { generations: 0, converged: false, lineage_id: null };
  }
  let generations = 0;
  let converged = false;
  let lineageId = null;
  for (const name of names) {
    const text = readText(join(paths.lineage_dir, name)) ?? '';
    const lines = text.split('\n').filter((line) => line.trim() !== '');
    generations = Math.max(generations, lines.length);
    lineageId = name.replace(/\.jsonl$/, '');
    for (const line of lines) {
      try {
        const record = JSON.parse(line);
        if (record?.converged === true || record?.stop_reason === 'converged' || record?.stop_reason === 'early_converged') {
          converged = true;
        }
      } catch {
        // status is read-only: a corrupt lineage line is reported by count only
      }
    }
  }
  return { generations, converged, lineage_id: lineageId };
}

export function createStatusTool(ctx) {
  return defineOooTool({
    name: 'ooo_status',
    description:
      '只读汇总当前项目的 Ouroboros 状态：阶段、歧义、Seed 锁定、演化代数、最近裁决，并给出 footer 行。',
    parameters: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: '要查看的项目根目录；省略时用当前会话 cwd' },
      },
      additionalProperties: false,
    },
    async execute(args, exec) {
      const agent = requireAgent(exec);
      const base = projectRoot(agent);
      const root = typeof args.cwd === 'string' && args.cwd !== ''
        ? (isAbsolute(args.cwd) ? args.cwd : resolve(base, args.cwd))
        : base;
      const paths = projectPaths(root);

      const lock = readJson(paths.lock_file);
      const runs = listRuns(paths);
      const lastVerdict = latestVerdict(runs);
      const lineage = lineageSummary(paths);
      const ambiguity = interviewAmbiguity(paths) ?? (lock === undefined
        ? null
        : {
            interview_id: lock.interview_id ?? null,
            total: lock.ambiguity_score ?? null,
            clarity: null,
            milestone: null,
            answered_rounds: null,
            ready: true,
          });

      let phase;
      let next;
      if (lock === undefined) {
        phase = 'interview';
        next = ambiguity?.ready === true ? 'ooo_seed' : 'ooo_interview';
      } else if (runs.length === 0) {
        phase = 'seed-locked';
        next = 'ooo_run';
      } else if (lastVerdict === null) {
        phase = 'awaiting-evaluation';
        next = 'ooo_evaluate';
      } else if (lastVerdict.acceptance_state === 'approved') {
        phase = lineage.converged ? 'converged' : lineage.generations > 0 ? 'evolving' : 'approved';
        next = lineage.converged ? 'done' : 'ooo_evolve';
      } else if (lastVerdict.acceptance_state === 'rejected') {
        phase = 'rejected';
        next = 'ooo_run';
      } else {
        phase = 'unverified';
        next = 'ooo_evaluate';
      }

      const locale = localeStrings();
      return {
        cwd: root,
        phase,
        locked: lock === undefined ? false : true,
        seed_id: lock?.seed_id ?? null,
        ambiguity,
        generations: lineage.generations,
        lineage_id: lineage.lineage_id,
        last_verdict: lastVerdict,
        footer: footer(locale.status?.[phase] ?? phase, locale.next?.[next] ?? next),
      };
    },
  });
}
