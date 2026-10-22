/**
 * Stage 1: `.ouroboros/mechanical.toml` -> argv -> exit code -> evidence.
 *
 * No shell. Commands are read from a small TOML subset, tokenized here, and
 * rejected when they contain shell metacharacters, absolute executable paths,
 * or an executable outside the allowlist. Missing commands are not evidence
 * (`executed: false`), which keeps the verdict at `unverified`.
 *
 * Pure functions only; spawning lives in tools/shared.js.
 * Source of truth: docs/design.md §7 (Stage1 命令集) and §4.2.
 */
import {
  COVERAGE_THRESHOLD,
  STAGE1_CHECK_TYPES,
  STAGE1_EXECUTABLE_ALLOWLIST,
  STAGE1_SHELL_METACHARACTERS,
  STAGE1_TIMEOUT_MS,
} from './constants.js';

const ALLOWED_KEYS = new Set([...STAGE1_CHECK_TYPES, 'timeout']);

/** Strip a `#` comment that is not inside a quoted value. */
function stripComment(line) {
  let inSingle = false;
  let inDouble = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (inSingle) {
      if (char === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      if (char === '"' && line[index - 1] !== '\\') inDouble = false;
      continue;
    }
    if (char === "'") {
      inSingle = true;
      continue;
    }
    if (char === '"') {
      inDouble = true;
      continue;
    }
    if (char === '#') return line.slice(0, index);
  }
  return line;
}

/**
 * Parse the flat TOML subset used by `.ouroboros/mechanical.toml`:
 * `key = "string"`, `key = 'string'`, `timeout = 600`, comments with `#`.
 * @param {string} text
 * @returns {{ entries: Record<string, string>, timeout: number|null, errors: string[] }}
 */
export function parseMechanicalToml(text) {
  const entries = {};
  const errors = [];
  let timeout = null;

  const lines = String(text ?? '').split(/\r?\n/);
  lines.forEach((rawLine, index) => {
    const line = stripComment(rawLine).trim();
    if (line === '') return;
    if (line.startsWith('[')) {
      errors.push(`第 ${index + 1} 行：不支持 TOML section`);
      return;
    }
    const match = /^([A-Za-z0-9_-]+)\s*=\s*(.*)$/.exec(line);
    if (match === null) {
      errors.push(`第 ${index + 1} 行：无法解析`);
      return;
    }
    const [, key, rawValue] = match;
    if (!ALLOWED_KEYS.has(key)) {
      errors.push(`第 ${index + 1} 行：未知键 "${key}"`);
      return;
    }
    let value;
    if (rawValue.startsWith('"') && rawValue.endsWith('"') && rawValue.length >= 2) {
      value = rawValue.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    } else if (rawValue.startsWith("'") && rawValue.endsWith("'") && rawValue.length >= 2) {
      value = rawValue.slice(1, -1);
    } else if (/^\d+$/.test(rawValue)) {
      value = Number(rawValue);
    } else {
      errors.push(`第 ${index + 1} 行：值必须是引号字符串或整数`);
      return;
    }
    if (key === 'timeout') {
      if (typeof value !== 'number' || value <= 0) {
        errors.push(`第 ${index + 1} 行：timeout 必须是正整数（秒）`);
        return;
      }
      timeout = value;
      return;
    }
    entries[key] = value;
  });

  return { entries, timeout, errors };
}

/**
 * Split a command string into argv without a shell. Quoted segments are kept
 * verbatim; shell metacharacters outside single quotes are a hard error.
 * @param {string} command
 * @returns {{ ok: boolean, argv: string[], error: string|null }}
 */
export function tokenizeCommand(command) {
  const source = String(command ?? '');
  if (source.trim() === '') return { ok: false, argv: [], error: '命令为空' };

  const argv = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  let started = false;

  const flush = () => {
    if (started) {
      argv.push(current);
      current = '';
      started = false;
    }
  };

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];

    if (inSingle) {
      if (char === "'") inSingle = false;
      else current += char;
      continue;
    }
    if (inDouble) {
      if (char === '"') {
        inDouble = false;
        continue;
      }
      if ((char === '$' || char === '`') && !inSingle) {
        return { ok: false, argv: [], error: `命令包含被禁止的 shell 元字符 "${char}"` };
      }
      current += char;
      continue;
    }

    if (char === "'") {
      inSingle = true;
      started = true;
      continue;
    }
    if (char === '"') {
      inDouble = true;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      flush();
      continue;
    }
    if (STAGE1_SHELL_METACHARACTERS.includes(char)) {
      return { ok: false, argv: [], error: `命令包含被禁止的 shell 元字符 "${char === '\n' ? '\\n' : char}"` };
    }
    current += char;
    started = true;
  }

  if (inSingle || inDouble) return { ok: false, argv: [], error: '命令引号未闭合' };
  flush();

  if (argv.length === 0) return { ok: false, argv: [], error: '命令为空' };
  return { ok: true, argv, error: null };
}

/**
 * Validate argv[0] against the allowlist. Absolute paths and paths containing
 * separators are rejected: the allowlist names executables, not locations.
 * @param {string} program
 * @returns {string|null} violation, or null when acceptable
 */
export function validateExecutable(program) {
  if (typeof program !== 'string' || program === '') return '缺少可执行文件';
  if (program.startsWith('/') || program.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(program)) {
    return `不允许绝对路径可执行文件 "${program}"`;
  }
  if (program.includes('/') || program.includes('\\')) {
    return `不允许带路径分隔符的可执行文件 "${program}"`;
  }
  if (!STAGE1_EXECUTABLE_ALLOWLIST.includes(program)) {
    return `可执行文件 "${program}" 不在白名单内`;
  }
  return null;
}

/**
 * Build the execution plan from mechanical.toml text.
 *
 * @param {string} text
 * @param {object} [options]
 * @param {number} [options.timeoutMs] caller override (wins over the file)
 * @returns {{
 *   configured: boolean,
 *   timeout_ms: number,
 *   checks: Array<{
 *     check_type: string, configured: boolean, command: string|null,
 *     argv: string[]|null, reason: string|null
 *   }>,
 *   errors: string[]
 * }}
 */
export function planStage1(text, options = {}) {
  const parsed = parseMechanicalToml(text);
  const timeoutSeconds =
    Number.isInteger(parsed.timeout) && parsed.timeout > 0 ? parsed.timeout : null;
  const timeoutMs =
    Number.isInteger(options.timeoutMs) && options.timeoutMs > 0
      ? options.timeoutMs
      : timeoutSeconds !== null
        ? timeoutSeconds * 1000
        : STAGE1_TIMEOUT_MS;

  const checks = STAGE1_CHECK_TYPES.map((checkType) => {
    const command = parsed.entries[checkType];
    if (command === undefined) {
      return {
        check_type: checkType,
        configured: false,
        command: null,
        argv: null,
        reason: '未配置',
      };
    }
    const tokenized = tokenizeCommand(command);
    if (!tokenized.ok) {
      return {
        check_type: checkType,
        configured: false,
        invalid: true,
        command,
        argv: null,
        reason: tokenized.error,
      };
    }
    const executableViolation = validateExecutable(tokenized.argv[0]);
    if (executableViolation !== null) {
      return {
        check_type: checkType,
        configured: false,
        invalid: true,
        command,
        argv: null,
        reason: executableViolation,
      };
    }
    return {
      check_type: checkType,
      configured: true,
      command,
      argv: tokenized.argv,
      reason: null,
    };
  });

  return {
    configured: checks.some((check) => check.configured),
    timeout_ms: timeoutMs,
    checks,
    errors: parsed.errors,
  };
}

/**
 * Parse a coverage percentage/number out of command output.
 * Accepts `85%`, `85.5%`, and a bare fraction in 0..1.
 * @param {string} output
 * @returns {number|null} coverage in 0..1
 */
export function parseCoverage(output) {
  const text = String(output ?? '');
  const matches = [...text.matchAll(/(\d+(?:\.\d+)?)\s*%/g)];
  if (matches.length > 0) {
    const value = Number(matches[matches.length - 1][1]) / 100;
    return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : null;
  }
  const bare = /(?:coverage|Coverage)[^\d]*(\d+(?:\.\d+)?)/.exec(text);
  if (bare !== null) {
    const value = Number(bare[1]);
    if (!Number.isFinite(value)) return null;
    return value <= 1 ? value : Math.min(1, value / 100);
  }
  return null;
}

/**
 * Turn a settled process into one Stage-1 check entry.
 *
 * @param {object} planEntry from {@link planStage1}
 * @param {object} run
 * @param {number|null} run.exitCode
 * @param {boolean} [run.timedOut]
 * @param {string} [run.stdout]
 * @param {string} [run.stderr]
 * @param {boolean} [run.confined]
 * @returns {{ check_type: string, passed: boolean, executed: boolean, exit_code: number|null, message: string }}
 */
export function buildCheck(planEntry, run) {
  if (planEntry.invalid === true) {
    // A command that is declared but rejected (shell metacharacter, absolute
    // executable, allowlist miss) is a hard Stage-1 failure, not a silent skip.
    return {
      check_type: planEntry.check_type,
      passed: false,
      executed: true,
      exit_code: -1,
      message: `rejected: ${planEntry.reason}`,
    };
  }
  if (!planEntry.configured) {
    return {
      check_type: planEntry.check_type,
      passed: true,
      executed: false,
      exit_code: null,
      message: `skipped: ${planEntry.reason ?? '未配置'}（不算证据）`,
    };
  }

  if (run.timedOut === true) {
    return {
      check_type: planEntry.check_type,
      passed: false,
      executed: true,
      exit_code: -1,
      message: `timeout after ${run.timeoutMs ?? '?'}ms`,
    };
  }

  const exitCode = run.exitCode ?? -1;
  const tail = String(run.stderr ?? run.stdout ?? '')
    .trim()
    .split(/\r?\n/)
    .slice(-3)
    .join(' | ')
    .slice(0, 600);
  let passed = exitCode === 0;
  let suffix = '';

  if (planEntry.check_type === 'coverage') {
    const coverage = parseCoverage(`${run.stdout ?? ''}\n${run.stderr ?? ''}`);
    if (coverage === null) {
      passed = false;
      suffix = '（未能从输出解析覆盖率）';
    } else {
      passed = passed && coverage >= COVERAGE_THRESHOLD;
      suffix = `（覆盖率 ${coverage}，阈值 ${COVERAGE_THRESHOLD}）`;
    }
  }

  return {
    check_type: planEntry.check_type,
    passed,
    executed: true,
    exit_code: exitCode,
    message: `exit ${exitCode}${suffix}${tail === '' ? '' : `: ${tail}`}`,
  };
}

/**
 * Stage-1 evidence block for `stage1.json` / `verdict.json`.
 * @param {Array<object>} checks
 */
export function summarizeStage1(checks) {
  const list = Array.isArray(checks) ? checks : [];
  return {
    has_executed_evidence: list.some((check) => check?.executed === true),
    checks: list,
  };
}
