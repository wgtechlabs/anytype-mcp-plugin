#!/usr/bin/env bash
set -euo pipefail
umask 077
project_dir="$(cd "$(dirname "$0")/.." && pwd)"
runtime_dir="${ANYTYPE_RUNTIME_DIR:-$project_dir/.local}"
binary="${ANYTYPE_BINARY:-$runtime_dir/bin/anytype}"
mkdir -p "$runtime_dir/home" "$runtime_dir/data" "$runtime_dir/logs"
case "${1:-status}" in
  cli)
    shift
    if [[ "$(uname -s)" == Darwin ]]; then
      # Upstream uses a global Keychain service name. Deny that helper so its
      # existing file fallback stays inside this instance's private home.
      exec /usr/bin/sandbox-exec -p '(version 1)(allow default)(deny process-exec (literal "/usr/bin/security"))' \
        env HOME="$runtime_dir/home" DATA_PATH="$runtime_dir/data" "$binary" "$@"
    fi
    exec env HOME="$runtime_dir/home" DATA_PATH="$runtime_dir/data" DBUS_SESSION_BUS_ADDRESS=unix:path=/nonexistent "$binary" "$@"
    ;;
  start|stop|status)
    exec node --input-type=module - "$1" "$runtime_dir" "$project_dir/scripts/anytype.sh" "$binary" <<'NODE'
import fs from 'node:fs';
import net from 'node:net';
import {spawn, execFileSync} from 'node:child_process';
import {setTimeout as sleep} from 'node:timers/promises';
const [action, root, script, binary] = process.argv.slice(2);
const pidPath = `${root}/anytype.pid`;
const occupied = port => new Promise(resolve => {
  const socket = net.connect({host:'127.0.0.1',port});
  socket.setTimeout(300);
  socket.on('connect', () => {socket.destroy(); resolve(true);});
  socket.on('error', () => resolve(false));
  socket.on('timeout', () => {socket.destroy(); resolve(false);});
});
function running(afterStop = false) {
  if (!fs.existsSync(pidPath)) return null;
  const pid = Number(fs.readFileSync(pidPath, 'utf8'));
  if (!Number.isSafeInteger(pid) || pid < 2) throw Error('Invalid runtime PID file.');
  try {
    process.kill(pid, 0);
    const command = execFileSync('ps', ['-p', String(pid), '-o', 'stat=', '-o', 'command='], {encoding:'utf8'}).trim();
    if (command.startsWith('Z')) return null;
    if (!command.includes(binary) || !command.includes('serve')) {
      // After signaling a verified process, an exiting command or reused PID
      // means our process is gone. Never send another signal to that PID.
      if (afterStop) return null;
      throw Error('Runtime PID belongs to another process; refusing to use it.');
    }
    return pid;
  } catch (error) {
    if (error.code === 'ESRCH' || error.status === 1) return null;
    throw error;
  }
}
try {
  const pid = running();
  if (action === 'status') {
    console.log(pid ? `Anytype running (PID ${pid}); API ${await occupied(31012) ? 'listening' : 'waiting for account'}.` : 'Anytype stopped.');
    process.exit(pid ? 0 : 1);
  }
  if (action === 'stop') {
    if (pid) {
      process.kill(pid, 'SIGTERM');
      for (let i=0; i<100 && running(true); i++) await sleep(100);
      if (running(true)) throw Error('Anytype has not stopped; no forced termination attempted.');
    }
    fs.rmSync(pidPath, {force:true});
    console.log('Anytype stopped.');
    process.exit(0);
  }
  if (pid) {console.log('Anytype already running.'); process.exit(0);}
  for (const port of [31010,31011,31012]) if (await occupied(port)) throw Error(`Port ${port} is occupied; refusing to disturb another instance.`);
  const log = fs.openSync(`${root}/logs/anytype.log`, 'a', 0o600);
  const child = spawn(script, ['cli','serve','--quiet'], {detached:true, stdio:['ignore',log,log]});
  fs.closeSync(log);
  await new Promise((resolve, reject) => {child.once('spawn',resolve); child.once('error',reject);});
  fs.writeFileSync(pidPath,String(child.pid),{mode:0o600});
  child.unref();
  for (let i=0;i<200;i++) {
    if (await occupied(31010)) {console.log('Anytype started on loopback.'); process.exit(0);}
    try { process.kill(child.pid, 0); } catch { throw Error('Anytype exited; inspect the private runtime log.'); }
    await sleep(100);
  }
  throw Error('Anytype startup timed out; inspect the private runtime log.');
} catch (error) {console.error(error.message); process.exit(1);}
NODE
    ;;
  *) echo 'Usage: scripts/anytype.sh start|stop|status|cli [arguments]' >&2; exit 2;;
esac
