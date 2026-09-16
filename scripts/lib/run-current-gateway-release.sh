#!/bin/bash
set -euo pipefail

# This file is copied into <release-root>/bin. Keep release selection relative
# to that location so the managed service never pins one release's dist path.
release_root="$(cd "$(dirname "$0")/.." && pwd -P)"
entry="$release_root/current/dist/index.js"

if [[ ! -f "$entry" ]]; then
  printf 'OpenClaw release entry is unavailable: %s\n' "$entry" >&2
  exit 1
fi

recorded_node=""
if [[ -f "$release_root/node-path" ]]; then
  IFS= read -r recorded_node < "$release_root/node-path"
fi
node_path="${OPENCLAW_RELEASE_NODE:-${recorded_node:-$(command -v node || true)}}"
if [[ -z "$node_path" || ! -x "$node_path" ]]; then
  printf 'No executable Node runtime is available for the OpenClaw release.\n' >&2
  exit 1
fi

exec "$node_path" "$entry" "$@"
