import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { readConfig } from '../src/config.js';
import { connectUpstream } from '../src/upstream.js';

test('official worker close notifies only on an unexpected exit', { timeout: 15_000, skip: process.platform === 'win32' }, async (t) => {
  let base = '';
  const apiCalls: string[] = [];
  const api = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/v1/docs/openapi.json') {
      res.end(JSON.stringify({
        openapi: '3.0.3', info: { title: 'Test Anytype API', version: '1.0.0' }, servers: [{ url: base }],
        paths: { '/v1/spaces': { get: { operationId: 'list_spaces', responses: { 200: { description: 'Spaces', content: {
          'application/json': { schema: { type: 'object', properties: { data: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' } } } } } } },
        } } } } } },
      }));
      return;
    }
    apiCalls.push(req.url ?? '');
    assert.equal(req.headers.authorization, 'Bearer test-api-key');
    assert.equal(req.url, '/v1/spaces');
    res.end(JSON.stringify({ data: [] }));
  });
  await new Promise<void>(resolve => api.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve, reject) => { api.closeAllConnections(); api.close(error => error ? reject(error) : resolve()); }));
  const address = api.address();
  assert(address && typeof address !== 'string');
  base = `http://127.0.0.1:${address.port}`;
  const config = readConfig({ ANYTYPE_API_URL: base, ANYTYPE_API_KEY: 'test-api-key', MCP_TOKEN: 'm'.repeat(48), OWNER_TOKEN: 'o'.repeat(48), REQUEST_TIMEOUT_MS: '5000' });

  let expectedCloseNotifications = 0;
  const intentional = await connectUpstream(config, () => { expectedCloseNotifications++; });
  t.after(() => intentional.close());
  assert(intentional.tools.some(tool => tool.name === 'API-list-spaces'));
  const response = await intentional.call('API-list-spaces', {});
  assert(!response.isError);
  assert.deepEqual(apiCalls, ['/v1/spaces']);
  await intentional.close();
  assert.equal(expectedCloseNotifications, 0);

  let disconnected!: () => void;
  let unexpectedCloseNotifications = 0;
  const closed = new Promise<void>(resolve => { disconnected = resolve; });
  const unexpected = await connectUpstream(config, () => { unexpectedCloseNotifications++; disconnected(); });
  t.after(() => unexpected.close());
  const workerPath = resolve('dist/upstream.mjs');
  const { stdout } = await promisify(execFile)('ps', ['-axo', 'pid=,ppid=,args=']);
  const workers = stdout.split('\n').map(line => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)).filter(match =>
    match && Number(match[2]) === process.pid && match[3].includes(workerPath) && match[3].includes(base + '/v1/docs/openapi.json'));
  assert.equal(workers.length, 1, 'Only this test process’s official worker may be terminated.');
  process.kill(Number(workers[0]![1]), 'SIGTERM');
  await closed;
  assert.equal(unexpectedCloseNotifications, 1);
});
