import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs';
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
