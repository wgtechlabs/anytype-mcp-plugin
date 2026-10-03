import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { parseEnv } from 'node:util';

const [root, envPath, mode] = process.argv.slice(2);
const statePath = join(root, 'secrets/invite-state.json');
const lockPath = join(root, 'bootstrap.lock');
const managedPrefix = '# ANYTYPE_INVITE_MANAGED_SPACE=';
const spaceIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/;
let env, fileSettings, configured, invite;

function parseInvite() {
  if (!invite) return;
  const message = 'ANYTYPE_INVITE_LINK must be a complete Anytype space invitation URL. Use the original Anytype-generated invitation.';
  if (invite.length > 4096 || /[\x00-\x20\x7f\\]/.test(invite) || !/^[a-z]+:\/\//i.test(invite)) throw Error(message);
  try {
    const url = new URL(invite);
    // Reject malformed escapes rather than relying on the URL parser's forgiving query decoding.
    decodeURIComponent(invite);
    const path = decodeURIComponent(url.pathname);
    let cid, key;
    if (['https:', 'http:'].includes(url.protocol) && url.hostname) {
      // The pinned CLI decodes the entire path before selecting its last nonempty segment.
      cid = path.replace(/^\/+|\/+$/g, '').split('/').at(-1);
      key = decodeURIComponent(url.hash.slice(1));
    } else if (url.protocol === 'anytype:' && (url.host === 'invite' || path.startsWith('/invite')) && !url.search.includes(';')) {
      cid = url.searchParams.get('cid');
      key = url.searchParams.get('key');
    }
    if (url.username || url.password || !cid || !key || /[\x00-\x20\x7f]/.test(cid + key)) throw Error(message);
    // Pinned Anytype generates CIDv1 dag-pb SHA-256 in lowercase, unpadded base32.
    // Restrict its encoding (including padding bits) so alternate CID spellings cannot bypass history.
    if (!/^bafybei[a-h][a-z2-7]{50}[aeimquy4]$/.test(cid)) throw Error(message);
    return { cid, key };
  } catch { throw Error(message); }
}

function saveConfig(values) {
  for (const [name, value] of Object.entries(values)) {
    if (!Object.hasOwn(configured, name) || (name === 'ANYTYPE_API_KEY' && !configured[name])) {
      env += (env.endsWith('\n') || !env ? '' : '\n') + name + '=' + JSON.stringify(value) + '\n';
    }
  }
  // Write atomically so a stopped container cannot leave a half-written config.
  fs.writeFileSync(envPath + '.tmp', env, { mode: 0o600 });
  fs.chmodSync(envPath + '.tmp', 0o600);
  fs.renameSync(envPath + '.tmp', envPath);
}

function readInviteState() {
  if (!fs.existsSync(statePath)) return {};
  let state;
  try { state = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch { throw Error('Invitation state is unreadable; restore the private runtime backup.'); }
  if (!state?.attempts || typeof state.attempts !== 'object' || Array.isArray(state.attempts) || Object.entries(state.attempts).some(([fingerprint, spaceId]) =>
    !/^[a-f0-9]{64}$/.test(fingerprint) || (spaceId !== null && (typeof spaceId !== 'string' || !spaceIdPattern.test(spaceId))))) {
    throw Error('Invitation state is invalid; restore the private runtime backup.');
  }
  if (state.version === undefined) {
    // Unreleased prototypes stored raw-URL hashes, which cannot establish whether an alias was tried.
    throw Error('Invitation history uses an older format; preserve it. Remove ANYTYPE_INVITE_LINK to retain configured access, or use a fresh runtime and a newly generated invitation.');
  }
  if (state.version !== 2) throw Error('Invitation state version is unsupported; restore the private runtime backup or use its matching software version.');
  return state.attempts;
}

function saveInviteState(attempts) {
  fs.writeFileSync(statePath + '.tmp', JSON.stringify({ version: 2, attempts }) + '\n', { mode: 0o600 });
  fs.chmodSync(statePath + '.tmp', 0o600);
  fs.renameSync(statePath + '.tmp', statePath);
}

function invitedSpace(invitation, attempts) {
  const fingerprint = createHash('sha256').update(JSON.stringify([invitation.cid, invitation.key])).digest('hex');
  if (Object.hasOwn(attempts, fingerprint)) {
    if (attempts[fingerprint] === null) throw Error('A previous invitation attempt has an uncertain outcome. Supply a newly generated invitation to retry; no duplicate request was sent.');
    return attempts[fingerprint];
  }
  // Record intent first. Do not automatically repeat an uncertain join on restart.
  attempts[fingerprint] = null;
  saveInviteState(attempts);
  let output;
  try {
    // Submit the same parsed identity that was fingerprinted, independent of URL spelling.
    const canonicalUrl = 'anytype://invite/?' + new URLSearchParams(invitation);
    output = execFileSync(join(import.meta.dirname, 'anytype.sh'), ['cli', '--no-update-check', 'space', 'join', canonicalUrl], {
      encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ANYTYPE_RUNTIME_DIR: root },
    });
  } catch {
    // Child errors contain argv and provider output, both of which may contain secrets.
    throw Error('Unable to complete the invitation attempt. Check the invitation and network, then supply a newly generated invitation to retry.');
  }
  // Parse only the pinned CLI's final line, never the untrusted space/creator names.
  const match = output.trimEnd().split('\n').at(-1)?.match(/^✓ Successfully sent join request to space '([^']+)'$/);
  if (!match || !spaceIdPattern.test(match[1])) throw Error('Invitation result could not be verified. Supply a newly generated invitation to retry.');
  attempts[fingerprint] = match[1];
  saveInviteState(attempts);
  return match[1];
}

function configureInvitedSpace(spaceId) {
  const managed = env.split('\n').find(line => line.startsWith(managedPrefix))?.slice(managedPrefix.length);
  const ownsFileValue = managed && spaceIdPattern.test(managed) && fileSettings.ANYTYPE_ALLOWED_SPACES === managed;
  if (Object.hasOwn(process.env, 'ANYTYPE_ALLOWED_SPACES') || (Object.hasOwn(fileSettings, 'ANYTYPE_ALLOWED_SPACES') && !ownsFileValue)) {
    console.log('Explicit ANYTYPE_ALLOWED_SPACES preserved, including empty deny-all settings.');
    return;
  }
  env = env.split('\n').filter(line => !line.startsWith(managedPrefix) && !/^ANYTYPE_ALLOWED_SPACES=/.test(line)).join('\n');
  env += (env.endsWith('\n') || !env ? '' : '\n') + managedPrefix + spaceId + '\nANYTYPE_ALLOWED_SPACES=' + JSON.stringify(spaceId) + '\n';
}

async function bootstrap(invitation, attempts) {
  const key = configured.ANYTYPE_API_KEY || fs.readFileSync(join(root, 'secrets/api-key.txt'), 'utf8').trim();
  const headers = { Authorization: 'Bearer ' + key, 'Anytype-Version': '2025-11-08', 'Content-Type': 'application/json' };
  async function api(path, body) {
    const response = await fetch('http://127.0.0.1:31012/v1' + path, {
      method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(60000), redirect: 'error',
    });
    if (!response.ok) throw Error('Anytype setup API returned HTTP ' + response.status + '; no response content logged.');
    return response.json();
  }
  let spaces;
  for (let attempt = 0; attempt < 40; attempt++) {
    try { spaces = await api('/spaces'); break; } catch (error) {
      if (error.cause?.code !== 'ECONNREFUSED' || attempt === 39) throw error;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
  const defaults = { ANYTYPE_API_URL: 'http://127.0.0.1:31012', ANYTYPE_API_KEY: key, READ_ONLY: 'true' };
  if (invitation) {
    const spaceId = invitedSpace(invitation, attempts);
    const response = await fetch('http://127.0.0.1:31012/v1/spaces/' + encodeURIComponent(spaceId), {
      headers, signal: AbortSignal.timeout(60000), redirect: 'error',
    });
    await response.body?.cancel();
    if (!response.ok && response.status !== 404 && response.status !== 403) throw Error('Unable to verify invited space access; no response content logged.');
    configureInvitedSpace(spaceId);
    saveConfig(defaults);
    // CLI v0.4.0 can report success despite a rejected join. Only HTTP verifies access.
    console.log(response.ok ? 'Invited Anytype space is accessible. Gateway configuration saved privately.' : 'Waiting for space access; owner approval may be required. Check the invitation and bot membership in Anytype if access remains unavailable. The gateway will expose the allowed space when access becomes available.');
    return;
  }
  if (Object.hasOwn(configured, 'ANYTYPE_ALLOWED_SPACES')) {
    saveConfig(defaults);
    console.log('Verified existing Anytype API credentials; existing space permissions and read-only setting preserved.');
    return;
  }
  let space = spaces.data?.find(item => item.name === 'Anytype MCP Sandbox');
  if (!space) {
    const created = await api('/spaces', { name: 'Anytype MCP Sandbox', description: 'Dedicated local integration test space.' });
    space = created.space ?? created;
  }
  if (!space.id) throw Error('Anytype did not return a space id.');
  const found = await api('/spaces/' + encodeURIComponent(space.id) + '/search', { query: 'MCP welcome note' });
  if (!found.data?.some(item => item.name === 'MCP welcome note')) {
    await api('/spaces/' + encodeURIComponent(space.id) + '/objects', { type_key: 'page', name: 'MCP welcome note', body: 'This isolated test note verifies the local Anytype MCP connection.' });
  }
  saveConfig({ ...defaults, ANYTYPE_ALLOWED_SPACES: space.id });
  console.log('Verified API authentication, sandbox space, and persisted test note. Gateway configuration saved privately.');
}

let ownsLock = false;
try {
  // mkdir is atomic across processes. Acquire before reading any shared configuration/history.
  // Never guess that a lock is stale: a timed-out process or its CLI child may still be writing.
  try { fs.mkdirSync(lockPath, { mode: 0o700 }); } catch (error) {
    if (error.code === 'EEXIST') throw Error('Unable to acquire bootstrap lock; another setup owns this runtime. Wait for it to finish. After an interrupted setup, stop all services and setup/CLI processes using this runtime, then remove only bootstrap.lock; preserve invitation history.');
    throw error;
  }
  ownsLock = true;
  env = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
  fileSettings = parseEnv(env);
  configured = { ...fileSettings, ...process.env };
  invite = (configured.ANYTYPE_INVITE_LINK ?? '').trim();
  const invitation = parseInvite();
  const attempts = invitation ? readInviteState() : {};
  if (mode !== '--validate-invite') await bootstrap(invitation, attempts);
} catch (error) {
  // Never print exception objects/stacks: network and subprocess errors may include credentials.
  const safe = error instanceof Error && /^(ANYTYPE_INVITE_LINK|Invitation |A previous invitation |Unable to |Anytype setup API|Anytype did not)/.test(error.message);
  console.error(safe ? error.message : 'Anytype bootstrap failed; check private runtime configuration and network availability.');
  process.exitCode = 1;
} finally {
  if (ownsLock) {
    try { fs.rmdirSync(lockPath); } catch {
      console.error('Unable to release bootstrap lock; stop all services and setup/CLI processes using this runtime before removing only bootstrap.lock.');
      process.exitCode = 1;
    }
  }
}
