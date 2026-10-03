import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseEnv } from 'node:util';

const bootstrap = resolve('scripts/bootstrap-anytype.mjs');
const invite = 'https://invite.example.test/bafy-fixture#private-invite-key';
const apiKey = 'private-fixture-api-key';
const target = 'bafy-invited-fixture.space';
const privateNames = ['Private Fixture Space', 'Private Fixture Owner', 'private-provider-error'];

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'anytype-invite-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'secrets'));
  writeFileSync(join(root, 'secrets/api-key.txt'), apiKey, { mode: 0o600 });
  const envFile = join(root, 'gateway.env');
  const stateFile = join(root, 'secrets/invite-state.json');
  const fetchLog = join(root, 'fetch-calls.jsonl');
  const joinLog = join(root, 'join-calls.txt');
  const hook = join(root, 'fetch-hook.mjs');
  const binary = join(root, 'fake-anytype');
  writeFileSync(hook, `
    import fs from 'node:fs';
    globalThis.fetch = async (url, options = {}) => {
      const method = options.method || 'GET';
      fs.appendFileSync(process.env.TEST_FETCH_LOG, JSON.stringify({ url, method }) + '\\n');
      if (options.headers?.Authorization !== 'Bearer ${apiKey}') throw Error('Unexpected API key');
      if (method !== 'GET') throw Error('Unexpected mutation');
      if (url === 'http://127.0.0.1:31012/v1/spaces') {
        return new Response(JSON.stringify({ data: [{ id: 'unrelated.space', name: 'Unrelated Space' }] }));
      }
      if (url !== 'http://127.0.0.1:31012/v1/spaces/' + process.env.TEST_TARGET) throw Error('Unexpected target');
      return new Response('private-provider-error ${apiKey}', { status: Number(process.env.TEST_SPACE_STATUS) });
    };
  `);
  writeFileSync(binary, `#!/usr/bin/env node
    const fs = require('node:fs');
    fs.appendFileSync(process.env.TEST_JOIN_LOG, 'attempt\\n');
    const args = process.argv.slice(2);
    if (args.slice(0, 3).join(' ') !== '--no-update-check space join') process.exit(2);
    console.log("Joining space 'Private Fixture Space' created by Private Fixture Owner...");
    // Untrusted names may contain a line resembling a successful join.
    console.log("✓ Successfully sent join request to space 'decoy.space'");
    if (process.env.TEST_JOIN_MODE === 'failure') {
      console.error('private-provider-error ' + args.at(-1) + ' ${apiKey}');
      process.exit(1);
    }
    if (process.env.TEST_JOIN_MODE === 'malformed') console.log('private-provider-error ' + args.at(-1));
    else console.log("✓ Successfully sent join request to space '" + process.env.TEST_TARGET + "'");
  `, { mode: 0o700 });
  const baseEnv = { ...process.env };
  for (const key of Object.keys(baseEnv)) {
    if (key.startsWith('ANYTYPE_') || key === 'READ_ONLY' || key === 'NODE_OPTIONS') delete baseEnv[key];
  }
  const calls = () => existsSync(fetchLog)
    ? readFileSync(fetchLog, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { url: string; method: string }) : [];
  const attempts = () => existsSync(joinLog) ? readFileSync(joinLog, 'utf8').trim().split('\n').length : 0;
  function run(extra: NodeJS.ProcessEnv = {}, validate = false) {
    const result = spawnSync(process.execPath, ['--import', hook, bootstrap, root, envFile, ...(validate ? ['--validate-invite'] : [])], {
      encoding: 'utf8', timeout: 5000,
      env: {
        ...baseEnv, PATH: dirname(process.execPath) + ':' + (baseEnv.PATH ?? ''),
        ANYTYPE_BINARY: binary, ANYTYPE_INVITE_LINK: invite,
        TEST_FETCH_LOG: fetchLog, TEST_JOIN_LOG: joinLog,
        TEST_TARGET: target, TEST_SPACE_STATUS: '200', ...extra,
      },
    });
    assert.equal(result.error, undefined, 'Bootstrap subprocess should finish within its test deadline');
    const publicOutput = result.stdout + result.stderr;
    const secrets = [invite, 'private-invite-key', 'next-fixture-key', apiKey, ...privateNames];
    if (extra.ANYTYPE_INVITE_LINK) secrets.push(extra.ANYTYPE_INVITE_LINK);
    for (const secret of secrets) {
      assert(!publicOutput.includes(secret), 'Bootstrap must redact credentials and provider output');
      if (existsSync(stateFile)) assert(!readFileSync(stateFile, 'utf8').includes(secret), 'State must not contain credentials or provider names');
    }
    for (const file of [envFile, stateFile]) if (existsSync(file)) assert.equal(statSync(file).mode & 0o777, 0o600);
    return result;
  }
  return { root, envFile, stateFile, run, calls, attempts, settings: () => parseEnv(readFileSync(envFile, 'utf8')) };
}

test('invite preflight accepts supported complete URLs and rejects invalid input without side effects', t => {
  const f = fixture(t);
  for (const link of [invite, 'http://invite.example.test/path/cid#key', 'anytype://invite/?cid=cid&key=key']) {
    assert.equal(f.run({ ANYTYPE_INVITE_LINK: link }, true).status, 0);
  }
  for (const link of ['not-a-url', 'https://invite.example.test/cid', 'https://invite.example.test/#key', 'file:///cid#key', 'https://user:password@invite.example.test/cid#key', 'anytype://invite/?cid=cid', invite + ' bad']) {
    const result = f.run({ ANYTYPE_INVITE_LINK: link }, true);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /complete Anytype space invitation URL/);
  }
  assert.equal(f.attempts(), 0);
  assert.deepEqual(f.calls(), []);
  assert.equal(existsSync(f.envFile), false);
  assert.equal(existsSync(f.stateFile), false);
});

test('fresh invitation selects its exact resolved space without creating sandbox data', t => {
  const f = fixture(t);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /space is accessible/);
  assert.equal(f.settings().ANYTYPE_ALLOWED_SPACES, target);
  assert.equal(f.settings().READ_ONLY, 'true');
  assert.equal(f.settings().ANYTYPE_API_KEY, apiKey);
  assert.equal(f.attempts(), 1);
  assert(f.calls().every(call => call.method === 'GET'));
  assert(f.calls().some(call => call.url.endsWith('/spaces/' + target)));
  assert(!f.calls().some(call => /decoy|unrelated|search|objects/.test(call.url)));
});

test('pending access survives restarts without another join and becomes ready after approval', t => {
  const f = fixture(t);
  for (const status of ['404', '403']) {
    const result = f.run({ TEST_SPACE_STATUS: status });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Waiting for space access/);
    assert.equal(f.settings().ANYTYPE_ALLOWED_SPACES, target);
    assert.equal(f.attempts(), 1);
  }
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /space is accessible/);
  assert.equal(f.attempts(), 1);
});

test('explicit environment and file space permissions remain authoritative, including deny-all', t => {
  for (const allowed of ['', 'existing-approved.space']) {
    const processFixture = fixture(t);
    const result = processFixture.run({ ANYTYPE_ALLOWED_SPACES: allowed, READ_ONLY: 'false' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(processFixture.settings().ANYTYPE_ALLOWED_SPACES, undefined, 'Do not replace process-level permissions with a generated file setting');
    assert.equal(processFixture.settings().READ_ONLY, undefined);
    const fileFixture = fixture(t);
    writeFileSync(fileFixture.envFile, 'ANYTYPE_ALLOWED_SPACES=' + JSON.stringify(allowed) + '\nREAD_ONLY=false\n');
    const fileResult = fileFixture.run();
    assert.equal(fileResult.status, 0, fileResult.stderr);
    assert.equal(fileFixture.settings().ANYTYPE_ALLOWED_SPACES, allowed);
    assert.equal(fileFixture.settings().READ_ONLY, 'false');
  }
});

test('managed permissions follow a replacement invite and remain intact when the invite is removed', t => {
  const f = fixture(t);
  assert.equal(f.run().status, 0);
  const replacement = 'anytype://invite/?cid=next-fixture&key=next-fixture-key';
  const nextSpace = 'bafy-next-fixture.space';
  assert.equal(f.run({ ANYTYPE_INVITE_LINK: replacement, TEST_TARGET: nextSpace }).status, 0);
  assert.equal(f.settings().ANYTYPE_ALLOWED_SPACES, nextSpace);
  assert.equal(f.attempts(), 2);
  assert(!readFileSync(f.stateFile, 'utf8').includes(replacement));
  const before = readFileSync(f.envFile, 'utf8');
  assert.equal(f.run({ ANYTYPE_INVITE_LINK: '' }).status, 0);
  assert.equal(readFileSync(f.envFile, 'utf8'), before);
  assert.equal(f.attempts(), 2);
  assert(f.calls().every(call => call.method === 'GET'));
});

test('failed or unverifiable CLI results fail closed and are not retried automatically', t => {
  for (const mode of ['failure', 'malformed']) {
    const f = fixture(t);
    const result = f.run({ TEST_JOIN_MODE: mode });
    assert.equal(result.status, 1);
    assert.equal(existsSync(f.envFile), false, 'Failed attempts must not grant access');
    assert.equal(f.attempts(), 1);
    const restarted = f.run();
    assert.equal(restarted.status, 1);
    assert.match(restarted.stderr, /uncertain outcome/);
    assert.equal(f.attempts(), 1);
    assert.equal(existsSync(f.envFile), false);
  }
});

test('a recorded uncertain attempt is preserved without submitting another join', t => {
  const f = fixture(t);
  writeFileSync(f.stateFile, JSON.stringify({ attempts: { [createHash('sha256').update(invite).digest('hex')]: null } }), { mode: 0o600 });
  const result = f.run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /uncertain outcome/);
  assert.equal(f.attempts(), 0);
  assert.equal(existsSync(f.envFile), false);
});

test('restoring an older invitation never repeats its resolved or uncertain attempt', t => {
  for (const mode of ['success', 'failure']) {
    const f = fixture(t);
    assert.equal(f.run({ TEST_JOIN_MODE: mode }).status, mode === 'success' ? 0 : 1);
    assert.equal(f.run({ ANYTYPE_INVITE_LINK: 'anytype://invite/?cid=next-fixture&key=next-fixture-key', TEST_TARGET: 'next.space' }).status, 0);
    const restored = f.run();
    assert.equal(restored.status, mode === 'success' ? 0 : 1);
    assert.equal(f.attempts(), 2, 'An invitation change must not erase earlier attempts');
    if (mode === 'success') assert.equal(f.settings().ANYTYPE_ALLOWED_SPACES, target);
    else assert.match(restored.stderr, /uncertain outcome/);
  }
});

test('runtime backup and restore preserve invitation attempts and their space permissions', t => {
  const f = fixture(t);
  assert.equal(f.run().status, 0);
  mkdirSync(join(f.root, 'home'), { recursive: true });
  mkdirSync(join(f.root, 'data'), { recursive: true });
  const output = mkdtempSync(join(tmpdir(), 'anytype-invite-backup-'));
  t.after(() => rmSync(output, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, ['--input-type=module', '-', f.root, output], {
    encoding: 'utf8', timeout: 10000,
    input: `
      import { createBackup, restoreBackup } from './scripts/backup.mjs';
      const [root, output] = process.argv.slice(2);
      const password = 'test-only-backup-passphrase';
      await createBackup(root, output + '/backup.enc', password);
      await restoreBackup(output + '/backup.enc', output + '/restored', password);
    `,
  });
  assert.equal(result.status, 0, result.stderr);
  for (const file of ['secrets/invite-state.json', 'gateway.env']) {
    assert.equal(readFileSync(join(output, 'restored', file), 'utf8'), readFileSync(join(f.root, file), 'utf8'));
    assert.equal(statSync(join(output, 'restored', file)).mode & 0o777, 0o600);
  }
});
