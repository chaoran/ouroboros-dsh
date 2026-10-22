import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { apply, installSeedGuard } from '../index.js';
import { SEED_GUARD_REASON, TOOL_NAMES } from '../core/constants.js';
import { buildWorkerPrompt } from '../tools/shared.js';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));

function fakeContext() {
  const providers = [];
  const tools = new Map();
  const guards = [];
  const listeners = new Map();
  return {
    providers,
    tools,
    guards,
    listeners,
    skills: {
      registerProvider(create) {
        providers.push(create({ signal: new AbortController().signal, invalidate() {} }));
        return () => {};
      },
    },
    toolsRegistry: {
      register(definition) {
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
      guard(fn) {
        guards.push(fn);
        return () => {};
      },
    },
    on(event, listener) {
      listeners.set(event, listener);
    },
    get() {
      return undefined;
    },
  };
}

// `apply` expects ctx.tools to be the tool registry.
function pluginContext() {
  const ctx = fakeContext();
  const registered = new Map();
  ctx.registered = registered;
  ctx.tools = {
    register(definition) {
      registered.set(definition.name, definition);
      return () => registered.delete(definition.name);
    },
    guard(fn) {
      ctx.guards.push(fn);
      return () => {};
    },
  };
  return ctx;
}

test('apply：启动时只注册 1 个技能、0 个工具', async () => {
  const ctx = pluginContext();
  apply(ctx);
  assert.equal(ctx.registered.size, 0, 'apply 期间不得注册任何 ooo_* 工具');
  assert.equal(ctx.providers.length, 1);
  const skills = await ctx.providers[0].list({});
  assert.equal(skills.length, 1);
  assert.equal(skills[0].name, 'ooo');
  assert.deepEqual(skills[0].invocation, { modelInvocable: true, userInvocable: true });
  assert.ok(skills[0].description.length <= 200, 'description 必须 ≤200 字');
  for (const word of ['ooo', '访谈', '规格', 'Seed', '评测', '演化', '先加载本技能再动手']) {
    assert.ok(skills[0].description.includes(word), `description 缺少触发词：${word}`);
  }
});

test('技能被加载的那一刻注册 6 个工具，且幂等', async () => {
  const ctx = pluginContext();
  apply(ctx);
  const provider = ctx.providers[0];
  const [candidate] = await provider.list({});
  assert.equal(ctx.registered.size, 0);
  const skill = await provider.get(candidate, {});
  assert.equal(skill.name, 'ooo');
  assert.match(skill.content, /^# ooo/m);
  assert.deepEqual([...ctx.registered.keys()].sort(), [...TOOL_NAMES].sort());
  for (const definition of ctx.registered.values()) {
    assert.equal(typeof definition.execute, 'function');
    assert.equal(typeof definition.description, 'string');
    assert.equal(definition.parameters.type, 'object');
    assert.equal(definition.output.schema.type, 'object');
    assert.equal(typeof definition.output.render, 'function');
    const rendered = definition.output.render({}, { ok: true });
    assert.equal(rendered[0].type, 'text');
  }
  await provider.get(candidate, {});
  assert.equal(ctx.registered.size, 6, '重复 get 不得重复注册或抛错');
});

test('SKILL.md 结构：触发 → 五步 → 硬门 → 状态 → references → footer → 禁止', () => {
  const body = readFileSync(join(REPO, 'skill', 'SKILL.md'), 'utf8');
  const order = ['## 1. 触发', '## 2. 五步', '## 3. 硬门清单', '## 4. 状态约定', '## 5. references 指针', '## 6. footer', '## 7. 禁止'];
  let cursor = -1;
  for (const heading of order) {
    const index = body.indexOf(heading);
    assert.ok(index > cursor, `SKILL.md 缺少或顺序错误的段落：${heading}`);
    cursor = index;
  }
  for (const reference of ['contract', 'interview', 'seed', 'evaluate', 'evolve']) {
    assert.match(body, new RegExp(`references/${reference}\\.md`));
  }
  assert.match(body, /每一步都必须用对应工具，不得手工模拟/);
  assert.match(body, /approved.*只能来自 Stage1 执行证据/s);
  assert.match(body, /◆ <当前状态> → next: <推荐动作>/);
  assert.match(body, /~\/\.ouroboros\//);
  assert.match(body, /ready ≠ 可以写 Seed/);
});

test('Seed 守卫：按 agent 注册；未锁定拒绝 write/edit/str_replace_editor，锁定后放行', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ooo-guard-'));
  try {
    const agentGuards = [];
    const agent = {
      id: 'agent-1',
      session: { header: { cwd: root } },
      ctx: { tools: { guard: (fn) => agentGuards.push(fn) } },
    };
    const guarded = new WeakSet();
    assert.equal(installSeedGuard(agent, guarded), true);
    assert.equal(installSeedGuard(agent, guarded), false, '同一 agent 只注册一次');
    assert.equal(agentGuards.length, 1);

    const guard = agentGuards[0];
    const write = (name, args) => guard({ name, arguments: args });

    for (const [tool, args] of [
      ['write', { file_path: 'src/index.js' }],
      ['edit', { file_path: join(root, 'src/index.js') }],
      ['str_replace_editor', { path: 'README.md' }],
    ]) {
      assert.equal(write(tool, args), SEED_GUARD_REASON, `${tool} 未锁定时必须被拒`);
    }
    assert.equal(
      write('str_replace_editor', { command: 'view', path: 'README.md' }),
      undefined,
      'str_replace_editor 的 view 只读，不拦',
    );
    assert.equal(write('write', { file_path: '../outside.js' }), undefined, '工作区外不归守卫管');
    assert.equal(write('write', { file_path: '/etc/passwd' }), undefined);
    assert.equal(write('bash', { command: 'echo hi > x' }), undefined, 'bash 不在守卫范围（已知缺口）');
    assert.equal(write('read', { file_path: 'src/index.js' }), undefined);

    mkdirSync(join(root, '.ouroboros'), { recursive: true });
    writeFileSync(join(root, '.ouroboros', 'seed.lock.json'), '{"seed_id":"seed_0123456789ab"}');
    assert.equal(write('write', { file_path: 'src/index.js' }), undefined, '锁定后同一路径可写');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('agent/created 监听器用 agent 自己的 ctx 装守卫（不是插件全局 ctx）', () => {
  const ctx = pluginContext();
  apply(ctx);
  const listener = ctx.listeners.get('agent/created');
  assert.equal(typeof listener, 'function');
  const agentGuards = [];
  const agent = {
    id: 'agent-2',
    session: { header: { cwd: mkdtempSync(join(tmpdir(), 'ooo-guard2-')) } },
    ctx: { tools: { guard: (fn) => agentGuards.push(fn) } },
  };
  listener({ agent });
  assert.equal(ctx.guards.length, 0, '插件 ctx 上不得注册全局守卫');
  assert.equal(agentGuards.length, 1);
  rmSync(agent.session.header.cwd, { recursive: true, force: true });
});

test('worker prompt 不含 verify_command / output_assertion（§10 P2.1）', () => {
  const seed = {
    goal: 'markdown 预览器',
    constraints: ['只用标准库'],
    acceptance_criteria: [],
  };
  const ac = {
    description: '渲染标题',
    verify_command: 'node --test test/preview.test.js',
    expected_artifacts: ['packages/preview/index.js'],
    output_assertion: 'stdout 含 <h1>',
  };
  const prompt = buildWorkerPrompt(seed, ac, 0);
  assert.ok(prompt.includes('渲染标题'));
  assert.ok(prompt.includes('packages/preview/index.js'));
  assert.ok(prompt.includes('markdown 预览器'));
  assert.equal(prompt.includes('verify_command'), false);
  assert.equal(prompt.includes('node --test test/preview.test.js'), false);
  assert.equal(prompt.includes('output_assertion'), false);
  assert.equal(prompt.includes('stdout 含 <h1>'), false);
});

function entries(text) {
  const pairs = [];
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    const idMatch = /^\s+- id:\s*(\S+)\s*$/.exec(line);
    if (idMatch !== null) {
      current = { id: idMatch[1], name: null };
      pairs.push(current);
      continue;
    }
    const nameMatch = /^\s+name:\s*(?:'([^']+)'|(\S+))\s*$/.exec(line);
    if (nameMatch !== null && current !== null) {
      current.name = nameMatch[1] ?? nameMatch[2];
    }
  }
  return pairs;
}

test('cordis.patch.yml：一条 preset-ouroboros，照搬 standard 插件清单 + 本插件行', () => {
  const patch = readFileSync(join(REPO, 'cordis.patch.yml'), 'utf8');
  assert.equal(patch.match(/id: preset-ouroboros/g)?.length, 1);
  assert.match(patch, /name: '@deepseek-ai\/dsh-agent-preset'/);
  assert.match(patch, /id: ouroboros/);
  assert.match(patch, /name: '@local\/ouroboros-dsh'/);
  assert.match(patch, /# scaffold-begin/);
  assert.match(patch, /# scaffold-end/);

  const begin = patch.indexOf('# scaffold-begin');
  const end = patch.indexOf('# scaffold-end');
  assert.ok(begin > 0 && end > begin);
  const scaffold = patch.slice(begin, end);
  const own = entries(scaffold);

  const shippedPath =
    process.env.DSH_SHARED_PRESET ??
    '/home/chaoran/.npm/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai/dsh-web-app/presets/standard.patch.yml';
  let shipped;
  try {
    shipped = readFileSync(shippedPath, 'utf8');
  } catch {
    // Not on this machine: the scaffold comparison is unverifiable, but the
    // local shape assertions above still hold.
    return;
  }
  const shippedPlugins = shipped.slice(shipped.indexOf('plugins:'));
  const expected = entries(shippedPlugins);
  assert.deepEqual(
    own.map((entry) => entry.id),
    expected.map((entry) => entry.id),
    'scaffold 的插件 id 顺序必须与 shipped standard 完全一致',
  );
  assert.deepEqual(
    own.map((entry) => entry.name),
    expected.map((entry) => entry.name),
    'scaffold 的插件 name 必须与 shipped standard 完全一致',
  );

  const tail = entries(patch.slice(end));
  assert.deepEqual(tail, [{ id: 'ouroboros', name: '@local/ouroboros-dsh' }]);
});
