#!/bin/sh
# @file install-cli.sh
# 目的：下载并启动公开的 Node 安装程序。
# 职责与入口：检查 Node → command；下载脚本 → curl；执行安装 → node。
# 边界：应用凭据保留在私有 YAML，不随下载请求发送。
set -eu
command -v node >/dev/null 2>&1 || { echo 'Node.js 22+ is required' >&2; exit 1; }
installer=$(mktemp)
trap 'rm -f "$installer"' EXIT HUP INT TERM
curl --proto '=https' --fail --silent --show-error https://xinliqiu.jiarui.ink/cli/install.mjs -o "$installer"
node --input-type=module - "$@" < "$installer"
