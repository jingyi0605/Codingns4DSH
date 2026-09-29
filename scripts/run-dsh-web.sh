#!/usr/bin/env bash
set -euo pipefail

# Web 使用独立的 DSH 0.2.0-rc.1 运行时；不要复用共享的 0.1.x 启动器。
repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
dsh_bin=${DSH_WEB_LAUNCHER:-"$HOME/.local/share/codingns/deepseek-harness/0.2.0-rc.1/node_modules/@deepseek-ai/dsh/lib/bin.js"}
dsh_home=${DSH_WEB_HOME:-"$HOME/.dsh-web"}
state_dir=${CODINGNS4DSH_WEB_STATE_DIR:-"$HOME/.config/codingns4dsh/web"}
port=${DSH_WEB_PORT:-17890}

if [[ ! -f "$dsh_bin" ]]; then
  printf '找不到 DSH 0.2.0-rc.1 启动器: %s\n' "$dsh_bin" >&2
  exit 1
fi

cd "$repo_root"
runtime_env=(
  "DSH_HOME=$dsh_home"
  "CODINGNS4DSH_STATE_DIR=$state_dir"
  "CODINGNS4DSH_PROFILE_NAME=web"
  "CODINGNS4DSH_LOGIN_COOKIE_NAME=dsh_codingns_web020"
)

# web 是 0.2.0 的内置 profile 名：新 HOME 首次使用时会自动物化，
# 不能用 --from-default-profile 指定（该参数只接受自定义 profile 名）。
if [[ "${1-}" == "--dump-config" ||
  "${1-}" == "--dump-config-schema" ||
  "${1-}" == "--dump-default-config" ]]; then
  exec env "${runtime_env[@]}" node "$dsh_bin" --profile web "$@"
fi

# 插件管理（dsh plugin --profile web …）也必须在 0.2.0 运行时上执行，参数原样转发。
if [[ "${1-}" == "plugin" ]]; then
  exec env "${runtime_env[@]}" node "$dsh_bin" "$@"
fi

exec env "${runtime_env[@]}" node "$dsh_bin" --profile web --port "$port" "$@"
