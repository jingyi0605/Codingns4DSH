#!/usr/bin/env bash
set -euo pipefail

# 只移走 stage0 的源码开发链接；Desktop 和当前仓库目录都不会被删除。
repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)

# stage0 默认使用专用 DSH_HOME。显式把它指向 Desktop 的 ~/.dsh 时拒绝执行，
# 避免清理脚本误操作桌面 Profile。
if [[ -n "${DSH_HOME+x}" ]]; then
  explicit_home=${DSH_HOME%/}
  desktop_home="$HOME/.dsh"
  if [[ "$explicit_home" == "$desktop_home" ]]; then
    printf '拒绝在 Desktop DSH_HOME（%s）清理 stage0 链接；请使用 DSH_STAGE0_HOME。\n' "$explicit_home" >&2
    exit 1
  fi
  if [[ -d "$DSH_HOME" && -d "$desktop_home" ]]; then
    explicit_home=$(cd -P "$DSH_HOME" && pwd -P)
    desktop_home=$(cd -P "$desktop_home" && pwd -P)
    if [[ "$explicit_home" == "$desktop_home" ]]; then
      printf '拒绝在 Desktop DSH_HOME（%s）清理 stage0 链接；请使用 DSH_STAGE0_HOME。\n' "$explicit_home" >&2
      exit 1
    fi
  fi
fi

# Stage0 专用变量优先于通用 DSH_HOME；这样从 Desktop shell 继承其他 DSH_HOME
# 时，清理命令仍然只会落到 Stage0 Profile。
dsh_home=${DSH_STAGE0_HOME:-${DSH_HOME:-"$HOME/.dsh-stage0-020"}}
profile_root="$dsh_home/profiles/stage0"

# 新包名是 scoped package；旧的 dsh-codingns 是历史开发链接名，保留兼容清理。
link_paths=(
  "$profile_root/node_modules/@jingyi0605/codingns4dsh"
  "$profile_root/node_modules/dsh-codingns"
)
found=0
for link_path in "${link_paths[@]}"; do
  if [[ ! -L "$link_path" ]]; then
    continue
  fi

  resolved_target=$(cd -P "$link_path" 2>/dev/null && pwd -P || true)
  if [[ "$resolved_target" != "$repo_root" ]]; then
    printf '拒绝移动非当前仓库链接: %s -> %s\n' "$link_path" "$resolved_target" >&2
    exit 1
  fi

  backup="${link_path}.bak-old-$(date +%Y%m%d%H%M%S)"
  mv "$link_path" "$backup"
  printf '已移走 stage0 旧链接: %s\n' "$backup"
  found=1
done

if [[ "$found" -eq 0 ]]; then
  printf 'stage0 源码链接不存在，无需清理: %s\n' "$profile_root/node_modules"
fi
