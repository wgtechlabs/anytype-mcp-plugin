import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const url = new URL('/mcp', process.env.PUBLIC_URL || 'http://127.0.0.1:31013');
assert(process.env.MCP_TOKEN, 'Set MCP_TOKEN in the environment.');
const client = new Client({ name: 'anytype-mcp-smoke', version: '0.1.0' });
try {
  const denied = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(denied.status, 401, 'Unauthenticated MCP must reject requests.');
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${process.env.MCP_TOKEN}` } } }));
  const { tools } = await client.listTools();
  for (const name of ['API-list-spaces', 'API-search-space', 'API-get-object', 'apply_change']) assert(tools.some(tool => tool.name === name), `Missing ${name}`);
  async function call(name, args = {}) {
    const response = await client.callTool({ name, arguments: args });
    assert(!response.isError, `${name} failed; inspect the structured error privately.`);
    return response.structuredContent || JSON.parse(response.content[0].text);
  }
  const spaces = await call('API-list-spaces');
  assert(spaces.data.length, 'Configure at least one approved space.');
  const space = spaces.data[0];
  const objects = await call('API-search-space', { space_id: space.id, query: '', limit: 10 });
  assert(Array.isArray(objects.data));
  if (objects.data.length) {
    const object = await call('API-get-object', { space_id: space.id, object_id: objects.data[0].id });
    assert(object._gateway?.revision);
  }
  const outside = await client.callTool({ name: 'API-search-space', arguments: { space_id: 'not-approved', query: '' } });
  assert(outside.isError);
  for (const name of ['API-list-types', 'API-list-properties']) assert(Array.isArray((await call(name, { space_id: space.id, limit: 10 })).data));
  const invalid = await client.callTool({ name: 'API-get-object', arguments: { space_id: space.id, object_id: '../auth' } });
  assert(invalid.isError);
  console.log(JSON.stringify({ result: 'PASS', checks: ['authentication', 'MCP discovery', 'approved-space listing', 'search', 'read', 'types', 'properties', 'scope rejection', 'identifier validation'], tools: tools.length, read_only: spaces.read_only }));
} finally { await client.close(); }
