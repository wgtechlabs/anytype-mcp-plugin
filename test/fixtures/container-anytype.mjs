#!/usr/bin/env node
// Disposable container fixture; never connects to Anytype or its sync network.
import fs from 'node:fs';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

const root = process.env.ANYTYPE_RUNTIME_DIR || '/data';
const stateFile = join(root, 'data/fixture-state.json');
const key = 'container-fixture-api-key';
const read = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'));
const save = state => fs.writeFileSync(stateFile, JSON.stringify(state), { mode: 0o600 });
const args = process.argv.slice(2);
if (args[0] === 'version') {
  console.log('anytype-cli v0.4.0-security.1-dirty (container fixture)');
} else if (args[0] === 'auth' && args[1] === 'create') {
  const accountId = randomUUID();
  fs.mkdirSync(join(process.env.HOME, '.anytype'), { recursive: true });
  fs.writeFileSync(join(process.env.HOME, '.anytype/config.json'), JSON.stringify({ accountId }), { mode: 0o600 });
  save({ accountId, spaces: [], notes: [] });
  console.log('Disposable fixture account created.');
} else if (args.slice(0, 3).join(' ') === 'auth apikey create') {
  console.log('Key: ' + key);
} else if (args[0] === 'serve') {
  const response = { description: 'Fixture response', content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } };
  const api = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1:31012');
    const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (url.pathname === '/v1/docs/openapi.json') return send(200, {
      openapi: '3.0.3', info: { title: 'Container fixture', version: '1.0.0' }, servers: [{ url: 'http://127.0.0.1:31012' }],
      paths: {
        '/v1/spaces': { get: { operationId: 'list_spaces', responses: { 200: response } } },
        '/v1/spaces/{space_id}': { get: { operationId: 'get_space', parameters: [{ name: 'space_id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: response } } },
      },
    });
    if (req.headers.authorization !== 'Bearer ' + key) return send(401, {});
    if (url.pathname === '/v1/spaces' && url.searchParams.has('limit')) {
      const mode = fs.existsSync(join(root, 'data/fixture-health')) ? fs.readFileSync(join(root, 'data/fixture-health'), 'utf8') : '';
      if (mode === 'timeout') return;
      if (mode === 'redirect') { res.writeHead(302, { Location: '/v1/spaces' }); return res.end(); }
      if (mode === 'unavailable') return send(503, {});
    }
    const state = read();
    let body = '';
    for await (const chunk of req) body += chunk;
    const input = body ? JSON.parse(body) : {};
    if (url.pathname === '/v1/spaces' && req.method === 'GET') return send(200, { data: state.spaces });
    if (url.pathname === '/v1/spaces' && req.method === 'POST') {
      const space = { id: 'fixture-sandbox.space', name: input.name };
      state.spaces.push(space); save(state); return send(200, { space });
    }
    if (url.pathname === '/v1/spaces/fixture-sandbox.space/search') return send(200, { data: state.notes });
    if (url.pathname === '/v1/spaces/fixture-sandbox.space/objects' && req.method === 'POST') {
      const object = { id: 'fixture-welcome.object', ...input };
      state.notes.push(object); save(state); return send(200, { object });
    }
    if (url.pathname === '/v1/spaces/fixture-sandbox.space') return send(200, { space: state.spaces[0] });
    send(404, {});
  });
  const control = createServer((_req, res) => res.end('fixture'));
  api.listen(31012, '127.0.0.1');
  control.listen(31010, '127.0.0.1');
  process.once('SIGTERM', () => {
    fs.appendFileSync(join(root, 'data/fixture-stops.txt'), 'stopped\n', { mode: 0o600 });
    api.closeAllConnections(); control.closeAllConnections();
    api.close(() => control.close(() => process.exit(0)));
  });
} else {
  console.error('Unsupported fixture command');
  process.exitCode = 1;
}
