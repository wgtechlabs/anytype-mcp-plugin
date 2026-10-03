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
