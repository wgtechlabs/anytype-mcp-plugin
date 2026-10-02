import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CallToolResultSchema, type CallToolResult, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { resolve } from 'node:path';
import type { Config } from './config.js';

export interface Upstream {
  tools: Tool[];
  call(name: string, args: Record<string, unknown>): Promise<CallToolResult>;
}

export async function connectUpstream(config: Config, onDisconnect?: () => void) {
  const client = new Client({ name: 'anytype-gateway', version: '0.1.0' });
  let closing = false;
  client.onclose = () => { if (!closing) onDisconnect?.(); };
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve('dist/upstream.mjs'), 'run', `${config.apiUrl}/${config.apiVersion}/docs/openapi.json`],
    env: {
      PATH: process.env.PATH ?? '',
      ANYTYPE_API_BASE_URL: config.apiUrl,
      OPENAPI_MCP_HEADERS: JSON.stringify({ Authorization: `Bearer ${config.apiKey}`, 'Anytype-Version': '2025-11-08' }),
    },
    stderr: 'pipe',
  });
  // Do not forward upstream logs: provider failures can include credentials or content.
  transport.stderr?.on('data', () => {});
  try {
    await client.connect(transport, { timeout: config.timeoutMs });
    const tools: Tool[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools({ cursor }, { timeout: config.timeoutMs });
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);
    return {
      tools,
      call: async (name: string, args: Record<string, unknown>) => CallToolResultSchema.parse(await client.callTool({ name, arguments: args }, CallToolResultSchema, { timeout: config.timeoutMs })),
      close: () => { closing = true; return client.close(); },
    };
  } catch (error) {
    closing = true;
    await client.close().catch(() => {});
    throw error;
  }
}
