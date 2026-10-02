import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { test, type TestContext } from 'node:test';
import express from 'express';
import { installAuth } from '../src/auth.js';
import { Gateway, result } from '../src/gateway.js';

const mcpToken = 'm'.repeat(48);
const ownerToken = 'o'.repeat(48);
const callback = 'https://client.example/oauth/callback';

async function setup(t: TestContext, accessTokenTtlSeconds = 3600) {
  const app = express();
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close((error) => error ? reject(error) : resolve()); }));
  const address = server.address();
  assert(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const auth = installAuth(app, { issuerUrl: base, mcpToken, ownerToken, oauthRedirectUris: [callback, 'http://127.0.0.1:4444/callback'], accessTokenTtlSeconds });
  app.get('/mcp', auth.requireMcpAuth, (_req, res) => res.json({ principal: res.locals.principal }));
  const request = (path: string, init?: RequestInit) => fetch(base + path, { ...init, redirect: 'manual' });
  const form = (path: string, body: Record<string, string>, headers: Record<string, string> = {}) => request(path, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(body),
  });
  async function register(redirect = callback) {
    const response = await request('/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      client_name: 'Test client', redirect_uris: [redirect], token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
    }) });
    assert.equal(response.status, 201);
    return await response.json() as { client_id: string };
  }
  async function authorize(clientId: string, overrides: Record<string, string> = {}) {
    const verifier = randomBytes(32).toString('base64url');
    const response = await request('/authorize?' + new URLSearchParams({
      client_id: clientId, response_type: 'code', redirect_uri: callback, state: 'client-state',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
      resource: base + '/mcp', scope: 'anytype', ...overrides,
    }));
    const body = await response.text();
    const consent = /name="consent" value="([^"]+)"/.exec(body)?.[1] ?? '';
    const cookie = response.headers.get('set-cookie')?.split(';')[0] ?? '';
    return { verifier, response, body, consent, cookie };
  }
  async function grant(clientId: string) {
    const flow = await authorize(clientId);
    assert.equal(flow.response.status, 200);
    const consentResponse = await form('/oauth/consent', { consent: flow.consent, decision: 'allow', owner_token: ownerToken }, { Origin: base, Cookie: flow.cookie });
    assert.equal(consentResponse.status, 303);
    const redirect = new URL(consentResponse.headers.get('location')!);
    assert.equal(redirect.searchParams.get('state'), 'client-state');
    assert.equal(redirect.origin + redirect.pathname, callback);
    return { code: redirect.searchParams.get('code')!, verifier: flow.verifier };
  }
  function exchange(clientId: string, code: string, verifier: string, overrides: Record<string, string> = {}) {
    return form('/token', { grant_type: 'authorization_code', client_id: clientId, code, code_verifier: verifier, redirect_uri: callback, resource: base + '/mcp', ...overrides });
  }
  return { request, form, register, authorize, grant, exchange, base };
}

test('MCP credentials and owner credentials remain separate; discovery binds the resource', async (t) => {
  const { request, base } = await setup(t);
  const missing = await request('/mcp');
  assert.equal(missing.status, 401);
  assert.match(missing.headers.get('www-authenticate')!, /oauth-protected-resource\/mcp/);
  assert.equal((await request('/mcp', { headers: { Authorization: `Bearer ${ownerToken}` } })).status, 401);
  assert.equal((await request('/mcp?token=' + mcpToken)).status, 401);
  assert.equal((await request('/mcp', { headers: { Authorization: `Bearer ${mcpToken} trailing` } })).status, 401);
  const accepted = await request('/mcp', { headers: { Authorization: `Bearer ${mcpToken}` } });
  assert.deepEqual(await accepted.json(), { principal: 'owner' });
  const discovery = await (await request('/.well-known/oauth-protected-resource/mcp')).json();
  assert.equal(discovery.resource, base + '/mcp');
  assert.deepEqual(discovery.authorization_servers, [base + '/']);
  const metadata = await (await request('/.well-known/oauth-authorization-server')).json();
  assert.deepEqual(metadata.code_challenge_methods_supported, ['S256']);
  assert.equal(metadata.registration_endpoint, base + '/register');
});

test('OAuth flow enforces PKCE, client, audience, callback, one-use codes, refresh rotation and revocation', async (t) => {
  const { request, form, register, grant, exchange, base } = await setup(t);
  const client = await register();
  const otherClient = await register();
  const { code, verifier } = await grant(client.client_id);
  assert.equal((await exchange(otherClient.client_id, code, verifier)).status, 400);
  assert.equal((await exchange(client.client_id, code, 'incorrect-verifier')).status, 400);
  assert.equal((await exchange(client.client_id, code, verifier, { resource: 'https://other.example/mcp' })).status, 400);
  assert.equal((await exchange(client.client_id, code, verifier, { redirect_uri: callback + '?other=1' })).status, 400);
  const response = await exchange(client.client_id, code, verifier);
  assert.equal(response.status, 200);
  const tokens = await response.json();
  assert.equal((await exchange(client.client_id, code, verifier)).status, 400);
  assert.equal((await request('/mcp', { headers: { Authorization: `Bearer ${tokens.access_token}` } })).status, 200);
  assert.equal((await request('/mcp', { headers: { Authorization: `Bearer ${tokens.refresh_token}` } })).status, 401);
  const refreshed = await form('/token', { grant_type: 'refresh_token', client_id: client.client_id, refresh_token: tokens.refresh_token, resource: base + '/mcp' });
  assert.equal(refreshed.status, 200);
  const next = await refreshed.json();
  assert.notEqual(next.refresh_token, tokens.refresh_token);
  assert.equal((await request('/mcp', { headers: { Authorization: `Bearer ${next.access_token}` } })).status, 200);
  assert.equal((await form('/token', { grant_type: 'refresh_token', client_id: client.client_id, refresh_token: tokens.refresh_token, resource: base + '/mcp' })).status, 400);
  assert.equal((await request('/mcp', { headers: { Authorization: `Bearer ${next.access_token}` } })).status, 401);
  const secondGrant = await grant(client.client_id);
  const second = await (await exchange(client.client_id, secondGrant.code, secondGrant.verifier)).json();
  assert.equal((await form('/revoke', { client_id: client.client_id, token: second.access_token })).status, 200);
  assert.equal((await request('/mcp', { headers: { Authorization: `Bearer ${second.access_token}` } })).status, 401);
});

test('verified OAuth client identity isolates proposals and remains stable through refresh', async (t) => {
  const { request, form, register, grant, exchange, base } = await setup(t);
  async function connectClient() {
    const client = await register();
    const authorization = await grant(client.client_id);
    const response = await exchange(client.client_id, authorization.code, authorization.verifier);
    assert.equal(response.status, 200);
    return { ...client, ...await response.json() };
  }
  async function principal(token: string): Promise<string> {
    const response = await request('/mcp', { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(response.status, 200);
    return (await response.json()).principal;
  }
  const first = await connectClient();
  const second = await connectClient();
  const firstPrincipal = await principal(first.access_token);
  const secondPrincipal = await principal(second.access_token);
  assert.equal(firstPrincipal, `oauth:${first.client_id}`);
  assert.equal(secondPrincipal, `oauth:${second.client_id}`);
  assert.notEqual(firstPrincipal, secondPrincipal);
  assert.notEqual(firstPrincipal, await principal(mcpToken));
  const refreshed = await form('/token', { grant_type: 'refresh_token', client_id: first.client_id, refresh_token: first.refresh_token, resource: base + '/mcp' });
  assert.equal(refreshed.status, 200);
  const refreshedPrincipal = await principal((await refreshed.json()).access_token);
  assert.equal(refreshedPrincipal, firstPrincipal);

  let writes = 0;
  const gateway = new Gateway({
    tools: ['API-get-object', 'API-update-object'].map(name => ({ name, inputSchema: {
      type: 'object', properties: { space_id: { type: 'string' }, object_id: { type: 'string' }, name: { type: 'string' } }, required: ['space_id', 'object_id'],
    } })),
    async call(name) { if (name === 'API-update-object') writes++; return result({ object: { id: 'object1', name: 'Original' } }); },
  }, { allowedSpaces: new Set(['approved']), readOnly: false, apiVersion: 'v1' });
  const preview = await gateway.call('API-update-object', { space_id: 'approved', object_id: 'object1', name: 'Reviewed' }, firstPrincipal);
  assert(!preview.isError);
  const applyArgs = { proposal_id: preview.structuredContent!.proposal_id, confirmed: true };
  for (const otherPrincipal of [secondPrincipal, await principal(mcpToken)]) {
    const denied = await gateway.call('apply_change', applyArgs, otherPrincipal);
    assert.equal(denied.isError, true);
    assert.equal((denied.structuredContent!.error as { code: string }).code, 'proposal_expired');
  }
  assert.equal(writes, 0);
  assert.equal((await gateway.call('apply_change', applyArgs, refreshedPrincipal)).structuredContent!.applied, true);
  assert.equal(writes, 1);
});

test('callbacks are exact allowlist entries and consent requires origin, browser binding and owner secret', async (t) => {
  const { request, form, register, authorize, base } = await setup(t);
  const deniedRegistration = await request('/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['https://attacker.example/callback'], token_endpoint_auth_method: 'none' }) });
  assert.equal(deniedRegistration.status, 400);
  const loopback = await register('http://127.0.0.1:4444/callback');
  const relaxed = await authorize(loopback.client_id, { redirect_uri: 'http://127.0.0.1:5555/callback' });
  assert.equal(relaxed.response.status, 400);
  assert.equal(relaxed.response.headers.get('location'), null);
  const client = await register();
  const flow = await authorize(client.client_id);
  assert(!flow.body.includes(ownerToken));
  assert.match(flow.response.headers.get('content-security-policy')!, /frame-ancestors 'none'/);
  const submission = { consent: flow.consent, decision: 'allow', owner_token: ownerToken };
  assert.equal((await form('/oauth/consent', submission, { Origin: 'https://attacker.example', Cookie: flow.cookie })).status, 403);
  assert.equal((await form('/oauth/consent', submission, { Origin: base })).status, 403);
  assert.equal((await form('/oauth/consent', { ...submission, owner_token: mcpToken }, { Origin: base, Cookie: flow.cookie })).status, 403);
  assert.equal((await form('/oauth/consent', submission, { Origin: base, Cookie: flow.cookie })).status, 403);
  const rejected = await authorize(client.client_id, { resource: 'https://attacker.example/mcp' });
  assert.equal(new URL(rejected.response.headers.get('location')!).searchParams.get('error'), 'invalid_target');
  const scope = await authorize(client.client_id, { scope: 'admin' });
  assert.equal(new URL(scope.response.headers.get('location')!).searchParams.get('error'), 'invalid_scope');
  const plain = await authorize(client.client_id, { code_challenge_method: 'plain' });
  assert.equal(new URL(plain.response.headers.get('location')!).searchParams.get('error'), 'invalid_request');
  assert.equal((await request('/oauth/consent', { method: 'POST', headers: { Origin: base } })).status, 403);
});

test('authorization codes and OAuth access tokens expire', async (t) => {
  const { register, grant, exchange, request } = await setup(t, 1);
  const client = await register();
  const expiredGrant = await grant(client.client_id);
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  t.mock.timers.tick(61_000);
  assert.equal((await exchange(client.client_id, expiredGrant.code, expiredGrant.verifier)).status, 400);
  const fresh = await grant(client.client_id);
  const tokens = await (await exchange(client.client_id, fresh.code, fresh.verifier)).json();
  assert.equal((await request('/mcp', { headers: { Authorization: `Bearer ${tokens.access_token}` } })).status, 200);
  t.mock.timers.tick(2_000);
  assert.equal((await request('/mcp', { headers: { Authorization: `Bearer ${tokens.access_token}` } })).status, 401);
});
