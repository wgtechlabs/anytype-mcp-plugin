import { readConfig } from './config.js';
import { connectUpstream } from './upstream.js';
import { createApp } from './server.js';

let upstream: Awaited<ReturnType<typeof connectUpstream>> | undefined;
try {
  const config = readConfig();
  upstream = await connectUpstream(config, () => {
    console.error(JSON.stringify({ event: 'upstream_disconnected', message: 'Restart required.' }));
    process.exit(1);
  });
  const server = createApp(config, upstream).listen(config.port, config.host, () => {
    console.error(JSON.stringify({ event: 'listening', url: `${config.publicUrl}/mcp`, read_only: config.readOnly, approved_spaces: config.allowedSpaces.size, api_version: config.apiVersion }));
  });
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    server.close();
    server.closeIdleConnections();
    const timeout = setTimeout(() => { server.closeAllConnections(); process.exit(1); }, 10000);
    timeout.unref();
    await upstream?.close();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  server.on('error', async () => { console.error(JSON.stringify({ event: 'listen_failed' })); await upstream?.close(); process.exitCode = 1; });
} catch {
  await upstream?.close().catch(() => {});
  console.error(JSON.stringify({ event: 'startup_failed', message: 'Check .env configuration, built upstream bundle, and Anytype CLI availability. Provider error contents are suppressed.' }));
  process.exitCode = 1;
}
