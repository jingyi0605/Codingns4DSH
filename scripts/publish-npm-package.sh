#!/usr/bin/env bash

set -euo pipefail

# 本脚本只负责当前仓库根目录下的 dsh-codingns 包。
# 发布前会重新构建并执行检查，避免把过期的 data/build 产物发布出去。
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NPM_REGISTRY="${NPM_REGISTRY:-https://registry.npmjs.org/}"
OUTPUT_DIR="${NPM_PACKAGE_OUTPUT_DIR:-$ROOT_DIR/data/build/npm}"
DEFAULT_NPM_TOKEN_FILE="${HOME:-$ROOT_DIR}/.codingns/npmjs-token"

selected_mode=""
publish_tag=""
dry_run="false"
provenance="false"
skip_tests="false"
npm_auth_config_file=""

PACKAGE_NAME=""
PACKAGE_VERSION=""
TARBALL_PATH=""

print_help() {
  cat <<'EOF'
用法：

  bash scripts/publish-npm-package.sh [选项]

选项：

  --mode <pack|publish>  指定模式；pack 只打包，publish 发布到 npm
  --dry-run              发布预演，不真正写入 npm（仅 publish 模式有效）
  --provenance           发布时附带 npm provenance
  --tag <dist-tag>       显式指定 npm dist-tag；默认预发布版本用 next，其余用 latest
  --skip-tests           跳过 typecheck 和测试；仍然会执行完整构建
  --help                 显示帮助

npm token 读取顺序：

  1. NODE_AUTH_TOKEN 环境变量
  2. NPM_TOKEN 环境变量
  3. NPM_TOKEN_FILE 指向的文件
  4. CODINGNS_NPM_TOKEN_FILE 指向的文件
  5. ~/.codingns/npmjs-token

示例：

  bash scripts/publish-npm-package.sh --mode pack
  bash scripts/publish-npm-package.sh --mode publish --tag next
  bash scripts/publish-npm-package.sh --mode publish --dry-run
EOF
}

cleanup() {
  if [[ -n "$npm_auth_config_file" && -f "$npm_auth_config_file" ]]; then
    rm -f "$npm_auth_config_file"
  fi
}

trap cleanup EXIT

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode)
      [[ $# -ge 2 ]] || { echo "缺少 --mode 的取值" >&2; exit 1; }
      selected_mode="$2"
      shift 2
      ;;
    --dry-run)
      dry_run="true"
      shift
      ;;
    --provenance)
      provenance="true"
      shift
      ;;
    --tag)
      [[ $# -ge 2 ]] || { echo "缺少 --tag 的取值" >&2; exit 1; }
      publish_tag="$2"
      shift 2
      ;;
    --skip-tests)
      skip_tests="true"
      shift
      ;;
    --help|-h)
      print_help
      exit 0
      ;;
    *)
      echo "不支持的参数：$1" >&2
      exit 1
      ;;
  esac
done

read_package_field() {
  local field="$1"
  node -p "require('./package.json')['$field']"
}

resolve_publish_tag() {
  if [[ -n "$publish_tag" ]]; then
    printf '%s\n' "$publish_tag"
  elif [[ "$PACKAGE_VERSION" == *-* ]]; then
    printf '%s\n' "next"
  else
    printf '%s\n' "latest"
  fi
}

read_first_line() {
  local file_path="$1"
  [[ -f "$file_path" ]] || return 1
  sed -n '1{s/[[:space:]]*$//;p;}' "$file_path"
}

resolve_npm_token() {
  local token=""

  if [[ -n "${NODE_AUTH_TOKEN:-}" ]]; then
    printf '%s' "$NODE_AUTH_TOKEN"
    return 0
  fi
  if [[ -n "${NPM_TOKEN:-}" ]]; then
    printf '%s' "$NPM_TOKEN"
    return 0
  fi

  token="$(read_first_line "${NPM_TOKEN_FILE:-}" 2>/dev/null || true)"
  [[ -n "$token" ]] && { printf '%s' "$token"; return 0; }

  token="$(read_first_line "${CODINGNS_NPM_TOKEN_FILE:-}" 2>/dev/null || true)"
  [[ -n "$token" ]] && { printf '%s' "$token"; return 0; }

  token="$(read_first_line "$DEFAULT_NPM_TOKEN_FILE" 2>/dev/null || true)"
  [[ -n "$token" ]] && { printf '%s' "$token"; return 0; }

  return 1
}

configure_npm_auth() {
  local token=""
  token="$(resolve_npm_token || true)"

  if [[ -z "$token" ]]; then
    echo "未发现脚本专用 npm token，将使用 npm 当前登录态。"
    return 0
  fi

  npm_auth_config_file="$(mktemp "${TMPDIR:-/tmp}/dsh-codingns-npmrc.XXXXXX")"
  chmod 600 "$npm_auth_config_file"
  {
    echo "registry=$NPM_REGISTRY"
    printf '//registry.npmjs.org/:_authToken=%s\n' "$token"
  } >"$npm_auth_config_file"
  export NPM_CONFIG_USERCONFIG="$npm_auth_config_file"
  echo "已从预定义位置读取 npm token，并写入临时 npm 配置。"
}

registry_has_version() {
  local versions_json=""
  versions_json="$(npm view "$PACKAGE_NAME" versions --json --registry "$NPM_REGISTRY" 2>/dev/null || true)"
  [[ -n "$versions_json" ]] || return 1

  REGISTRY_VERSIONS="$versions_json" TARGET_VERSION="$PACKAGE_VERSION" node <<'NODE'
const raw = process.env.REGISTRY_VERSIONS ?? ''
const target = process.env.TARGET_VERSION ?? ''
let parsed
try {
  parsed = JSON.parse(raw)
} catch {
  process.exit(1)
}
const versions = Array.isArray(parsed) ? parsed : typeof parsed === 'string' ? [parsed] : []
process.exit(versions.includes(target) ? 0 : 1)
NODE
}

verify_version_is_new() {
  echo "==> 检查 npm 是否已存在同版本"
  if registry_has_version; then
    echo "npm 已存在 ${PACKAGE_NAME}@${PACKAGE_VERSION}，停止发布。" >&2
    exit 1
  fi
  echo "npm 尚不存在 ${PACKAGE_NAME}@${PACKAGE_VERSION}，可以继续。"
}

verify_registry_after_publish() {
  local expected_tag="$1"
  local attempt=""
  local published_version=""
  local tag_version=""

  echo "==> 校验 npm 发布结果"
  for ((attempt = 1; attempt <= 12; attempt += 1)); do
    published_version="$(npm view "$PACKAGE_NAME" version --registry "$NPM_REGISTRY" 2>/dev/null || true)"
    tag_version="$(npm view "$PACKAGE_NAME" "dist-tags.$expected_tag" --registry "$NPM_REGISTRY" 2>/dev/null || true)"
    if [[ "$published_version" == "$PACKAGE_VERSION" || "$tag_version" == "$PACKAGE_VERSION" ]]; then
      echo "npm 已收录 ${PACKAGE_NAME}@${PACKAGE_VERSION}，dist-tag ${expected_tag} 已指向该版本。"
      return 0
    fi
    echo "第 $attempt/12 次校验未完成，等待 5 秒后重试..."
    sleep 5
  done

  echo "npm 发布后校验失败，请手动检查 npm registry。" >&2
  exit 1
}

run_checks_and_build() {
  echo "==> 校验版本同步"
  pnpm run version:check

  if [[ "$skip_tests" == "true" ]]; then
    echo "==> 跳过类型检查和测试，仅执行构建"
    pnpm run build
    return
  fi

  echo "==> 执行类型检查"
  pnpm run typecheck
  echo "==> 执行完整测试（测试流程会重新构建）"
  pnpm test
}

create_tarball() {
  local pack_json=""
  local tarball_name=""

  mkdir -p "$OUTPUT_DIR"
  rm -f "$OUTPUT_DIR"/*.tgz

  echo "==> 检查 npm 打包清单"
  npm pack --dry-run --ignore-scripts --json >/dev/null

  echo "==> 生成 npm tarball"
  pack_json="$(npm pack --ignore-scripts --pack-destination "$OUTPUT_DIR" --json)"
  tarball_name="$(PACK_JSON="$pack_json" node <<'NODE'
const fs = require('node:fs')
const input = process.env.PACK_JSON ?? ''
if (!input) process.exit(1)
const parsed = JSON.parse(input)
const entry = Array.isArray(parsed) ? parsed[0] : parsed
if (!entry?.filename) process.exit(1)
process.stdout.write(entry.filename)
NODE
)"

  TARBALL_PATH="$OUTPUT_DIR/$tarball_name"
  [[ -f "$TARBALL_PATH" ]] || { echo "未找到 npm pack 产物：$TARBALL_PATH" >&2; exit 1; }
  echo "已生成：$TARBALL_PATH"
}

publish_tarball() {
  local tag="$1"
  local -a publish_command=(npm publish "$TARBALL_PATH" --access public --tag "$tag" --registry "$NPM_REGISTRY" --ignore-scripts)

  configure_npm_auth
  [[ "$provenance" == "true" ]] && publish_command+=(--provenance)
  [[ "$dry_run" == "true" ]] && publish_command+=(--dry-run)

  echo "==> 发布信息"
  echo "包名：$PACKAGE_NAME"
  echo "版本：$PACKAGE_VERSION"
  echo "dist-tag：$tag"
  echo "预演：$dry_run"
  echo "provenance：$provenance"
  echo "==> 执行 npm publish"
  "${publish_command[@]}"

  [[ "$dry_run" == "true" ]] || verify_registry_after_publish "$tag"
}

execute_flow() {
  local mode="$1"
  local tag=""

  run_checks_and_build
  create_tarball

  if [[ "$mode" == "pack" ]]; then
    echo "本地打包完成，未发布到 npm。"
    return
  fi

  tag="$(resolve_publish_tag)"
  verify_version_is_new
  publish_tarball "$tag"
}

main() {
  PACKAGE_NAME="$(read_package_field name)"
  PACKAGE_VERSION="$(read_package_field version)"

  if [[ -z "$selected_mode" ]]; then
    echo ""
    echo "==> $PACKAGE_NAME@$PACKAGE_VERSION"
    echo "  [1] 仅本地打包"
    echo "  [2] 打包并发布到 npm"
    read -r -p "请选择操作编号 [1-2]: " choice
    case "$choice" in
      1) selected_mode="pack" ;;
      2) selected_mode="publish" ;;
      *) echo "无效选择：$choice" >&2; exit 1 ;;
    esac
  fi

  case "$selected_mode" in
    pack|publish) ;;
    *) echo "不支持的 --mode：$selected_mode，仅支持 pack 或 publish" >&2; exit 1 ;;
  esac

  if [[ "$dry_run" == "true" && "$selected_mode" != "publish" ]]; then
    echo "--dry-run 仅适用于 --mode publish" >&2
    exit 1
  fi

  echo "==> 开始处理 ${PACKAGE_NAME}@${PACKAGE_VERSION}（模式：${selected_mode}）"
  execute_flow "$selected_mode"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
