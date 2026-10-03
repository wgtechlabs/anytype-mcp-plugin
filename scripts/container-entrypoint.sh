#!/usr/bin/env bash
set -euo pipefail
umask 077
cd /app
# Railway mounts fresh volumes as root. Only this initializer needs that
# override; even PID 1 runs as node once ownership has been prepared.
if [[ "$(id -u)" == 0 ]]; then
  mkdir -p /data
  chown node:node /data
  chmod 700 /data
  exec setpriv --reuid=node --regid=node --init-groups \
    --inh-caps=-all --no-new-privs \
    tini -- /app/scripts/container-run.sh "$@"
fi
if [[ ! -w /data ]]; then
  echo 'The /data volume must be writable by node (UID 1000). On Railway, set RAILWAY_RUN_UID=0 for volume initialization.' >&2
  exit 1
fi
exec tini -- /app/scripts/container-run.sh "$@"
