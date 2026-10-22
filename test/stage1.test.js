import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCheck,
  parseCoverage,
  parseMechanicalToml,
  planStage1,
  summarizeStage1,
  tokenizeCommand,
  validateExecutable,
} from '../core/stage1.js';
import { COVERAGE_THRESHOLD, STAGE1_TIMEOUT_MS } from '../core/constants.js';

test('mechanical.toml 解析：五类命令 + timeout（秒）', () => {
  const parsed = parseMechanicalToml(`
# 注释
lint = "npm run lint"
test = 'node --test test/'
coverage = "node --test --experimental-test-coverage test/"
timeout = 600
`);
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.timeout, 600);
  assert.equal(parsed.entries.lint, 'npm run lint');
  assert.equal(parsed.entries.test, 'node --test test/');

  const plan = planStage1('test = "node --test test/"\ntimeout = 600\n');
  assert.equal(plan.timeout_ms, 600_000);
  assert.equal(plan.checks.find((check) => check.check_type === 'test').configured, true);
  assert.equal(plan.checks.find((check) => check.check_type === 'lint').configured, false);

  const defaulted = planStage1('test = "node --test test/"');
  assert.equal(defaulted.timeout_ms, STAGE1_TIMEOUT_MS);
});

test('Stage1 拒绝 shell 元字符（无 shell 语义）', () => {
  for (const command of [
    'pytest && rm -rf /',
    'npm test | tee out.txt',
    'node --test test/; echo done',
    'echo $(id)',
    'cat < input.txt',
    'echo `id`',
  ]) {
    const tokenized = tokenizeCommand(command);
    assert.equal(tokenized.ok, false, `应拒绝：${command}`);
    assert.match(tokenized.error, /shell 元字符/);
  }
  const plan = planStage1('test = "pytest && rm -rf /"');
  const testCheck = plan.checks.find((check) => check.check_type === 'test');
  assert.equal(testCheck.configured, false);
  assert.equal(testCheck.invalid, true);
  assert.match(testCheck.reason, /shell 元字符/);
  const rejected = buildCheck(testCheck, {});
  assert.equal(rejected.executed, true, '被拒绝的命令是硬失败，不是静默跳过');
  assert.equal(rejected.passed, false);
  assert.match(rejected.message, /rejected/);
});

test('Stage1 拒绝绝对路径可执行文件与白名单外程序', () => {
  assert.match(validateExecutable('/usr/bin/node'), /绝对路径/);
  assert.match(validateExecutable('C:\\tools\\node.exe'), /绝对路径/);
  assert.match(validateExecutable('./scripts/run.sh'), /路径分隔符/);
  assert.match(validateExecutable('curl'), /不在白名单/);
  assert.equal(validateExecutable('node'), null);
  assert.equal(validateExecutable('pnpm'), null);

  const plan = planStage1('static = "/usr/local/bin/tsc --noEmit"');
  const staticCheck = plan.checks.find((check) => check.check_type === 'static');
  assert.equal(staticCheck.configured, false);
  assert.match(staticCheck.reason, /绝对路径/);
});

test('argv 严格切分，不经过 shell', () => {
  assert.deepEqual(tokenizeCommand('node --test test/').argv, ['node', '--test', 'test/']);
  assert.deepEqual(tokenizeCommand("node  --test 'my test/mock'.js").argv, [
    'node',
    '--test',
    'my test/mock.js',
  ]);
  assert.equal(tokenizeCommand('').ok, false);
  assert.equal(tokenizeCommand('node "unterminated').ok, false);
});

test('未配置不算证据；执行通过/失败/超时的 executed 语义', () => {
  const plan = planStage1('test = "node --test test/"');
  const unconfigured = plan.checks.find((check) => check.check_type === 'lint');
  const skipped = buildCheck(unconfigured, {});
  assert.equal(skipped.executed, false);
  assert.equal(skipped.passed, true);
  assert.match(skipped.message, /skipped/);

  const testEntry = plan.checks.find((check) => check.check_type === 'test');
  const pass = buildCheck(testEntry, { exitCode: 0, stdout: 'ok' });
  assert.deepEqual(
    { passed: pass.passed, executed: pass.executed, exit_code: pass.exit_code },
    { passed: true, executed: true, exit_code: 0 },
  );

  const fail = buildCheck(testEntry, { exitCode: 1, stderr: 'boom' });
  assert.equal(fail.passed, false);
  assert.equal(fail.executed, true);
  assert.match(fail.message, /boom/);

  const timeout = buildCheck(testEntry, { exitCode: null, timedOut: true, timeoutMs: 300000 });
  assert.equal(timeout.passed, false);
  assert.equal(timeout.executed, true);
  assert.equal(timeout.exit_code, -1);
  assert.match(timeout.message, /timeout/);

  const summary = summarizeStage1([skipped]);
  assert.equal(summary.has_executed_evidence, false);
  assert.equal(summarizeStage1([pass]).has_executed_evidence, true);
});

test('覆盖率阈值 0.7 只在 coverage 配了命令时判', () => {
  assert.equal(parseCoverage('All files | 85.5% |'), 0.855);
  assert.equal(parseCoverage('coverage: 0.72'), 0.72);
  assert.equal(parseCoverage('no numbers here'), null);

  const plan = planStage1('coverage = "node --test --experimental-test-coverage test/"');
  const coverageEntry = plan.checks.find((check) => check.check_type === 'coverage');
  const below = buildCheck(coverageEntry, { exitCode: 0, stdout: 'coverage: 65%' });
  assert.equal(below.passed, false);
  assert.match(below.message, new RegExp(`阈值 ${COVERAGE_THRESHOLD}`));

  const atThreshold = buildCheck(coverageEntry, { exitCode: 0, stdout: 'coverage: 70%' });
  assert.equal(atThreshold.passed, true);

  const unparsable = buildCheck(coverageEntry, { exitCode: 0, stdout: 'no coverage here' });
  assert.equal(unparsable.passed, false);
  assert.match(unparsable.message, /未能从输出解析覆盖率/);
});

test('mechanical.toml 语法错误会报告，但计划仍可生成', () => {
  const plan = planStage1('unknown_key = "x"\n[section]\ntest = "node --test test/"');
  assert.equal(plan.errors.length, 2);
  assert.equal(plan.checks.find((check) => check.check_type === 'test').configured, true);
});
