import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import express, { type Express, type RequestHandler } from 'express';
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import type { AuthorizationParams, OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import {
  InvalidClientMetadataError, InvalidGrantError, InvalidRequestError, InvalidScopeError,
  InvalidTargetError, InvalidTokenError, TemporarilyUnavailableError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';

export type AuthConfig = {
  issuerUrl: string;
  mcpToken: string;
  ownerToken: string;
  oauthRedirectUris: string[];
  accessTokenTtlSeconds?: number;
};

type Authorization = AuthorizationParams & { clientId: string; expiresAt: number };
type Consent = Authorization & { browserSecret: string };
type Token = {
  clientId: string; grantId: string; resource: string; expiresAt: number;
  kind: 'access' | 'refresh'; consumed?: boolean;
};

const random = () => randomBytes(32).toString('base64url');
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const equal = (left: string, right: string) => timingSafeEqual(Buffer.from(digest(left)), Buffer.from(digest(right)));
const html = (value: string) => value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
const now = () => Date.now() / 1000;
const scope = 'anytype';

/** Single-owner local authorization. In-memory grants intentionally revoke on restart. */
export function installAuth(app: Express, config: AuthConfig): {
  requireMcpAuth: RequestHandler;
} {
  const issuer = new URL(config.issuerUrl);
  if (issuer.username || issuer.password || issuer.search || issuer.hash || issuer.pathname !== '/' ||
      !(issuer.protocol === 'https:' || issuer.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(issuer.hostname))) {
    throw new Error('issuerUrl must be an HTTPS origin, or HTTP localhost for local development.');
  }
  if (![config.mcpToken, config.ownerToken].every((token) => /^[\x21-\x7e]{32,256}$/.test(token)) ||
      equal(config.mcpToken, config.ownerToken)) {
    throw new Error('MCP_TOKEN and OWNER_TOKEN must be distinct secrets of 32–256 non-space ASCII characters.');
  }
  const accessTtl = config.accessTokenTtlSeconds ?? 3600;
  if (!Number.isSafeInteger(accessTtl) || accessTtl < 1 || accessTtl > 86400) throw new Error('Invalid access token lifetime.');
  const allowedRedirects = new Set(config.oauthRedirectUris);
  for (const callback of allowedRedirects) {
    const url = new URL(callback);
    if (url.username || url.password || url.hash ||
        !(url.protocol === 'https:' || url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
      throw new Error('OAuth callbacks must be exact HTTPS URLs or HTTP loopback URLs.');
    }
  }
  const resource = new URL('/mcp', issuer);
  // ponytail: bounded memory suits one local owner; use shared durable storage before running replicas.
  const clients = new Map<string, OAuthClientInformationFull>();
  const consents = new Map<string, Consent>();
  const codes = new Map<string, Authorization>();
  const tokens = new Map<string, Token>();
  const cookieName = 'anytype_oauth_consent';
  const cookieOptions = { httpOnly: true, secure: issuer.protocol === 'https:', sameSite: 'lax' as const, path: '/oauth/consent', maxAge: 300_000 };

  function prune() {
    for (const map of [consents, codes, tokens]) {
      for (const [key, item] of map) if (item.expiresAt <= now()) map.delete(key);
    }
  }
  function checkResource(requested?: URL) {
    if (requested?.href !== resource.href) throw new InvalidTargetError('The resource must match this MCP endpoint.');
  }
  function issueTokens(clientId: string, grantId: string = randomUUID()) {
    prune();
    if (tokens.size > 9998) throw new TemporarilyUnavailableError('Token capacity reached. Revoke unused connections.');
    const access = random();
    const refresh = random();
    const common = { clientId, grantId, resource: resource.href };
    tokens.set(digest(access), { ...common, kind: 'access', expiresAt: now() + accessTtl });
    tokens.set(digest(refresh), { ...common, kind: 'refresh', expiresAt: now() + 7 * 86400 });
    return { access_token: access, refresh_token: refresh, token_type: 'Bearer', expires_in: accessTtl, scope };
  }
  function revokeGrant(grantId: string) {
    for (const [key, item] of tokens) if (item.grantId === grantId) tokens.delete(key);
  }
  function readCode(clientId: string, code: string) {
    const item = codes.get(digest(code));
    if (!item || item.expiresAt <= now() || item.clientId !== clientId) throw new InvalidGrantError('Invalid or expired authorization code.');
    return item;
  }

  const provider: OAuthServerProvider = {
    clientsStore: {
      getClient: (id) => clients.get(id),
      registerClient: (metadata) => {
        if (!metadata.redirect_uris.length || metadata.redirect_uris.some((uri) => !allowedRedirects.has(uri)) ||
            !['none', 'client_secret_post'].includes(metadata.token_endpoint_auth_method ?? 'client_secret_post') ||
            metadata.grant_types?.some((grant) => !['authorization_code', 'refresh_token'].includes(grant)) ||
            metadata.response_types?.some((response) => response !== 'code') || metadata.scope && metadata.scope !== scope) {
          throw new InvalidClientMetadataError('Use allowlisted exact callbacks, authorization code PKCE, and the anytype scope.');
        }
        if (clients.size >= 128) throw new TemporarilyUnavailableError('Client capacity reached. Restart to clear local registrations.');
        const client = { ...metadata, client_id: randomUUID(), client_id_issued_at: Math.floor(now()),
          grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], scope,
          token_endpoint_auth_method: metadata.token_endpoint_auth_method ?? 'client_secret_post' };
        clients.set(client.client_id, client);
        return client;
      },
    },
    async authorize(client, params, res) {
      checkResource(params.resource);
      if (!client.redirect_uris.includes(params.redirectUri)) throw new InvalidRequestError('Unregistered redirect URI.');
      if (!/^[A-Za-z0-9_-]{43}$/.test(params.codeChallenge)) throw new InvalidRequestError('Invalid S256 challenge.');
      if (params.state && params.state.length > 1024) throw new InvalidRequestError('State is too long.');
      if (params.scopes?.some((value) => value !== scope)) throw new InvalidScopeError('Only the anytype scope is supported.');
      prune();
      if (consents.size >= 128) throw new TemporarilyUnavailableError('Too many pending consent requests.');
      const id = random();
      const browserSecret = random();
      consents.set(digest(id), { ...params, clientId: client.client_id, browserSecret: digest(browserSecret), expiresAt: now() + 300 });
      res.cookie(cookieName, browserSecret, cookieOptions);
      res.set({ 'Content-Security-Policy': "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'", 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' });
      res.type('html').send(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect Anytype</title><main><h1>Connect Anytype</h1><p>Allow ${html(client.client_name ?? 'this client')} to access your approved Anytype spaces. Writes still require explicit confirmation.</p><p>Return address: <code>${html(params.redirectUri)}</code></p><form method="post" action="/oauth/consent"><input type="hidden" name="consent" value="${id}"><label for="owner-token">Owner token</label><input id="owner-token" name="owner_token" type="password" autocomplete="off" required maxlength="256"><p>Enter your private OWNER_TOKEN to authenticate as the owner. It is never sent to the MCP client.</p><button name="decision" value="allow" type="submit">Allow connection</button><button name="decision" value="deny" type="submit" formnovalidate>Cancel</button></form></main></html>`);
    },
    async challengeForAuthorizationCode(client, code) { return readCode(client.client_id, code).codeChallenge; },
    async exchangeAuthorizationCode(client, code, _verifier, redirectUri, requestedResource) {
      const authorization = readCode(client.client_id, code);
      checkResource(requestedResource);
      if (redirectUri !== authorization.redirectUri) throw new InvalidGrantError('The redirect URI must match the authorization request.');
      codes.delete(digest(code));
      return issueTokens(client.client_id);
    },
    async exchangeRefreshToken(client, refresh, scopes, requestedResource) {
      checkResource(requestedResource);
      const item = tokens.get(digest(refresh));
      if (!item || item.kind !== 'refresh' || item.expiresAt <= now() || item.clientId !== client.client_id) throw new InvalidGrantError('Invalid or expired refresh token.');
      if (item.consumed) { revokeGrant(item.grantId); throw new InvalidGrantError('Refresh token reuse revoked the connection.'); }
      if (scopes?.some((value) => value !== scope)) throw new InvalidScopeError('Scope cannot be expanded.');
      const result = issueTokens(client.client_id, item.grantId);
      item.consumed = true;
      return result;
    },
    async verifyAccessToken(token) {
      const item = tokens.get(digest(token));
      if (!item || item.kind !== 'access' || item.expiresAt <= now() || item.resource !== resource.href) throw new InvalidTokenError('Invalid or expired access token.');
      return { token, clientId: item.clientId, scopes: [scope], expiresAt: item.expiresAt, resource };
    },
    async revokeToken(client, request) {
      const item = tokens.get(digest(request.token));
      if (item?.clientId === client.client_id) revokeGrant(item.grantId);
    },
  };

  // The SDK permits ephemeral loopback ports. This deployment intentionally requires an exact allowlist.
  app.use('/authorize', express.urlencoded({ extended: false, limit: '8kb' }), (req, res, next) => {
    const params = req.method === 'POST' ? req.body ?? {} : req.query;
    const registered = typeof params.client_id === 'string' ? clients.get(params.client_id) : undefined;
    if (params.redirect_uri && (typeof params.redirect_uri !== 'string' || !allowedRedirects.has(params.redirect_uri) || !registered?.redirect_uris.includes(params.redirect_uri))) {
      res.status(400).json({ error: 'invalid_request', error_description: 'The exact redirect URI is not allowlisted.' });
      return;
    }
    next();
  });
  app.use('/token', express.urlencoded({ extended: false, limit: '8kb' }), (req, res, next) => {
    if (req.body?.grant_type === 'authorization_code' &&
        (typeof req.body.code_verifier !== 'string' || !/^[A-Za-z0-9._~-]{43,128}$/.test(req.body.code_verifier))) {
      res.status(400).json({ error: 'invalid_request', error_description: 'PKCE requires a 43–128 character verifier.' });
      return;
    }
    next();
  });
  app.use(mcpAuthRouter({ provider, issuerUrl: issuer, resourceServerUrl: resource, scopesSupported: [scope], resourceName: 'Anytype MCP' }));

  app.post('/oauth/consent', express.urlencoded({ extended: false, limit: '8kb' }), (req, res) => {
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    const id = typeof req.body?.consent === 'string' ? req.body.consent : '';
    const consent = consents.get(digest(id));
    const cookie = req.headers.cookie?.split(';').map((value) => value.trim()).find((value) => value.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1) ?? '';
    if (req.headers.origin !== issuer.origin || !consent || consent.expiresAt <= now() || !equal(digest(cookie), consent.browserSecret)) {
      res.status(403).send('Invalid or expired consent request. Start the connection again.');
      return;
    }
    // Consume even unsuccessful attempts so a form cannot be used to guess owner credentials repeatedly.
    consents.delete(digest(id));
    res.clearCookie(cookieName, { ...cookieOptions, maxAge: undefined });
    const redirect = new URL(consent.redirectUri);
    if (consent.state !== undefined) redirect.searchParams.set('state', consent.state);
    if (req.body.decision === 'deny') redirect.searchParams.set('error', 'access_denied');
    else {
      if (req.body.decision !== 'allow' || typeof req.body.owner_token !== 'string' || !equal(req.body.owner_token, config.ownerToken)) {
        res.status(403).send('Incorrect owner token. Start the connection again.');
        return;
      }
      prune();
      if (codes.size >= 128) { res.status(429).send('Too many outstanding connections. Try again shortly.'); return; }
      const code = random();
      codes.set(digest(code), { ...consent, expiresAt: now() + 60 });
      redirect.searchParams.set('code', code);
    }
    res.redirect(303, redirect.href);
  });

  const bearerAuth = requireBearerAuth({ verifier: provider, requiredScopes: [scope], resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resource) });
  const requireMcpAuth: RequestHandler = (req, res, next) => {
    const token = /^Bearer ([^\s]+)$/i.exec(req.headers.authorization ?? '')?.[1];
    if (token && equal(token, config.mcpToken)) { res.locals.principal = 'owner'; next(); return; }
    // Do not allow the SDK's permissive splitting to accept malformed headers.
    if (!token) req.headers.authorization = undefined;
    void bearerAuth(req, res, (error) => { if (!error) res.locals.principal = `oauth:${req.auth!.clientId}`; next(error); });
  };
  return { requireMcpAuth };
}
