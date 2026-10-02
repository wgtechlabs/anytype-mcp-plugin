#!/usr/bin/env bash
set -euo pipefail
umask 077
project_dir="$(cd "$(dirname "$0")/.." && pwd)"
runtime_dir="${ANYTYPE_RUNTIME_DIR:-$project_dir/.local}"
binary="${ANYTYPE_BINARY:-$runtime_dir/bin/anytype}"
mkdir -p "$runtime_dir/bin" "$runtime_dir/secrets"
platform="$(uname -s)-$(uname -m)"
case "$platform" in
  Darwin-arm64) asset=darwin-arm64; checksum=ad5ed683dd24d6fc3e5297df9c88c879c8aaa779f778bb925cad66bb3ffa1ad8;;
  Darwin-x86_64) asset=darwin-amd64; checksum=6ed7ecd180ca55e8be0193c98484c9d8cc34f3fefcca36fa5697eec99d84ca3b;;
  Linux-aarch64|Linux-arm64) asset=linux-arm64; checksum=05decb7d194b7f271137adbb1f562a9e1650c3cadbab356725c6654b418a768e;;
  Linux-x86_64) asset=linux-amd64; checksum=07ea6ee385c45069db5911a2de25a1a0c447e2d40746a4748adee3aab6057a10;;
  *) echo "Unsupported platform: $platform" >&2; exit 1;;
esac
if [[ ! -x "$binary" ]]; then
  download_dir="$(mktemp -d "$runtime_dir/download.XXXXXX")"
  trap 'rm -rf "$download_dir"' EXIT
  curl --fail --location --silent --show-error --proto '=https' --tlsv1.2 \
    "https://github.com/anyproto/anytype-cli/releases/download/v0.4.0/anytype-cli-v0.4.0-$asset.tar.gz" -o "$download_dir/anytype.tar.gz"
  node --input-type=module - "$download_dir/anytype.tar.gz" "$checksum" <<'NODE'
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
const hash = createHash('sha256');
for await (const chunk of createReadStream(process.argv[2])) hash.update(chunk);
if (hash.digest('hex') !== process.argv[3]) throw Error('Anytype release checksum mismatch.');
console.log('Verified Anytype CLI v0.4.0 release checksum.');
NODE
  tar -xzf "$download_dir/anytype.tar.gz" -C "$download_dir"
  # Release tarballs contain a single platform-named executable.
  candidate="$(find "$download_dir" -type f -name 'anytype*' ! -name '*.tar.gz' | head -n 1)"
  test -n "$candidate"
  chmod 700 "$candidate"
  mv "$candidate" "$runtime_dir/bin/anytype"
fi
node --input-type=module - "$binary" <<'NODE'
import {execFileSync} from 'node:child_process';
if(!/^anytype-cli v0\.4\.0(?:\s|$)/m.test(execFileSync(process.argv[2],['version'],{encoding:'utf8'}))) throw Error('Expected pinned Anytype CLI v0.4.0; refuse to reuse another version.');
NODE
if [[ "${1:-}" == --download-only ]]; then exit 0; fi
echo 'CLI v0.4.0 has no local-only network mode; the dedicated bot uses encrypted Anytype Network sync unless ANYTYPE_NETWORK_CONFIG is set.'
"$project_dir/scripts/anytype.sh" start
if ! node --input-type=module - "$runtime_dir/home/.anytype/config.json" <<'NODE'
import fs from 'node:fs';
try {process.exit(JSON.parse(fs.readFileSync(process.argv[2], 'utf8')).accountId ? 0 : 1);} catch {process.exit(1);}
NODE
then
  create_args=(auth create anytype-mcp-plugin --root-path "$runtime_dir/data")
  if [[ -n "${ANYTYPE_NETWORK_CONFIG:-}" ]]; then create_args+=(--network-config "$ANYTYPE_NETWORK_CONFIG"); fi
  if ! "$project_dir/scripts/anytype.sh" cli "${create_args[@]}" >"$runtime_dir/secrets/account-recovery.txt" 2>&1; then
    echo 'Account creation failed; inspect .local/secrets/account-recovery.txt privately.' >&2; exit 1
  fi
fi
if [[ ! -s "$runtime_dir/secrets/api-key.txt" ]]; then
  "$project_dir/scripts/anytype.sh" cli auth apikey create anytype-mcp-plugin --all-spaces --read-write >"$runtime_dir/secrets/api-key-output.txt" 2>&1
  node --input-type=module - "$runtime_dir/secrets" <<'NODE'
import fs from 'node:fs';
const dir=process.argv[2];
const output=fs.readFileSync(`${dir}/api-key-output.txt`,'utf8').replace(/\x1b\[[0-9;]*m/g,'');
const key=output.match(/\bKey:\s*(\S+)/)?.[1];
if (!key) throw Error('API key generation returned no recognizable key; inspect the private output.');
fs.writeFileSync(`${dir}/api-key.txt`,key,{mode:0o600});
fs.rmSync(`${dir}/api-key-output.txt`);
NODE
fi
node --input-type=module - "$runtime_dir" "${ANYTYPE_ENV_FILE:-$project_dir/.env}" <<'NODE'
import fs from 'node:fs';
import {parseEnv} from 'node:util';
const [root,envPath]=process.argv.slice(2);
let env=fs.existsSync(envPath)?fs.readFileSync(envPath,'utf8'):'';
const configured={...parseEnv(env),...process.env};
const key=configured.ANYTYPE_API_KEY??fs.readFileSync(`${root}/secrets/api-key.txt`,'utf8').trim();
function saveMissing(values) {
 for (const [name,value] of Object.entries(values)) {
  if(!Object.hasOwn(configured,name)) env=`${env}${env.endsWith('\n')||!env?'':'\n'}${name}=${JSON.stringify(value)}\n`;
 }
 fs.writeFileSync(envPath,env,{mode:0o600});fs.chmodSync(envPath,0o600);
}
const headers={Authorization:`Bearer ${key}`,'Anytype-Version':'2025-11-08','Content-Type':'application/json'};
async function api(path,body) {
 const response=await fetch(`http://127.0.0.1:31012/v1${path}`,{method:body?'POST':'GET',headers,body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(60000)});
 if (!response.ok) throw Error(`Anytype setup API returned HTTP ${response.status}; no response content logged.`);
 return response.json();
}
let spaces;
for(let attempt=0;attempt<40;attempt++) {
 try {spaces=await api('/spaces');break;} catch(error) {
  if(!(error.cause?.code==='ECONNREFUSED')||attempt===39) throw error;
  await new Promise(resolve=>setTimeout(resolve,250));
 }
}
if(Object.hasOwn(configured,'ANYTYPE_ALLOWED_SPACES')) {
 saveMissing({ANYTYPE_API_URL:'http://127.0.0.1:31012',ANYTYPE_API_KEY:key,READ_ONLY:'true'});
 console.log('Verified existing Anytype API credentials; existing space permissions and read-only setting preserved.');
 process.exit(0);
}
let space=spaces.data?.find(s=>s.name==='Anytype MCP Sandbox');
if (!space) {const created=await api('/spaces',{name:'Anytype MCP Sandbox',description:'Dedicated local integration test space.'});space=created.space??created;}
if (!space.id) throw Error('Anytype did not return a space id.');
const found=await api(`/spaces/${encodeURIComponent(space.id)}/search`,{query:'MCP welcome note'});
if (!found.data?.some(o=>o.name==='MCP welcome note')) await api(`/spaces/${encodeURIComponent(space.id)}/objects`,{type_key:'page',name:'MCP welcome note',body:'This isolated test note verifies the local Anytype MCP connection.'});
saveMissing({ANYTYPE_API_URL:'http://127.0.0.1:31012',ANYTYPE_API_KEY:key,ANYTYPE_ALLOWED_SPACES:space.id,READ_ONLY:'true'});
console.log('Verified API authentication, sandbox space, and persisted test note. Gateway configuration saved privately.');
NODE
