import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));

function sourceFiles() {
  const files = [join(REPO, 'index.js')];
  for (const dir of ['core', 'tools']) {
    for (const name of readdirSync(join(REPO, dir))) {
      if (name.endsWith('.js')) files.push(join(REPO, dir, name));
    }
  }
  return files;
}

test('§3.1 文件树全部存在', () => {
  const required = [
    'package.json',
    'cordis.patch.yml',
    'index.js',
    'core/constants.js',
    'core/seed.js',
    'core/ambiguity.js',
    'core/gate.js',
    'core/stage1.js',
    'core/trigger.js',
    'core/consensus.js',
    'core/converge.js',
    'core/focus.js',
    'core/ledger.js',
    'tools/interview.js',
    'tools/seed.js',
    'tools/run.js',
    'tools/evaluate.js',
    'tools/evolve.js',
    'tools/status.js',
    'skill/SKILL.md',
    'skill/references/contract.md',
    'skill/references/interview.md',
    'skill/references/seed.md',
    'skill/references/evaluate.md',
    'skill/references/evolve.md',
    'locale/zh.json',
    'locale/en.json',
    'icon.svg',
  ];
  for (const path of required) assert.ok(existsSync(join(REPO, path)), `缺少 ${path}`);
});

test('bundle manifest: 纯 ESM、无构建、无运行时依赖、声明 dsh.bundle.patch', () => {
  const manifest = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));
  assert.equal(manifest.name, '@local/ouroboros-dsh');
  assert.equal(manifest.type, 'module');
  assert.equal(manifest.main, 'index.js');
  assert.equal(manifest.icon, './icon.svg');
  assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml');
  assert.equal(manifest.dependencies ?? undefined, undefined);
  assert.equal(manifest.devDependencies ?? undefined, undefined);
  assert.equal(manifest.peerDependencies ?? undefined, undefined);
});

test('源码只 import node: 内置模块与仓库内文件', () => {
  for (const file of sourceFiles()) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(/from\s+'([^']+)'/g)) {
      const specifier = match[1];
      assert.ok(
        specifier.startsWith('node:') || specifier.startsWith('../') || specifier.startsWith('./'),
        `${file} 引用了非内置模块：${specifier}`,
      );
    }
  }
});

test('§10 P0.7（静态半）：不写 ~/.ouroboros、不启动 MCP', () => {
  for (const file of sourceFiles()) {
    const text = readFileSync(file, 'utf8');
    assert.equal(text.includes('~/.ouroboros'), false, `${file} 提到 ~/.ouroboros`);
    assert.equal(text.includes('ouroboros.db'), false, `${file} 提到 ouroboros.db`);
    assert.equal(/mcp\s+serve/i.test(text), false, `${file} 提到 mcp serve`);
    assert.equal(text.includes('os.homedir'), false, `${file} 读取 homedir`);
  }
});
