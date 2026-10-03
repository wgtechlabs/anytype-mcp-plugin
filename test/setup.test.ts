import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseEnv } from 'node:util';

test('gateway setup replaces empty secrets, protects the file, and preserves existing settings', () => {
  const script = resolve('scripts/setup-gateway.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'anytype-env-'));
  try {
    const file = join(dir, '.env');
    writeFileSync(file, 'MCP_TOKEN=""\nOWNER_TOKEN=\nREAD_ONLY=true\n');
    execFileSync(process.execPath, [script], { cwd: dir });
    const before = readFileSync(file, 'utf8');
    const env = parseEnv(before);
    assert((env.MCP_TOKEN?.length ?? 0) >= 32);
    assert.notEqual(env.MCP_TOKEN, env.OWNER_TOKEN);
    assert.equal(env.READ_ONLY, 'true');
    execFileSync(process.execPath, [script], { cwd: dir });
    assert.equal(readFileSync(file, 'utf8'), before);
    assert.equal(statSync(file).mode & 0o777, 0o600);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Anytype setup fills an empty API key and preserves rotated keys and denied space access', () => {
  const script = resolve('scripts/bootstrap-anytype.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'anytype-bootstrap-'));
  const file = join(dir, '.env');
  const hook = `
    globalThis.fetch = async (url, options) => {
      if (url !== 'http://127.0.0.1:31012/v1/spaces' || options.method !== 'GET') throw Error('Setup must not mutate with empty allowed spaces.');
      if (options.headers.Authorization !== 'Bearer ' + process.env.TEST_EXPECTED_KEY) throw Error('Unexpected API key.');
      return new Response(JSON.stringify({data: []}), {status: 200});
    };
  `;
  const env = { ...process.env };
  for (const key of ['ANYTYPE_API_KEY', 'ANYTYPE_ALLOWED_SPACES', 'ANYTYPE_INVITE_LINK', 'READ_ONLY']) delete env[key];
  const hookFile = join(dir, 'fetch-hook.mjs');
  writeFileSync(hookFile, hook);
  const run = (expected: string) => execFileSync(process.execPath, ['--import', hookFile, script, dir, file], {
    env: { ...env, TEST_EXPECTED_KEY: expected }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  try {
    // An existing private key is supplied as the script's regular file fallback.
    const generated = 'generated-test-key';
    const fallback = join(dir, 'secrets');
    mkdirSync(fallback);
    writeFileSync(join(fallback, 'api-key.txt'), generated);
    writeFileSync(file, readFileSync(resolve('.env.example'), 'utf8') + '\nANYTYPE_ALLOWED_SPACES=\n');
    run(generated);
    const initialized = readFileSync(file, 'utf8');
    assert.equal(parseEnv(initialized).ANYTYPE_API_KEY, generated);
    assert.equal(parseEnv(initialized).ANYTYPE_ALLOWED_SPACES, '');
    assert.equal(parseEnv(initialized).READ_ONLY, 'true');
    run(generated);
    assert.equal(readFileSync(file, 'utf8'), initialized);
    writeFileSync(file, 'ANYTYPE_API_KEY=rotated-test-key\nANYTYPE_ALLOWED_SPACES=\nREAD_ONLY=false\n');
    run('rotated-test-key');
    assert.equal(parseEnv(readFileSync(file, 'utf8')).ANYTYPE_API_KEY, 'rotated-test-key');
    assert.equal(parseEnv(readFileSync(file, 'utf8')).ANYTYPE_ALLOWED_SPACES, '');
    assert.equal(parseEnv(readFileSync(file, 'utf8')).READ_ONLY, 'false');
    assert.equal(statSync(file).mode & 0o777, 0o600);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

for (const scenario of [
  { name: 'creates a sandbox and welcome note', spaceExists: false, noteExists: false },
  { name: 'reuses the sandbox and creates its missing welcome note', spaceExists: true, noteExists: false },
  { name: 'reuses the sandbox and existing welcome note', spaceExists: true, noteExists: true },
]) {
  test(`Anytype setup ${scenario.name} without an invite or allowlist`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'anytype-sandbox-'));
    const file = join(dir, '.env');
    const stateFile = join(dir, 'mock-api.json');
    const hookFile = join(dir, 'fetch-hook.mjs');
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (key.startsWith('ANYTYPE_') || key === 'READ_ONLY' || key === 'NODE_OPTIONS') delete env[key];
    }
    try {
      mkdirSync(join(dir, 'secrets'));
      writeFileSync(join(dir, 'secrets/api-key.txt'), 'sandbox-test-key');
      writeFileSync(stateFile, JSON.stringify({ ...scenario, calls: [] }));
      writeFileSync(hookFile, `
        import assert from 'node:assert/strict';
        import { readFileSync, writeFileSync } from 'node:fs';
        globalThis.fetch = async (url, options) => {
          const state = JSON.parse(readFileSync(process.env.TEST_STATE_FILE, 'utf8'));
          const parsed = new URL(url);
          assert.equal(parsed.origin, 'http://127.0.0.1:31012');
          assert.equal(options.headers.Authorization, 'Bearer sandbox-test-key');
          const request = options.method + ' ' + parsed.pathname;
          const body = options.body ? JSON.parse(options.body) : undefined;
          const space = { id: 'sandbox-test.space', name: 'Anytype MCP Sandbox' };
          const note = { id: 'welcome-test.object', name: 'MCP welcome note' };
          let result;
          switch (request) {
            case 'GET /v1/spaces':
              result = { data: [{ id: 'unrelated.space', name: 'Unrelated space' }, ...(state.spaceExists ? [space] : [])] };
              break;
            case 'POST /v1/spaces':
              assert.equal(state.spaceExists, false, 'Do not create a duplicate sandbox');
              assert.equal(body.name, space.name);
              state.spaceExists = true;
              result = { space };
              break;
            case 'POST /v1/spaces/sandbox-test.space/search':
              assert.equal(state.spaceExists, true);
              assert.equal(body.query, note.name);
              result = { data: state.noteExists ? [note] : [] };
              break;
            case 'POST /v1/spaces/sandbox-test.space/objects':
              assert.equal(state.spaceExists, true);
              assert.equal(state.noteExists, false, 'Do not create a duplicate welcome note');
              assert.equal(body.name, note.name);
              assert.equal(body.type_key, 'page');
              assert(body.body.length > 0);
              state.noteExists = true;
              result = { object: note };
              break;
            default: throw Error('Unexpected request: ' + request);
          }
          state.calls.push(request);
          writeFileSync(process.env.TEST_STATE_FILE, JSON.stringify(state));
          return new Response(JSON.stringify(result), { status: 200 });
        };
      `);
      const run = () => execFileSync(process.execPath, ['--import', hookFile, resolve('scripts/bootstrap-anytype.mjs'), dir, file], {
        env: { ...env, TEST_STATE_FILE: stateFile }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      });
      assert(!run().includes('sandbox-test-key'));
      const initialized = readFileSync(file, 'utf8');
      assert.deepEqual(parseEnv(initialized), {
        ANYTYPE_API_URL: 'http://127.0.0.1:31012', ANYTYPE_API_KEY: 'sandbox-test-key',
        READ_ONLY: 'true', ANYTYPE_ALLOWED_SPACES: 'sandbox-test.space',
      });
      assert.equal(statSync(file).mode & 0o777, 0o600);
      const expectedCalls = [
        'GET /v1/spaces',
        ...(scenario.spaceExists ? [] : ['POST /v1/spaces']),
        'POST /v1/spaces/sandbox-test.space/search',
        ...(scenario.noteExists ? [] : ['POST /v1/spaces/sandbox-test.space/objects']),
      ];
      assert.deepEqual(JSON.parse(readFileSync(stateFile, 'utf8')).calls, expectedCalls);
      run();
      assert.equal(readFileSync(file, 'utf8'), initialized);
      assert.deepEqual(JSON.parse(readFileSync(stateFile, 'utf8')).calls, [...expectedCalls, 'GET /v1/spaces']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}
