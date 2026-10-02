import { z } from 'zod';

const loopback = (url: URL) => ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
export function readConfig(env: NodeJS.ProcessEnv = process.env) {
  const schema = z.object({
    PORT: z.coerce.number().int().min(1).max(65535).default(31013),
    HOST: z.string().default('127.0.0.1'),
    PUBLIC_URL: z.url().default('http://127.0.0.1:31013'),
    ANYTYPE_API_URL: z.url().default('http://127.0.0.1:31012'),
    ANYTYPE_API_KEY: z.string().min(1),
    ANYTYPE_ALLOWED_SPACES: z.string().default(''),
    ANYTYPE_API_VERSION: z.enum(['v1', 'v2']).default('v1'),
    ENABLE_EXPERIMENTAL_V2: z.enum(['true', 'false']).default('false'),
    READ_ONLY: z.enum(['true', 'false']).default('true'),
    MCP_TOKEN: z.string().regex(/^[\x21-\x7e]{32,256}$/),
    OWNER_TOKEN: z.string().regex(/^[\x21-\x7e]{32,256}$/),
    OAUTH_REDIRECT_URIS: z.string().default(''),
    REQUEST_TIMEOUT_MS: z.coerce.number().int().min(100).max(120000).default(15000),
    ALLOW_INSECURE_HTTP: z.enum(['true', 'false']).default('false'),
  }).parse(env);
  const publicUrl = new URL(schema.PUBLIC_URL);
  const apiUrl = new URL(schema.ANYTYPE_API_URL);
  for (const url of [publicUrl, apiUrl]) {
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Service URLs must be origins without credentials, paths or query strings.');
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback(url))) throw new Error('HTTPS is required except on loopback.');
  }
  if (schema.MCP_TOKEN === schema.OWNER_TOKEN) throw new Error('MCP_TOKEN and OWNER_TOKEN must differ.');
  if (publicUrl.protocol === 'http:' && !['localhost', '127.0.0.1', '::1'].includes(schema.HOST) && schema.ALLOW_INSECURE_HTTP !== 'true') throw new Error('Plain HTTP must bind loopback. Local Docker requires explicit ALLOW_INSECURE_HTTP=true and a loopback-only published port.');
  if (schema.ANYTYPE_API_VERSION === 'v2' && schema.ENABLE_EXPERIMENTAL_V2 !== 'true') throw new Error('v2 requires ENABLE_EXPERIMENTAL_V2=true.');
  return {
    port: schema.PORT, host: schema.HOST, publicUrl: publicUrl.origin, apiUrl: apiUrl.origin,
    apiKey: schema.ANYTYPE_API_KEY, apiVersion: schema.ANYTYPE_API_VERSION,
    allowedSpaces: new Set(schema.ANYTYPE_ALLOWED_SPACES.split(',').map(x => x.trim()).filter(Boolean)),
    readOnly: schema.READ_ONLY === 'true', mcpToken: schema.MCP_TOKEN, ownerToken: schema.OWNER_TOKEN,
    oauthRedirectUris: schema.OAUTH_REDIRECT_URIS.split(',').map(x => x.trim()).filter(Boolean),
    timeoutMs: schema.REQUEST_TIMEOUT_MS,
  };
}
export type Config = ReturnType<typeof readConfig>;
