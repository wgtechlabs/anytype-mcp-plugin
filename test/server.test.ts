import assert from 'node:assert/strict';
import { createServer, request as httpRequest, type Server as HttpServer } from 'node:http';
import { test, type TestContext } from 'node:test';
import { LATEST_PROTOCOL_VERSION, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { readConfig } from '../src/config.js';
import { createApp } from '../src/server.js';
import { result } from '../src/gateway.js';
import type { Upstream } from '../src/upstream.js';

const credentials = { MCP_TOKEN: 'm'.repeat(48), OWNER_TOKEN: 'o'.repeat(48), ANYTYPE_API_KEY: 'private-api-key' };
const tools: Tool[] = [
  { name: 'API-list-spaces', inputSchema: { type: 'object', properties: {} } },
  { name: 'API-get-space', inputSchema: { type: 'object', properties: { space_id: { type: 'string' } }, required: ['space_id'] } },
  { name: 'API-get-object', inputSchema: { type: 'object', properties: { space_id: { type: 'string' }, object_id: { type: 'string' } }, required: ['space_id', 'object_id'] } },
  { name: 'API-update-object', inputSchema: { type: 'object', properties: { space_id: { type: 'string' }, object_id: { type: 'string' }, name: { type: 'string' } }, required: ['space_id', 'object_id'] } },
];

async function listen(t: TestContext, server: HttpServer) {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()); }));
  const address = server.address();
  assert(address && typeof address !== 'string');
  return { port: address.port, url: `http://127.0.0.1:${address.port}` };
}
async function setup(t: TestContext, allowedSpaces = 'approved') {
  const apiRequests: { path?: string; authorization?: string }[] = [];
  const apiState = { status: 200 };
  const api = await listen(t, createServer((req, res) => {
    apiRequests.push({ path: req.url, authorization: req.headers.authorization });
    res.writeHead(apiState.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [], detail: 'private-api-key private-document-content' }));
  }));
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const upstream: Upstream = { tools, async call(name, args) {
    calls.push({ name, args });
    if (name === 'API-get-space') return result({ space: { id: args.space_id, name: 'Approved' } });
    if (name === 'API-get-object') return result({ object: { id: args.object_id, name: 'Original', body: 'Document content' } });
    throw Error('Unexpected upstream mutation');
  } };
  const server = createServer();
  const http = await listen(t, server);
  const config = readConfig({ ...credentials, PUBLIC_URL: http.url, PORT: String(http.port), ANYTYPE_API_URL: api.url, ANYTYPE_ALLOWED_SPACES: allowedSpaces });
  server.on('request', createApp(config, upstream));
  const request = (path: string, init?: RequestInit) => fetch(http.url + path, { ...init, redirect: 'manual' });
  let id = 0;
  const rpc = (method: string, params: Record<string, unknown> = {}) => request('/mcp', {
    method: 'POST', headers: { Authorization: `Bearer ${credentials.MCP_TOKEN}`, Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json', 'MCP-Protocol-Version': LATEST_PROTOCOL_VERSION },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
  });
  async function call(name: string, args: Record<string, unknown> = {}) {
    const response = await rpc('tools/call', { name, arguments: args });
    assert.equal(response.status, 200);
    const message = await response.json();
    assert(!message.error, JSON.stringify(message));
    return message.result as { isError?: boolean; structuredContent: Record<string, unknown> };
  }
  return { request, rpc, call, config, calls, apiState, apiRequests, base: http.url };
}

test('configuration defaults fail closed and reject unsafe transport and secret settings', () => {
  const config = readConfig(credentials);
  assert.equal(config.readOnly, true);
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.allowedSpaces.size, 0);
  for (const override of [
    { MCP_TOKEN: credentials.OWNER_TOKEN }, { OWNER_TOKEN: ' '.repeat(40) }, { MCP_TOKEN: 'x'.repeat(257) },
    { PUBLIC_URL: 'http://public.example' }, { PUBLIC_URL: 'http://[::1]:31013' }, { HOST: '0.0.0.0' },
    { ANYTYPE_API_URL: 'http://public.example' }, { ANYTYPE_API_URL: 'https://user:password@api.example' },
    { ANYTYPE_API_URL: 'https://api.example/unexpected/path' }, { ANYTYPE_API_VERSION: 'v2' },
  ]) assert.throws(() => readConfig({ ...credentials, ...override }));
  assert.equal(readConfig({ ...credentials, HOST: '0.0.0.0', ALLOW_INSECURE_HTTP: 'true' }).host, '0.0.0.0');
  assert.equal(readConfig({ ...credentials, ANYTYPE_API_URL: 'http://[::1]:31012' }).apiUrl, 'http://[::1]:31012');
  assert.equal(readConfig({ ...credentials, ANYTYPE_API_VERSION: 'v2', ENABLE_EXPERIMENTAL_V2: 'true' }).apiVersion, 'v2');
});

test('Railway probe hostname is accepted only for GET healthz and preserves origin checks', async (t) => {
  const { base, apiState } = await setup(t);
  const probe = (path: string, method = 'GET', origin?: string) => new Promise<number | undefined>((resolve, reject) => {
    httpRequest(base + path, { method, headers: { Host: 'healthcheck.railway.app', ...(origin ? { Origin: origin } : {}) } }, response => {
      response.resume(); resolve(response.statusCode);
    }).on('error', reject).end();
  });
  assert.equal(await probe('/healthz'), 200);
  assert.equal(await probe('/mcp'), 403);
  assert.equal(await probe('/authorize'), 403);
  assert.equal(await probe('/healthz', 'POST'), 403);
  assert.equal(await probe('/healthz', 'GET', 'https://attacker.example'), 403);
  apiState.status = 401;
  assert.equal(await probe('/healthz'), 503);
});

test('HTTP protects host, origin, credentials and parsing; health reports no private upstream details', async (t) => {
  const { request, apiRequests, apiState, base } = await setup(t);
  assert.equal((await request('/mcp', { method: 'POST' })).status, 401);
  assert.equal((await request('/mcp', { headers: { Authorization: `Bearer ${credentials.OWNER_TOKEN}` } })).status, 401);
  const auth = { Authorization: `Bearer ${credentials.MCP_TOKEN}` };
  const get = await request('/mcp', { headers: auth });
  assert.equal(get.status, 405);
  assert.equal(get.headers.get('allow'), 'POST');
  const forgedHostStatus = await new Promise<number | undefined>((resolve, reject) => {
    httpRequest(base + '/healthz', { headers: { Host: 'attacker.example' } }, response => {
      response.resume(); resolve(response.statusCode);
    }).on('error', reject).end();
  });
  assert.equal(forgedHostStatus, 403);
  assert.equal((await request('/mcp', { method: 'POST', headers: { ...auth, Origin: 'https://attacker.example' } })).status, 403);
  const malformed = await request('/mcp', { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: '{"private-document-content":' });
  assert.equal(malformed.status, 400);
  assert.deepEqual(await malformed.json(), { error: 'invalid_request' });
  const oversized = await request('/mcp', { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ content: 'x'.repeat(513 * 1024) }) });
  assert.equal(oversized.status, 413);
  assert.deepEqual(await oversized.json(), { error: 'request_too_large' });
  const metadata = await (await request('/.well-known/oauth-protected-resource/mcp')).json();
  assert.equal(metadata.resource, base + '/mcp');
  assert.deepEqual(await (await request('/healthz')).json(), { status: 'ok' });
  assert.deepEqual(apiRequests, [{ path: '/v1/spaces?limit=1', authorization: 'Bearer private-api-key' }]);
  apiState.status = 401;
  const unhealthy = await request('/healthz');
  assert.equal(unhealthy.status, 503);
  assert.deepEqual(await unhealthy.json(), { status: 'unavailable' });
});

test('real MCP HTTP initializes, discovers tools, reads and previews while read-only blocks application', async (t) => {
  const { rpc, call, calls } = await setup(t);
  const initialized = await rpc('initialize', { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'test-client', version: '1.0.0' } });
  assert.equal(initialized.status, 200);
  const init = await initialized.json();
  assert.equal(init.result.serverInfo.name, 'anytype-mcp');
  assert.equal(initialized.headers.get('mcp-session-id'), null);
  const listed = await (await rpc('tools/list')).json();
  assert(listed.result.tools.some((item: { name: string }) => item.name === 'apply_change'));
  const spaces = await call('API-list-spaces');
  assert.deepEqual((spaces.structuredContent.data as { id: string }[]).map(item => item.id), ['approved']);
  const read = await call('API-get-object', { space_id: 'approved', object_id: 'object1' });
  assert.equal((read.structuredContent.object as { name: string }).name, 'Original');
  const preview = await call('API-update-object', { space_id: 'approved', object_id: 'object1', name: 'Reviewed name' });
  assert.equal(preview.structuredContent.dry_run, true);
  const blocked = await call('apply_change', { proposal_id: preview.structuredContent.proposal_id, confirmed: true });
  assert.equal(blocked.isError, true);
  assert.equal((blocked.structuredContent.error as { code: string }).code, 'read_only');
  assert(!calls.some(({ name }) => name === 'API-update-object'));
});

test('empty default space allowlist returns an empty listing and rejects explicit reads without crashing', async (t) => {
  const { call, calls, config } = await setup(t, '');
  assert.equal(config.allowedSpaces.size, 0);
  const listed = await call('API-list-spaces');
  assert.deepEqual(listed.structuredContent.data, []);
  assert.deepEqual(listed.structuredContent.pagination, { offset: 0, limit: 100, total: 0, has_more: false });
  const blocked = await call('API-get-space', { space_id: 'approved' });
  assert.equal(blocked.isError, true);
  assert.equal((blocked.structuredContent.error as { code: string }).code, 'space_not_allowed');
  assert.deepEqual(calls, []);
});
