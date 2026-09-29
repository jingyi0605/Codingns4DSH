#!/usr/bin/env bash
set -euo pipefail

# Stage0 使用独立的 DSH 0.2.0-rc.2 运行时；不要复用旧的 0.1.x 启动器。
repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
dsh_bin=${DSH_STAGE0_LAUNCHER:-"$HOME/.local/share/codingns/deepseek-harness/0.2.0-rc.2/node_modules/@deepseek-ai/dsh/lib/bin.js"}
dsh_home=${DSH_STAGE0_HOME:-"$HOME/.dsh-stage0-020"}
state_dir=${CODINGNS4DSH_STAGE0_STATE_DIR:-"$HOME/.config/codingns4dsh/stage0-020"}
port=${DSH_STAGE0_PORT:-17891}

if [[ ! -f "$dsh_bin" ]]; then
  printf '找不到 DSH 0.2.0-rc.2 启动器: %s\n' "$dsh_bin" >&2
  exit 1
fi

cd "$repo_root"
runtime_env=(
  "DSH_HOME=$dsh_home"
  "CODINGNS4DSH_STATE_DIR=$state_dir"
  "CODINGNS4DSH_PROFILE_NAME=stage0"
  "CODINGNS4DSH_LOGIN_COOKIE_NAME=dsh_codingns_stage0020"
)

# 0.2.0 运行时没有内置 stage0 模板：首次使用时基于内置 web 模板初始化该 profile，
# 之后普通启动；--from-default-profile 在 profile 已存在时会被 dsh 忽略，可安全重复。
bootstrap_args=()
if [[ ! -f "$dsh_home/profiles/stage0/package.json" ]]; then
  printf '首次启动：在 %s 初始化 stage0 profile（基于内置 web 模板）\n' "$dsh_home" >&2
  bootstrap_args=(--from-default-profile web)
fi

if [[ "${1-}" == "--dump-config" ||
  "${1-}" == "--dump-config-schema" ||
  "${1-}" == "--dump-default-config" ]]; then
  exec env "${runtime_env[@]}" node "$dsh_bin" ${bootstrap_args[@]+"${bootstrap_args[@]}"} --profile stage0 "$@"
fi

# 插件管理（dsh plugin --profile stage0 …）也必须在 0.2.0 运行时上执行，参数原样转发。
if [[ "${1-}" == "plugin" ]]; then
  exec env "${runtime_env[@]}" node "$dsh_bin" "$@"
fi

exec env "${runtime_env[@]}" node "$dsh_bin" ${bootstrap_args[@]+"${bootstrap_args[@]}"} --profile stage0 --port "$port" --no-open "$@"
