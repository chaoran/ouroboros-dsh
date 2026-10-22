import test from 'node:test';
import assert from 'node:assert/strict';

import { runConfined } from '../tools/shared.js';

function fakeHandle(options = {}) {
  const state = {
    terminateCalls: 0,
    waitForExitCalls: 0,
    doneResolve: null,
  };
  const done = new Promise((resolve) => {
    state.doneResolve = resolve;
  });
  const handle = {
    collected: {
      stdout: { readFrom: () => ({ text: options.stdout ?? '', nextOffset: 0, lossy: false }) },
      stderr: { readFrom: () => ({ text: options.stderr ?? '', nextOffset: 0, lossy: false }) },
    },
    done,
    terminate() {
      state.terminateCalls += 1;
      if (options.resolveOnTerminate === true) state.doneResolve({ exitCode: null, signal: 'SIGTERM' });
    },
    async waitForExit() {
      state.waitForExitCalls += 1;
      return true;
    },
  };
  return { handle, state };
}

function fakeContext(spawn) {
  return {
    get(name) {
      return name === 'subprocess' ? { spawn } : undefined;
    },
  };
}

test('runConfined：正常完成时返回退出事实，不 terminate，且 signal 未 abort', async () => {
  const { handle, state } = fakeHandle({ stdout: 'ok' });
  let spawnSignal;
  const ctx = fakeContext((spec) => {
    spawnSignal = spec.signal;
    return handle;
  });
  const pending = runConfined(ctx, {
    argv: ['node', '--version'],
    cwd: '/tmp',
    policy: { mode: 'danger-full-access' },
    timeoutMs: 60_000,
  });
  await Promise.resolve();
  state.doneResolve({ exitCode: 0, signal: null });
  const result = await pending;
  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
  assert.deepEqual(result.sandbox, { mode: 'danger-full-access', enforcement: 'none' });
  assert.equal(result.stdout, 'ok');
  assert.equal(state.terminateCalls, 0);
  assert.equal(state.waitForExitCalls, 1);
  assert.equal(spawnSignal.aborted, false);
});

test('P1-A：exec.signal abort 传到 spawn signal 并调用 terminate，等 waitForExit 收敛', async () => {
  const { handle, state } = fakeHandle({ resolveOnTerminate: true });
  let spawnSignal;
  const ctx = fakeContext((spec) => {
    spawnSignal = spec.signal;
    return handle;
  });
  const controller = new AbortController();
  const pending = runConfined(ctx, {
    argv: ['node', '--test', 'test/'],
    cwd: '/tmp',
    policy: { mode: 'danger-full-access' },
    timeoutMs: 60_000,
    signal: controller.signal,
  });
  // Attach the settlement handler before aborting so the expected rejection is
  // never observed as an unhandled promise rejection.
  const settled = pending.then(
    (value) => ({ ok: true, value }),
    (error) => ({ ok: false, error }),
  );

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(spawnSignal.aborted, false, '未 abort 前不应终止子进程');
  assert.equal(state.terminateCalls, 0);

  controller.abort();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(spawnSignal.aborted, true, 'abort 后 spawn 拿到的 signal 必须已 aborted');
  assert.equal(state.terminateCalls >= 1, true, 'abort 后必须真的调用 terminate()');
  assert.equal(state.waitForExitCalls >= 1, true, '必须等子进程收敛（waitForExit）');
  const outcome = await settled;
  assert.equal(outcome.ok, false);
  assert.match(outcome.error.message, /已取消/);
});

test('P1-A：pre-aborted signal 不启动进程', async () => {
  let spawnCalls = 0;
  let handleRef;
  const ctx = fakeContext(() => {
    spawnCalls += 1;
    handleRef = fakeHandle().handle;
    return handleRef;
  });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () =>
      runConfined(ctx, {
        argv: ['node', '--version'],
        cwd: '/tmp',
        policy: { mode: 'danger-full-access' },
        timeoutMs: 60_000,
        signal: controller.signal,
      }),
    /已取消/,
  );
  assert.equal(spawnCalls, 0);
  assert.equal(handleRef, undefined);
});

test('runConfined：超时会 terminate 并标记 timedOut', async () => {
  const { handle, state } = fakeHandle({ resolveOnTerminate: true });
  const ctx = fakeContext(() => handle);
  const result = await runConfined(ctx, {
    argv: ['node', 'slow.js'],
    cwd: '/tmp',
    policy: { mode: 'danger-full-access' },
    timeoutMs: 20,
  });
  assert.equal(result.timedOut, true);
  assert.equal(state.terminateCalls >= 1, true);
  assert.equal(state.waitForExitCalls, 1);
});
