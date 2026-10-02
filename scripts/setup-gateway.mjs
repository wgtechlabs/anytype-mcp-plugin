import { randomBytes } from 'node:crypto';
import { parseEnv } from 'node:util';
import { readFile, writeFile, chmod } from 'node:fs/promises';
let env = await readFile('.env', 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
const configured = parseEnv(env);
for (const name of ['MCP_TOKEN', 'OWNER_TOKEN']) {
  if (!configured[name]) {
    env = env.replace(new RegExp(`^${name}=.*$\\n?`, 'm'), '');
    env += `${env.endsWith('\n') || !env ? '' : '\n'}${name}=${randomBytes(32).toString('hex')}\n`;
  }
}
await writeFile('.env', env, { mode: 0o600 });
await chmod('.env', 0o600);
console.log('Gateway secrets saved to .env. Existing nonempty secrets were preserved.');
