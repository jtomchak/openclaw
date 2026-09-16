#!/bin/bash
# Bash 5.3+ can deadlock writing heredoc pipes on macOS before the reader starts.
if [[ ${OSTYPE:-} == darwin* && $BASH != /bin/bash ]] && ((BASH_VERSINFO[0] > 5 || (BASH_VERSINFO[0] == 5 && BASH_VERSINFO[1] >= 3))); then
  exec /bin/bash "$0" "$@"
fi
set -euo pipefail

log() { printf '[build-restart-gateway] %s\n' "$*"; }
fail() {
  printf '[build-restart-gateway] ERROR: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: scripts/build-and-restart-mac-gateway.sh [options]

Build the current tracked checkout in an immutable release worktree, switch the
macOS Gateway service to it, and roll back to the previous release if startup or
readiness verification fails.

Options:
  --port <port>          Gateway port (default: read from the LaunchAgent)
  --release-root <path>  Release storage (default: ~/.openclaw/runtime-builds)
  --label <label>        LaunchAgent label (default: ai.openclaw.gateway)
  --help, -h             Show this help

The snapshot includes tracked working-tree edits but refuses untracked files so
new source cannot be omitted silently. Failed candidates are retained for
diagnosis. Successful releases are retained as rollback targets.
EOF
}

port=""
label="${OPENCLAW_LAUNCHD_LABEL:-ai.openclaw.gateway}"
release_root="${OPENCLAW_GATEWAY_RELEASE_ROOT:-${HOME}/.openclaw/runtime-builds}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --port)
      [[ $# -ge 2 ]] || fail "--port requires a value"
      port="$2"
      shift 2
      ;;
    --release-root)
      [[ $# -ge 2 ]] || fail "--release-root requires a value"
      release_root="$2"
      shift 2
      ;;
    --label)
      [[ $# -ge 2 ]] || fail "--label requires a value"
      label="$2"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *) fail "unknown option: $1" ;;
  esac
done

[[ "$(uname -s)" == Darwin ]] || fail "this workflow requires macOS launchd"
for command_name in curl git launchctl lsof node plutil pnpm; do
  command -v "$command_name" >/dev/null 2>&1 || fail "$command_name is required"
done
pnpm_path="$(command -v pnpm)"
[[ -x "$pnpm_path" ]] || fail "pnpm is not executable: $pnpm_path"

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$repo_root"
git rev-parse --show-toplevel >/dev/null 2>&1 || fail "not inside a Git checkout"

case "$release_root" in
  /*) ;;
  *) release_root="$repo_root/$release_root" ;;
esac
release_root="${release_root%/}"
case "$release_root/" in
  "$repo_root/"*) fail "--release-root must be outside the source checkout" ;;
esac
mkdir -p "$release_root"
release_root="$(cd "$release_root" && pwd -P)"
case "$release_root/" in
  "$repo_root/"*) fail "--release-root must resolve outside the source checkout" ;;
esac

plist="${HOME}/Library/LaunchAgents/${label}.plist"
[[ -f "$plist" ]] || fail "LaunchAgent is not installed: $plist"
service_domain="gui/$(id -u)/${label}"
launchctl print "$service_domain" >/dev/null 2>&1 || fail "LaunchAgent is not loaded: $service_domain"

service_args_json="$(plutil -extract ProgramArguments json -o - "$plist")" ||
  fail "could not read LaunchAgent arguments"
if [[ -z "$port" ]]; then
  port="$(node -e '
    const args = JSON.parse(process.argv[1]);
    const index = args.lastIndexOf("--port");
    if (index < 0 || !/^\d+$/.test(args[index + 1] ?? "")) process.exit(1);
    process.stdout.write(args[index + 1]);
  ' "$service_args_json")" || fail "could not resolve the Gateway port from the LaunchAgent"
fi
[[ "$port" =~ ^[0-9]+$ ]] && ((port >= 1 && port <= 65535)) || fail "invalid Gateway port: $port"

current_link="$release_root/current"
wrapper_path="$release_root/bin/openclaw-gateway-release"
previous_target=""
if [[ -L "$current_link" ]]; then
  node -e '
    const args = JSON.parse(process.argv[1]);
    if (!args.includes(process.argv[2])) process.exit(1);
  ' "$service_args_json" "$wrapper_path" ||
    fail "the release selector exists, but the LaunchAgent is not owned by $wrapper_path"
  previous_target="$(cd "$current_link" && pwd -P)"
else
  [[ ! -e "$current_link" ]] || fail "$current_link must be a symbolic link"
  previous_entry="$(node -e '
    const args = JSON.parse(process.argv[1]);
    const entry = args.find((arg) => typeof arg === "string" && /\/dist\/index\.js$/.test(arg));
    if (!entry) process.exit(1);
    process.stdout.write(entry);
  ' "$service_args_json")" || fail "the existing service does not expose a dist/index.js rollback target"
  previous_target="$(cd "$(dirname "$previous_entry")/.." && pwd -P)"
fi
previous_entry="$previous_target/dist/index.js"
[[ -f "$previous_entry" ]] || fail "previous release entry is unavailable: $previous_entry"

untracked="$(git ls-files --others --exclude-standard)"
if [[ -n "$untracked" ]]; then
  printf '%s\n' "$untracked" | head -20 >&2
  fail "untracked files are present; add, ignore, or remove them before building a release snapshot"
fi

mkdir -p "$release_root/bin"
lock_dir="$release_root/.build-restart.lock"
if ! mkdir "$lock_dir" 2>/dev/null; then
  fail "another build/restart is active: $lock_dir"
fi

scratch_dir="$(mktemp -d "${TMPDIR:-/tmp}/openclaw-build-restart.XXXXXX")"
snapshot_index="$scratch_dir/index"
candidate_dir=""
activation_started=0
rollback_attempted=0

cleanup() {
  local code=$?
  trap - EXIT
  if [[ $code -ne 0 && $activation_started -eq 1 && $rollback_attempted -eq 0 ]]; then
    rollback "unexpected exit" || true
  fi
  rm -rf "$scratch_dir"
  rmdir "$lock_dir" 2>/dev/null || true
  if [[ $code -ne 0 && -n "$candidate_dir" ]]; then
    log "candidate retained for diagnosis: $candidate_dir"
  fi
  exit "$code"
}
trap cleanup EXIT

atomic_select_release() {
  local target="$1"
  local next_link="$release_root/.current.$$.next"
  rm -f "$next_link"
  ln -s "$target" "$next_link"
  node -e 'require("node:fs").renameSync(process.argv[1], process.argv[2])' "$next_link" "$current_link"
}

wait_for_ready() {
  local excluded_pid="${1:-}"
  local attempts=0
  while ((attempts < 60)); do
    local service_pid=""
    service_pid="$(launchctl print "$service_domain" 2>/dev/null |
      awk '$1 == "pid" && $2 == "=" && $3 ~ /^[0-9]+$/ { print $3; exit }')"
    if [[ -n "$service_pid" && "$service_pid" != "$excluded_pid" ]] &&
      lsof -nP -a -p "$service_pid" -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1 &&
      curl --silent --show-error --fail --max-time 2 "http://127.0.0.1:${port}/readyz" 2>/dev/null |
      node -e '
        let input = "";
        process.stdin.on("data", (chunk) => (input += chunk));
        process.stdin.on("end", () => {
          try {
            const value = JSON.parse(input);
            process.exit(value.ready === true && Array.isArray(value.failing) && value.failing.length === 0 ? 0 : 1);
          } catch {
            process.exit(1);
          }
        });
      '; then
      return 0
    fi
    attempts=$((attempts + 1))
    sleep 1
  done
  return 1
}

install_selected_release() {
  local entry="$1"
  OPENCLAW_RELEASE_NODE="$(command -v node)" node "$entry" gateway install \
    --force --port "$port" --wrapper "$wrapper_path"
}

rollback() {
  local reason="$1"
  local replaced_pid=""
  rollback_attempted=1
  replaced_pid="$(launchctl print "$service_domain" 2>/dev/null |
    awk '$1 == "pid" && $2 == "=" && $3 ~ /^[0-9]+$/ { print $3; exit }')"
  log "activation failed (${reason}); selecting previous release"
  atomic_select_release "$previous_target"
  if ! install_selected_release "$previous_entry"; then
    log "ROLLBACK FAILED while reinstalling the previous service; retained releases were not removed"
    return 1
  fi
  if ! wait_for_ready "$replaced_pid"; then
    log "ROLLBACK FAILED: previous release did not become ready; retained releases were not removed"
    return 1
  fi
  log "rollback ready: $previous_target"
  return 0
}

# Build a commit object from the tracked working tree without changing the real
# index, branch, or user edits. The linked worktree keeps the object reachable.
rm -f "$snapshot_index"
source_index="$(git rev-parse --git-path index)"
[[ -f "$source_index" ]] || fail "the checkout index is unavailable: $source_index"
cp "$source_index" "$snapshot_index"
GIT_INDEX_FILE="$snapshot_index" git add -u -- .
if [[ -n "$(git ls-files --others --exclude-standard)" ]]; then
  fail "untracked files appeared while the release snapshot was being created; retry from a stable checkout"
fi
snapshot_tree="$(GIT_INDEX_FILE="$snapshot_index" git write-tree)"
snapshot_commit="$(printf 'OpenClaw local release snapshot\n' | git commit-tree "$snapshot_tree" -p HEAD)"
snapshot_short="$(git rev-parse --short "$snapshot_commit")"
release_name="$(date -u +%Y%m%dT%H%M%SZ)-${snapshot_short}"
candidate_dir="$release_root/releases/$release_name"
mkdir -p "$release_root/releases"
[[ ! -e "$candidate_dir" ]] || fail "release already exists: $candidate_dir"

log "materializing tracked snapshot $snapshot_short"
git worktree add --detach "$candidate_dir" "$snapshot_commit"

run_pnpm() (
  export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
  export NPM_CONFIG_WORKSPACE_DIR="$PWD" npm_config_workspace_dir="$PWD"
  export PNPM_CONFIG_LOCKFILE_DIR="$PWD" pnpm_config_lockfile_dir="$PWD"
  "$pnpm_path" "$@"
)

log "installing candidate dependencies"
(cd "$candidate_dir" && run_pnpm install --frozen-lockfile)
log "building candidate while the current Gateway remains online"
(cd "$candidate_dir" && OPENCLAW_UPDATE_IN_PROGRESS=1 run_pnpm build)
(cd "$candidate_dir" && node dist/index.js config validate)
log "materializing candidate runtime dependencies"
(cd "$candidate_dir" && run_pnpm install --frozen-lockfile --offline --ignore-scripts)

candidate_entry="$candidate_dir/dist/index.js"
[[ -f "$candidate_entry" ]] || fail "candidate build did not create dist/index.js"
node -e '
  const fs = require("node:fs");
  const actual = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).commit;
  if (actual !== process.argv[2]) {
    console.error(`build identity mismatch: expected ${process.argv[2]}, got ${actual}`);
    process.exit(1);
  }
' "$candidate_dir/dist/build-info.json" "$snapshot_commit"
(cd "$candidate_dir" && node dist/index.js --version >/dev/null)

wrapper_temp="$release_root/bin/.openclaw-gateway-release.$$.tmp"
cp "$candidate_dir/scripts/lib/run-current-gateway-release.sh" "$wrapper_temp"
chmod 700 "$wrapper_temp"
mv -f "$wrapper_temp" "$wrapper_path"
node_path_temp="$release_root/.node-path.$$.tmp"
command -v node > "$node_path_temp"
chmod 600 "$node_path_temp"
mv -f "$node_path_temp" "$release_root/node-path"

activation_started=1
previous_pid="$(launchctl print "$service_domain" 2>/dev/null |
  awk '$1 == "pid" && $2 == "=" && $3 ~ /^[0-9]+$/ { print $3; exit }')"
atomic_select_release "$candidate_dir"
log "installing candidate service on port $port"
if ! install_selected_release "$candidate_entry"; then
  rollback "service install" || true
  fail "candidate service install failed${rollback_attempted:+; rollback was attempted}"
fi
if ! wait_for_ready "$previous_pid"; then
  rollback "readiness timeout" || true
  fail "candidate failed readiness verification${rollback_attempted:+; rollback was attempted}"
fi
if ! launchctl print "$service_domain" 2>/dev/null | grep -F "$wrapper_path" >/dev/null; then
  rollback "LaunchAgent command verification" || true
  fail "LaunchAgent does not use the stable release wrapper"
fi
if ! lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
  rollback "listener verification" || true
  fail "no process is listening on Gateway port $port"
fi

activation_started=0
log "OK release=$release_name previous=$previous_target port=$port"
