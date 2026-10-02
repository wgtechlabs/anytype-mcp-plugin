// Explicit integration test. Writes only to the dedicated sandbox, never a personal space.
import assert from 'node:assert/strict';
import { readConfig } from '../dist/src/config.js';
import { connectUpstream } from '../dist/src/upstream.js';
import { createApp } from '../dist/src/server.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

assert(process.argv.includes('--sandbox'), 'Pass --sandbox to authorize isolated test writes.');
const config = readConfig({ ...process.env, READ_ONLY: 'false', PORT: '31015', HOST: '127.0.0.1', PUBLIC_URL: 'http://127.0.0.1:31015' });
assert.equal(config.allowedSpaces.size, 1, 'This test requires exactly one approved test space.');
const upstream = await connectUpstream(config);
const server = createApp(config, upstream).listen(config.port, config.host);
await new Promise(resolve => server.once('listening', resolve));
const client = new Client({ name: 'anytype-sandbox-writes', version: '0.1.0' });
try {
 await client.connect(new StreamableHTTPClientTransport(new URL(config.publicUrl + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${config.mcpToken}` } } }));
 async function call(name, args = {}) {
  const response = await client.callTool({ name, arguments: args });
  if (response.isError) throw Error(`${name}: ${JSON.stringify(response.structuredContent)}`);
  return response.structuredContent;
 }
 const { data: spaces } = await call('API-list-spaces');
 assert.equal(spaces[0].name, 'Anytype MCP Sandbox', 'Refusing writes outside the dedicated sandbox.');
 const space_id = spaces[0].id;
 const suffix = Date.now().toString(36);
 async function mutate(name, args) {
  const proposal = await call(name, { space_id, ...args });
  assert.equal(proposal.dry_run, true);
  const result = await call('apply_change', { proposal_id: proposal.proposal_id, confirmed: true });
  assert.equal(result.applied, true);
  const replay = await client.callTool({ name: 'apply_change', arguments: { proposal_id: proposal.proposal_id, confirmed: true } });
  assert(replay.isError);
  return result;
 }
 const created = await mutate('API-create-object', { type_key: 'page', name: `MCP verification ${suffix}`, body: 'Original test content.' });
 const object_id = created.object?.id ?? created.id;
 assert(object_id, 'Create must return object ID.');
 await mutate('API-update-object', { object_id, markdown: 'Verified update through authenticated MCP.' });
 const read = await call('API-get-object', { space_id, object_id });
 assert(JSON.stringify(read).includes('Verified update through authenticated MCP.'));
 const duplicate = await client.callTool({ name: 'API-create-object', arguments: { space_id, type_key: 'page', name: `MCP verification ${suffix}` } });
 assert(duplicate.isError);
 const property = await mutate('API-create-property', { name: `MCP status ${suffix}`, format: 'select' });
 const property_id = property.property?.id ?? property.id;
 assert(property_id);
 const tag = await mutate('API-create-tag', { property_id, name: `Ready ${suffix}`, color: 'lime' });
 const tag_id = tag.tag?.id ?? tag.id;
 assert(tag_id);
 await mutate('API-update-tag', { property_id, tag_id, name: `Verified ${suffix}` });
 await mutate('API-update-property', { property_id, name: `MCP verified status ${suffix}` });
 const type = await mutate('API-create-type', { name: `MCP record ${suffix}`, plural_name: `MCP records ${suffix}`, layout: 'basic' });
 const type_id = type.type?.id ?? type.id;
 assert(type_id);
 await mutate('API-update-type', { type_id, name: `MCP verified record ${suffix}` });
 const types = await call('API-list-types', { space_id, limit: 100 });
 const taskType = types.data.find(type => type.key === 'task');
 assert(taskType, 'Task type should exist in the sandbox.');
 const task = await mutate('API-create-object', { type_key: taskType.key, name: `MCP task ${suffix}`, body: 'A task created through the MCP plugin.' });
 const taskId = task.object?.id ?? task.id;
 await mutate('API-update-object', { object_id: taskId, properties: [{ key: 'done', checkbox: true }] });
 const taskRead = await call('API-get-object', { space_id, object_id: taskId });
 assert(taskRead.object?.properties?.some(property => property.key === 'done' && property.checkbox === true), 'Task completion should persist.');
 const templates = await call('API-list-templates', { space_id, type_id: taskType.id });
 assert(Array.isArray(templates.data));
 console.log(JSON.stringify({ result: 'PASS', checks: ['dry-run before mutation', 'create/read/update notes', 'duplicate rejection', 'single-use confirmation', 'properties and tags', 'types', 'task creation and completion', 'template listing'], sandbox_only: true }));
} finally {
 await client.close();
 await upstream.close();
 server.closeAllConnections();
 await new Promise(resolve => server.close(resolve));
}
