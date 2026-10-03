import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { parseEnv } from 'node:util';

const bootstrap = resolve('scripts/bootstrap-anytype.mjs');
const cid = 'bafybeia' + 'a'.repeat(51);
const nextCid = 'bafybeia' + 'b'.repeat(50) + 'a';
const key = 'lock-fixture-invite-key';
const apiKey = 'lock-fixture-api-key';
const invitation = (value: string) => 'anytype://invite/?' + new URLSearchParams({ cid: value, key });
const fingerprint = (value: string) => createHash('sha256').update(JSON.stringify([value, key])).digest('hex');
const options = { timeout: 15_000, skip: process.platform === 'win32' };

async function waitForFile(file: string) {
  const deadline = Date.now() + 5_000;
  while (!existsSync(file)) {
    assert(Date.now() < deadline, 'Subprocess must reach the fixture barrier');
    await delay(10);
  }
}

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'anytype-bootstrap-lock-'));
  const envFile = join(root, 'gateway.env');
  const stateFile = join(root, 'secrets/invite-state.json');
  const lock = join(root, 'bootstrap.lock');
  const fetchLog = join(root, 'fetch-calls.txt');
  const joinLog = join(root, 'join-calls.txt');
  const hook = join(root, 'fetch-hook.mjs');
  const binary = join(root, 'fake-anytype');
  mkdirSync(join(root, 'secrets'));
  writeFileSync(join(root, 'secrets/api-key.txt'), apiKey, { mode: 0o600 });
  writeFileSync(envFile, 'CUSTOM_SETTING=preserved\n', { mode: 0o600 });
  writeFileSync(hook, `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import { setTimeout as delay } from 'node:timers/promises';
    globalThis.fetch = async (url, init = {}) => {
      assert.equal(init.headers.Authorization, 'Bearer ${apiKey}');
      assert.equal(init.method || 'GET', 'GET');
      fs.appendFileSync(process.env.TEST_FETCH_LOG, process.env.TEST_WORKER + '\\n');
      if (url === 'http://127.0.0.1:31012/v1/spaces') {
        fs.writeFileSync(process.env.TEST_API_READY, 'ready');
        const deadline = Date.now() + 8_000;
        while (process.env.TEST_HOLD_API === 'true' && !fs.existsSync(process.env.TEST_API_RELEASE)) {
          assert(Date.now() < deadline, 'API barrier timeout');
          await delay(10);
        }
        return new Response(JSON.stringify({ data: [] }));
      }
      assert.equal(url, 'http://127.0.0.1:31012/v1/spaces/' + process.env.TEST_TARGET);
      return new Response('{}');
    };
  `);
  writeFileSync(binary, `#!${process.execPath}
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    const args = process.argv.slice(2);
    assert.deepEqual(args.slice(0, 3), ['--no-update-check', 'space', 'join']);
    assert.equal(args.at(-1), 'anytype://invite/?' + new URLSearchParams({ cid: process.env.TEST_CID, key: '${key}' }));
    fs.appendFileSync(process.env.TEST_JOIN_LOG, process.env.TEST_WORKER + '\\n');
    fs.writeFileSync(process.env.TEST_CLI_READY, 'ready');
    if (process.env.TEST_JOIN_MODE === 'hold') {
      const deadline = Date.now() + 8_000;
      while (Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      process.exit(2);
    }
    if (process.env.TEST_JOIN_MODE === 'fail') process.exit(1);
    console.log("✓ Successfully sent join request to space '" + process.env.TEST_TARGET + "'");
  `, { mode: 0o700 });
  const baseEnv = { ...process.env };
  for (const name of Object.keys(baseEnv)) {
    if (name.startsWith('ANYTYPE_') || name === 'READ_ONLY' || name === 'NODE_OPTIONS') delete baseEnv[name];
  }
  const active: { kill: () => void; done: Promise<unknown> }[] = [];
  t.after(async () => {
    for (const child of active) child.kill();
    await Promise.allSettled(active.map(child => child.done));
    rmSync(root, { recursive: true, force: true });
  });
  function start(worker: string, extra: NodeJS.ProcessEnv = {}, validate = false) {
    const child = spawn(process.execPath, ['--import', hook, bootstrap, root, envFile, ...(validate ? ['--validate-invite'] : [])], {
      detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...baseEnv, PATH: dirname(process.execPath) + ':' + (baseEnv.PATH ?? ''),
        ANYTYPE_BINARY: binary, ANYTYPE_INVITE_LINK: invitation(cid),
        TEST_FETCH_LOG: fetchLog, TEST_JOIN_LOG: joinLog, TEST_WORKER: worker,
        TEST_API_READY: join(root, worker + '.api-ready'), TEST_API_RELEASE: join(root, worker + '.api-release'),
        TEST_CLI_READY: join(root, worker + '.cli-ready'), TEST_CID: cid, TEST_TARGET: 'lock-a.space', ...extra,
      },
    });
    const pid = child.pid;
    assert(pid, 'Bootstrap process must start');
    let output = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { output += data; });
    const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null; output: string }>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => {
        resolve({ code, signal, output });
      });
    }).then(result => {
      assert(!result.output.includes(key) && !result.output.includes(apiKey), 'Public output must not contain fixture secrets');
      return result;
    });
    const kill = () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      try { process.kill(-pid, 'SIGKILL'); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    };
    active.push({ kill, done });
    return { done, kill, release: () => writeFileSync(join(root, worker + '.api-release'), 'release') };
  }
  const contents = (file: string) => existsSync(file) ? readFileSync(file, 'utf8') : '';
  const snapshot = () => ({ env: contents(envFile), state: contents(stateFile), fetches: contents(fetchLog), joins: contents(joinLog) });
  const attempts = () => JSON.parse(readFileSync(stateFile, 'utf8')).attempts;
  const settings = () => parseEnv(readFileSync(envFile, 'utf8'));
  function assertPrivateConfig(target: string) {
    assert.equal(settings().ANYTYPE_ALLOWED_SPACES, target);
    assert.equal(settings().READ_ONLY, 'true');
    assert.equal(settings().ANYTYPE_API_KEY, apiKey);
    assert.equal(settings().CUSTOM_SETTING, 'preserved');
    for (const file of [envFile, stateFile]) assert.equal(statSync(file).mode & 0o777, 0o600);
    assert(!contents(stateFile).includes(key));
    assert.equal(existsSync(lock), false);
  }
  return { root, lock, start, snapshot, attempts, assertPrivateConfig };
}

for (const distinct of [false, true]) {
  test(`overlapping ${distinct ? 'distinct' : 'identical'} invitations cannot bypass the bootstrap lock`, options, async t => {
    const f = fixture(t);
    const owner = f.start('owner', { TEST_HOLD_API: 'true' });
    await waitForFile(join(f.root, 'owner.api-ready'));
    const before = f.snapshot();
    const next = distinct ? { ANYTYPE_INVITE_LINK: invitation(nextCid), TEST_CID: nextCid, TEST_TARGET: 'lock-b.space' } : {};
    const contender = await f.start('contender', next).done;
    assert.equal(contender.code, 1, 'A concurrent setup must fail before any API call or join');
    assert.match(contender.output, /Unable to acquire bootstrap lock/);
    assert.deepEqual(f.snapshot(), before, 'The contender must not change configuration, history, or API activity');
    assert.equal(statSync(f.lock).mode & 0o777, 0o700, 'The contender must leave the owner’s private lock intact');
    owner.release();
    assert.equal((await owner.done).code, 0);
    f.assertPrivateConfig('lock-a.space');
    assert.deepEqual(f.attempts(), { [fingerprint(cid)]: 'lock-a.space' });
    assert.equal((await f.start('retry', next).done).code, 0);
    f.assertPrivateConfig(distinct ? 'lock-b.space' : 'lock-a.space');
    assert.deepEqual(f.attempts(), {
      [fingerprint(cid)]: 'lock-a.space', ...(distinct ? { [fingerprint(nextCid)]: 'lock-b.space' } : {}),
    });
    assert.equal(f.snapshot().joins, distinct ? 'owner\nretry\n' : 'owner\n');
  });
}

test('no-invite setup and validation contenders also preserve the active lock', options, async t => {
  const f = fixture(t);
  const owner = f.start('owner', { TEST_HOLD_API: 'true' });
  await waitForFile(join(f.root, 'owner.api-ready'));
  const before = f.snapshot();
  for (const validate of [false, true]) {
    const contender = await f.start('contender-' + validate, { ANYTYPE_INVITE_LINK: '' }, validate).done;
    assert.equal(contender.code, 1);
    assert.match(contender.output, /Unable to acquire bootstrap lock/);
    assert.deepEqual(f.snapshot(), before);
    assert.equal(existsSync(f.lock), true);
  }
  owner.release();
  assert.equal((await owner.done).code, 0);
  f.assertPrivateConfig('lock-a.space');
  const initialized = f.snapshot();
  assert.equal((await f.start('validation', {}, true).done).code, 0);
  assert.deepEqual(f.snapshot(), initialized);
  assert.equal(existsSync(f.lock), false, 'Successful validation must also release its lock');
});

test('a hard-killed owner leaves its lock and uncertain invitation history for explicit recovery', options, async t => {
  const f = fixture(t);
  const owner = f.start('owner', { TEST_JOIN_MODE: 'hold' });
  await waitForFile(join(f.root, 'owner.cli-ready'));
  assert.deepEqual(f.attempts(), { [fingerprint(cid)]: null });
  owner.kill();
  assert.equal((await owner.done).signal, 'SIGKILL');
  const before = f.snapshot();
  const blocked = await f.start('blocked').done;
  assert.equal(blocked.code, 1);
  assert.match(blocked.output, /Unable to acquire bootstrap lock/);
  assert.deepEqual(f.snapshot(), before, 'A dead owner must not trigger automatic lock reclamation');
  assert.equal(statSync(f.lock).mode & 0o777, 0o700);
  // All fixture processes using this runtime have stopped; remove only the lock.
  rmSync(f.lock, { recursive: true });
  const recovered = await f.start('recovered').done;
  assert.equal(recovered.code, 1);
  assert.match(recovered.output, /previous invitation attempt has an uncertain outcome/);
  assert.equal(f.snapshot().state, before.state);
  assert.equal(f.snapshot().env, before.env);
  assert.equal(f.snapshot().joins, 'owner\n', 'Manual recovery must not repeat the uncertain join');
  assert.equal(existsSync(f.lock), false, 'Handled uncertainty must release the acquired lock');
});

test('handled join failure releases the lock while preserving the uncertain attempt', options, async t => {
  const f = fixture(t);
  const failed = await f.start('failed', { TEST_JOIN_MODE: 'fail' }).done;
  assert.equal(failed.code, 1);
  assert.match(failed.output, /Unable to complete the invitation attempt/);
  assert.equal(existsSync(f.lock), false);
  assert.deepEqual(f.attempts(), { [fingerprint(cid)]: null });
  const retry = await f.start('retry').done;
  assert.equal(retry.code, 1);
  assert.match(retry.output, /previous invitation attempt has an uncertain outcome/);
  assert.equal(f.snapshot().joins, 'failed\n');
  assert.equal(existsSync(f.lock), false);
});
