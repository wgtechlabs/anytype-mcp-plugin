#!/usr/bin/env bash
set -euo pipefail
umask 077
cd /app
export ANYTYPE_RUNTIME_DIR=/data
export ANYTYPE_BINARY=/opt/anytype/bin/anytype
export ANYTYPE_ENV_FILE=/data/gateway.env
export HOST=0.0.0.0
export PORT="${PORT:-31013}"
if [[ -z "${PUBLIC_URL:-}" && -n "${RAILWAY_PUBLIC_DOMAIN:-}" ]]; then
  export PUBLIC_URL="https://$RAILWAY_PUBLIC_DOMAIN"
fi
node --input-type=module <<'NODE'
const {MCP_TOKEN,OWNER_TOKEN,PUBLIC_URL,NODE_ENV}=process.env;
if(!MCP_TOKEN||MCP_TOKEN.length<32||!OWNER_TOKEN||OWNER_TOKEN.length<32||MCP_TOKEN===OWNER_TOKEN) throw Error('Set distinct MCP_TOKEN and OWNER_TOKEN secrets, each at least 32 characters.');
const url=new URL(PUBLIC_URL||'invalid');
if(NODE_ENV!=='development'&&url.protocol!=='https:') throw Error('Production requires PUBLIC_URL with HTTPS, or a Railway public domain.');
NODE
gateway_pid=''
cleanup() {
  trap - EXIT INT TERM
  if [[ -n "$gateway_pid" ]]; then kill -TERM "$gateway_pid" 2>/dev/null || true; wait "$gateway_pid" 2>/dev/null || true; fi
  scripts/anytype.sh stop
}
trap cleanup EXIT
# Exit the monitor loop on a requested stop; EXIT performs the same cleanup
# for signals and failures without resuming against already-stopped processes.
trap 'exit 0' INT TERM
scripts/setup-anytype.sh
node --env-file=/data/gateway.env dist/src/index.js &
gateway_pid="$!"
# ponytail: one bot per volume and one gateway process; add a supervisor only
# if additional long-lived services make this two-process lifecycle insufficient.
while kill -0 "$gateway_pid" 2>/dev/null; do
  if ! scripts/anytype.sh status >/dev/null; then echo 'Anytype exited; stopping gateway.' >&2; exit 1; fi
  sleep 2
done
wait "$gateway_pid"
