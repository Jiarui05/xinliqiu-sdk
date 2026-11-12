#!/bin/sh
# Bootstrap the public Node installer; authentication stays in private YAML.
set -eu
command -v node >/dev/null 2>&1 || { echo 'Node.js 22+ is required' >&2; exit 1; }
installer=$(mktemp)
trap 'rm -f "$installer"' EXIT HUP INT TERM
curl --proto '=https' --fail --silent --show-error https://xinliqiu.jiarui.ink/cli/install.mjs -o "$installer"
node --input-type=module - "$@" < "$installer"
