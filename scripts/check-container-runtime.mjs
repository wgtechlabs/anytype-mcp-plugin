#!/usr/bin/env node
// Uses only a prebuilt local image, disposable volumes, and a fake Anytype API.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const image = process.argv[2];
if (!image || image.startsWith('-') || process.argv.length !== 3) throw Error('Usage: node scripts/check-container-runtime.mjs LOCAL_IMAGE');
const fixture = fileURLToPath(new URL('../test/fixtures/container-anytype.mjs', import.meta.url));
const prefix = 'anytype-runtime-check-' + randomUUID();
const containers = [], volumes = [];
function docker(args, input, allowFailure = false) {
  const result = spawnSync('docker', args, { input, encoding: 'utf8', timeout: 60_000, maxBuffer: 2 * 1024 * 1024 });
  if (!allowFailure) assert.equal(result.status, 0, `Docker ${args[0]} failed: ${result.stderr || result.error?.message}`);
  return result;
}
const execute = (name, code) => docker(['exec', '-i', '--user', 'node', name, 'node', '--input-type=module'], code).stdout.trim();
const inspect = name => JSON.parse(docker(['inspect', name]).stdout)[0];
const imageInfo = JSON.parse(docker(['image', 'inspect', image]).stdout)[0];
assert(['node', '1000', '1000:1000', 'node:node'].includes(imageInfo.Config.User), 'Image must default to the node user');
const health = imageInfo.Config.Healthcheck?.Test;
assert(health && ['CMD', 'CMD-SHELL'].includes(health[0]), 'Image must define a real healthcheck');
const healthCommand = health[0] === 'CMD' ? health.slice(1) : ['sh', '-c', health[1]];
function request(name, path, body, authenticated = false) {
  return JSON.parse(execute(name, `
    const response = await fetch('http://127.0.0.1:' + process.env.PORT + ${JSON.stringify(path)}, {
      method: ${body ? "'POST'" : "'GET'"}, redirect: 'manual', signal: AbortSignal.timeout(6000),
      headers: { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json', 'MCP-Protocol-Version': '2025-03-26',
        ...(${authenticated} ? { Authorization: 'Bearer ' + process.env.MCP_TOKEN } : {}) },
      body: ${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'},
    });
    console.log(JSON.stringify({ status: response.status, body: await response.text() }));
  `));
}
function rpc(name, method, params = {}) {
  const response = request(name, '/mcp', { jsonrpc: '2.0', id: 1, method, params }, true);
  assert.equal(response.status, 200);
  const message = JSON.parse(response.body); assert(!message.error, JSON.stringify(message));
  return message.result;
}
async function ready(name) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (!inspect(name).State.Running) {
      const logs = docker(['logs', name]);
      throw Error('Container exited before readiness: ' + (logs.stdout + logs.stderr).replace(/[a-f0-9]{64}|container-fixture-api-key/g, '[redacted]'));
    }
    const probe = docker(['exec', '--user', 'node', name, ...healthCommand], undefined, true);
    if (probe.status === 0) return;
    await delay(250);
  }
  throw Error('Container did not become healthy before the test deadline');
}
try {
  for (const rootOwned of [false, true]) {
    const name = prefix + (rootOwned ? '-railway' : '-nonroot'), volume = name + '-data';
    volumes.push(volume); docker(['volume', 'create', volume]);
    if (rootOwned) docker(['run', '--rm', '--pull', 'never', '--network', 'none', '--user', '0', '--entrypoint', 'node', '-v', volume + ':/data', image,
      '-e', "require('node:fs').chownSync('/data',0,0);require('node:fs').chmodSync('/data',0o700)"]);
    const token = randomBytes(32).toString('hex'), owner = randomBytes(32).toString('hex');
    containers.push(name);
    docker(['run', '-d', '--pull', 'never', '--name', name, '--network', 'none', ...(rootOwned ? ['--user', '0'] : []),
      '-v', volume + ':/data', '--mount', `type=bind,src=${fixture},dst=/opt/anytype/bin/anytype,readonly`,
      '-e', 'NODE_ENV=production', '-e', 'PUBLIC_URL=https://container.invalid', '-e', 'READ_ONLY=true',
      '-e', 'PORT=' + (rootOwned ? '32123' : '31013'), '-e', 'MCP_TOKEN=' + token, '-e', 'OWNER_TOKEN=' + owner, image]);
    await ready(name);
    const identity = execute(name, `
      import assert from 'node:assert/strict'; import fs from 'node:fs';
      const processes = fs.readdirSync('/proc').filter(id => /^\\d+$/.test(id)).flatMap(id => {
        try { return [{ id, status: fs.readFileSync('/proc/' + id + '/status', 'utf8'), command: fs.readFileSync('/proc/' + id + '/cmdline', 'utf8').replaceAll('\\0', ' ') }]; }
        catch { return []; }
      });
      for (const match of [p => p.id === '1', p => p.command.includes('dist/src/index.js'), p => p.command.includes('/opt/anytype/bin/anytype serve'), p => p.command.includes('dist/upstream.mjs')]) {
        const process = processes.find(match); assert(process, 'Expected runtime process is missing');
        assert(process.status.match(/^Uid:\\s+(.*)$/m)[1].trim().split(/\\s+/).every(uid => uid === '1000'), 'Runtime UIDs must all be non-root');
        assert.match(process.status, /^CapEff:\\s+0+$/m);
        if (${rootOwned}) assert.match(process.status, /^NoNewPrivs:\\s+1$/m);
      }
      assert.match(processes.find(p => p.id === '1').command, /tini/);
      for (const path of ['/data/gateway.env', '/data/secrets/api-key.txt', '/data/secrets/account-recovery.txt']) {
        const stat = fs.statSync(path); assert.equal(stat.uid, 1000); assert.equal(stat.mode & 0o777, 0o600);
      }
      const stat = fs.statSync('/data'); assert.equal(stat.uid, 1000); assert.equal(stat.mode & 0o777, 0o700);
      const state = JSON.parse(fs.readFileSync('/data/data/fixture-state.json')); assert.equal(state.spaces.length, 1); assert.equal(state.notes.length, 1);
      console.log(state.accountId);
    `);
    assert.equal(request(name, '/healthz').status, 200);
    assert.equal(request(name, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' }).status, 401);
    rpc(name, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'container-check', version: '1' } });
    const tools = rpc(name, 'tools/list').tools;
    const list = tools.find(tool => tool.name === 'API-list-spaces'); assert(list);
    const read = rpc(name, 'tools/call', { name: list.name, arguments: {} });
    assert.equal(read.structuredContent.read_only, true);
    assert.equal(read.structuredContent.data[0].id, 'fixture-sandbox.space');
    const denied = rpc(name, 'tools/call', { name: 'apply_change', arguments: { proposal_id: 'fixture', confirmed: true } });
    assert.equal(denied.structuredContent.error.code, 'read_only');
    for (const mode of ['unavailable', 'redirect', 'timeout']) {
      execute(name, `import fs from 'node:fs'; fs.writeFileSync('/data/data/fixture-health', ${JSON.stringify(mode)});`);
      assert.equal(request(name, '/healthz').status, 503, mode);
      assert.notEqual(docker(['exec', '--user', 'node', name, ...healthCommand], undefined, true).status, 0, mode);
    }
    execute(name, "import fs from 'node:fs'; fs.rmSync('/data/data/fixture-health');");
    await ready(name);
    docker(['restart', '--time', '15', name]); await ready(name);
    assert.equal(execute(name, "import fs from 'node:fs'; console.log(JSON.parse(fs.readFileSync('/data/data/fixture-state.json')).accountId);"), identity);
    docker(['exec', '--user', 'node', name, 'node', 'scripts/backup.mjs', '--self-test']);
    docker(['stop', '--time', '15', name]);
    const state = inspect(name).State;
    const logs = docker(['logs', name]);
    assert.equal(state.ExitCode, 0, 'SIGTERM must stop cleanly, without forced termination: ' +
      (logs.stdout + logs.stderr).replace(/[a-f0-9]{64}|container-fixture-api-key/g, '[redacted]'));
    docker(['run', '--rm', '--pull', 'never', '--network', 'none', '--user', 'node', '--entrypoint', 'node', '-v', volume + ':/data', image, '--input-type=module', '-e', `
      import fs from 'node:fs'; import assert from 'node:assert/strict'; import { spawn, spawnSync } from 'node:child_process'; import { once } from 'node:events';
      const pidFile = '/data/anytype.pid'; assert(!fs.existsSync(pidFile));
      assert.equal(fs.readFileSync('/data/data/fixture-stops.txt', 'utf8'), 'stopped\\nstopped\\n');
      const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      await once(unrelated, 'spawn');
      try {
        fs.writeFileSync(pidFile, String(unrelated.pid), { mode: 0o600 });
        const refused = spawnSync('/app/scripts/anytype.sh', ['stop'], { encoding: 'utf8', env: {
          ...process.env, ANYTYPE_RUNTIME_DIR: '/data', ANYTYPE_BINARY: '/opt/anytype/bin/anytype',
        } });
        assert.equal(refused.status, 1); assert.match(refused.stderr, /Runtime PID belongs to another process/);
        await new Promise(resolve => setTimeout(resolve, 50));
        assert.equal(unrelated.exitCode, null); assert.equal(unrelated.signalCode, null);
        process.kill(unrelated.pid, 0);
      } finally {
        if (unrelated.exitCode === null && unrelated.signalCode === null) {
          const exited = once(unrelated, 'exit'); unrelated.kill('SIGTERM'); await exited;
        }
        fs.rmSync(pidFile, { force: true });
      }
    `]);
    for (const secret of [token, owner, 'container-fixture-api-key']) assert(!(logs.stdout + logs.stderr).includes(secret));
    console.log(`${rootOwned ? 'Railway root-owned volume' : 'Default non-root volume'}: startup, process privileges, health, auth, read-only, restart, backup, and shutdown passed.`);
  }
} finally {
  const failed = [];
  for (const name of containers) if (docker(['rm', '-f', name], undefined, true).status !== 0) failed.push(name);
  for (const name of volumes) if (docker(['volume', 'rm', name], undefined, true).status !== 0) failed.push(name);
  assert.equal(failed.length, 0, 'Unable to remove owned disposable resources: ' + failed.join(', '));
}
console.log('Disposable fixtures removed. This check does not validate the real Anytype binary, sync network, or Railway hosting.');
