/**
 * @local/ouroboros-dsh — spec-first workflow for DeepSeek Harness.
 *
 * Exposes exactly one skill (`ooo`) at startup and nothing else. The six
 * `ooo_*` tools are registered lazily inside `skill.get('ooo')`, so sessions
 * that never load the skill carry no ooo tool schema at all. The Seed lock
 * guard is registered per agent in `agent/created`, using that agent's own
 * ctx, so it never leaks into other presets.
 *
 * Source of truth: docs/design.md §2.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SEED_GUARD_REASON,
  SEED_LOCK_FILE,
  WRITE_TOOL_NAMES,
} from './core/constants.js';
import { isInsideWorkspace, localeStrings, resolveWorkspacePath } from './tools/shared.js';
import { createEvolveTool } from './tools/evolve.js';
import { createEvaluateTool } from './tools/evaluate.js';
import { createInterviewTool } from './tools/interview.js';
import { createRunTool } from './tools/run.js';
import { createSeedTool } from './tools/seed.js';
import { createStatusTool } from './tools/status.js';

export const name = 'ouroboros';

/** Services this plugin needs at apply time. Everything else is read lazily. */
export const inject = ['skills', 'tools'];

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = join(MODULE_DIR, 'skill');

const DEFAULT_DESCRIPTION =
  'Ouroboros 规格先行工作流（ooo / 访谈 / 规格 / Seed / 评测 / 演化）。做需求、写规格、执行或验收前，先加载本技能再动手。';

const TOOL_FACTORIES = [
  createInterviewTool,
  createSeedTool,
  createRunTool,
  createEvaluateTool,
  createEvolveTool,
  createStatusTool,
];

/** Extract the file path a write-class tool targets. */
export function writeTarget(args) {
  if (args === null || typeof args !== 'object') return undefined;
  for (const key of ['file_path', 'path', 'filePath', 'target']) {
    if (typeof args[key] === 'string' && args[key] !== '') return args[key];
  }
  return undefined;
}

/** The path a write tool's guard reads (project-relative lock file). */
function lockFilePath(root) {
  return join(root, SEED_LOCK_FILE);
}

/**
 * Register the Seed lock guard for one agent. The guard is sync and reads one
 * small JSON file. It can only deny; it never grants.
 *
 * @returns {boolean} whether a guard was installed for this agent
 */
export function installSeedGuard(agent, guarded) {
  if (guarded.has(agent)) return false;
  const tools = agent?.ctx?.tools;
  if (tools === undefined || typeof tools.guard !== 'function') return false;
  guarded.add(agent);

  tools.guard((execution) => {
    if (!WRITE_TOOL_NAMES.includes(execution?.name)) return undefined;
    // `str_replace_editor`'s view command only reads; it is not a write.
    if (execution?.name === 'str_replace_editor' && execution?.arguments?.command === 'view') {
      return undefined;
    }
    const root = agent?.session?.header?.cwd;
    if (typeof root !== 'string' || root === '') return undefined;
    const target = writeTarget(execution?.arguments);
    if (target === undefined) return undefined;
    const resolved = resolveWorkspacePath(root, target);
    if (!isInsideWorkspace(root, resolved)) return undefined;
    if (existsSync(lockFilePath(root))) return undefined;
    return SEED_GUARD_REASON;
  });
  return true;
}

/**
 * Register the six tools once. Idempotent; a partial failure resets the flag so
 * a retry can finish the job.
 */
export function createToolRegistrar(ctx) {
  const registered = new Set();
  return function ensureTools() {
    for (const factory of TOOL_FACTORIES) {
      if (registered.size === TOOL_FACTORIES.length) return;
      const definition = factory(ctx);
      if (registered.has(definition.name)) continue;
      // The registry ties the registration to this plugin scope, so unload
      // disposes it; no extra effect is needed here.
      ctx.tools.register(definition);
      registered.add(definition.name);
    }
  };
}

/**
 * Plugin entry point.
 * @param {import('@deepseek-ai/cordis').Context} ctx preset-scoped context
 * @param {object} [config]
 */
export function apply(ctx, config = {}) {
  const locale = localeStrings();
  const description = String(config.description ?? locale.skill_description ?? DEFAULT_DESCRIPTION);
  const ensureTools = createToolRegistrar(ctx);
  const guarded = new WeakSet();

  ctx.skills.registerProvider((control) => ({
    name: 'ouroboros',
    list: async () => {
      if (control.signal.aborted) return [];
      return [
        {
          name: 'ooo',
          description,
          whenToUse: locale.skill_when_to_use ?? undefined,
          invocation: { modelInvocable: true, userInvocable: true },
          source: 'runtime',
          provider: 'ouroboros',
          rank: 100,
          locator: { name: 'ooo' },
        },
      ];
    },
    get: async (candidate) => {
      if (control.signal.aborted) return undefined;
      let content;
      try {
        content = readFileSync(join(SKILL_DIR, 'SKILL.md'), 'utf8');
      } catch {
        return undefined;
      }
      // Tool registration happens exactly when the skill body is loaded.
      ensureTools();
      return {
        name: 'ooo',
        description,
        invocation: { modelInvocable: true, userInvocable: true },
        source: 'runtime',
        provider: 'ouroboros',
        content,
        resourceBase: { kind: 'directory', path: SKILL_DIR },
        ...(candidate?.whenToUse === undefined ? {} : { whenToUse: candidate.whenToUse }),
      };
    },
  }));

  // Per-agent guard: never register on the plugin ctx (that would be global).
  ctx.on('agent/created', ({ agent }) => {
    try {
      installSeedGuard(agent, guarded);
    } catch (error) {
      // A guard failure must not fail agent creation; log and continue.
      if (typeof ctx.logger?.warn === 'function') {
        ctx.logger.warn(`ouroboros: failed to install seed guard: ${error?.message ?? error}`);
      }
    }
  });
}

export default { name, inject, apply };
