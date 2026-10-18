#!/usr/bin/env bash
# =============================================================================
# install.sh — 有招单机版：首次部署（幂等，可重复执行）
#   1) 校验 docker / compose
#   2) 生成或校验 deploy/.env（生成时把 please-change-this-* 换成随机密钥）
#   3) 创建数据目录并修好预览目录属主（api 容器内是 uid 1000 的 node 用户）
#   4) 检查端口占用 → docker compose build → docker compose up -d
#   5) 等 api/gateway 健康检查通过 → 打印访问地址与管理员账号
# 说明：不删除任何既有数据；重复执行只会再次收敛到同一状态（可安全重跑）。
# 参数与可变项都来自 deploy/.env（可用同名环境变量临时覆盖）。
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
ENV_FILE="${DEPLOY_DIR}/.env"
ENV_EXAMPLE="${DEPLOY_DIR}/.env.example"
COMPOSE_FILE="${DEPLOY_DIR}/compose.yaml"

# ── 可变项（默认值；均可在 deploy/.env 里覆盖）───────────────────────────────
HEALTH_TIMEOUT="300"
PROJECT_NAME="youzhao"
DATA_ROOT="/data/youzhao"
GATEWAY_HTTP_PORT="80"
GATEWAY_PREVIEW_HTTP_PORT="8080"

# ── 开关（命令行）───────────────────────────────────────────────────────────
ASSUME_YES=0
ALLOW_DEV=0
TIMEOUT_SET=0
COMPOSE=()

# =============================================================================
# 输出与帮助
# =============================================================================
log()  { printf '\033[32m▸\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
install.sh — 有招单机版：首次部署（幂等，可重复执行）

用法：
  bash deploy/scripts/install.sh [选项]

选项：
  -h, --help        显示本帮助并退出
  -y, --yes         无人值守：不交互确认，缺失的密钥自动生成
      --dev         本机验收模式：允许 APP_ENV=development（无证书、用 http 域名时用）
      --timeout N   等健康检查的秒数（默认取 .env 的 INSTALL_HEALTH_TIMEOUT，再默认 300）

它会做：
  1. 校验 docker 与 compose（优先 `docker compose` v2，回退 `docker-compose`）
  2. deploy/.env 不存在 → 由 .env.example 生成并把 please-change-this-* 换成随机值；
     已存在 → 只校验，不覆盖
  3. 按 .env 建数据目录（默认 /data/youzhao/{postgres,previews,backups,logs,uploads}）
  4. 检查网关端口占用 → docker compose build → docker compose up -d
  5. 等 /health 通过 → 打印访问地址、管理员账号、后续步骤

数据安全：本脚本不删除任何已有数据；密钥只写入 deploy/.env（chmod 600）。
EOF
}

# =============================================================================
# .env 读写（不 source，避免值里的空格/引号/特殊字符被执行）
# =============================================================================
env_get() {
  local key="$1" fallback="${2-}" line value
  if [[ ! -f "${ENV_FILE}" ]]; then printf '%s' "${fallback}"; return 0; fi
  line="$(grep -E "^[[:space:]]*${key}=" "${ENV_FILE}" 2>/dev/null | tail -n 1 || true)"
  if [[ -z "${line}" ]]; then printf '%s' "${fallback}"; return 0; fi
  value="${line#*=}"
  value="${value%$'\r'}"
  value="${value#"${value%%[![:space:]]*}"}"          # 去左侧空白
  value="${value%"${value##*[![:space:]]}"}"          # 去右侧空白
  case "${value}" in                                   # 行内注释（# 前有空白才算，同 compose）
    *[[:space:]]'#'*) value="${value%%[[:space:]]'#'*}" ;;
  esac
  value="${value%"${value##*[![:space:]]}"}"
  case "${value}" in                                   # 去掉成对引号
    \"*\") value="${value#\"}"; value="${value%\"}" ;;
    \'*\') value="${value#\'}"; value="${value%\'}" ;;
  esac
  printf '%s' "${value}"
}

set_env_value() {
  local key="$1" value="$2" tmp
  tmp="$(mktemp "${ENV_FILE}.XXXXXX")"
  awk -v k="${key}" -v v="${value}" '
    BEGIN { found = 0 }
    {
      if ($0 ~ "^[[:space:]]*" k "=") { print k "=" v; found = 1; next }
      print $0
    }
    END { if (!found) print k "=" v }
  ' "${ENV_FILE}" > "${tmp}"
  chmod 600 "${tmp}"
  mv "${tmp}" "${ENV_FILE}"
}

env_has_placeholder() {
  local value="$1"
  case "${value}" in
    *please-change-this*|*CHANGE_ME*|*change_me*|*change-me*) return 0 ;;
  esac
  return 1
}

random_secret() {
  local prefix="$1" body=""
  if command -v openssl >/dev/null 2>&1; then
    body="$(openssl rand -hex 24)"
  else
    body="$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  fi
  printf '%s-%s' "${prefix}" "${body}"
}

lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }

origin_of() {                      # http://host:port/path → http://host:port
  local url="$1" scheme rest
  case "${url}" in
    *://*) ;;
    *) printf ''; return 0 ;;
  esac
  scheme="${url%%://*}"
  rest="${url#*://}"
  rest="${rest%%/*}"
  printf '%s://%s' "${scheme}" "${rest}"
}

# =============================================================================
# 前置检查
# =============================================================================
check_docker() {
  command -v docker >/dev/null 2>&1 || die "未找到 docker：请先安装 Docker Engine（docs/deployment-rules.md）"
  docker info >/dev/null 2>&1 || die "docker 守护进程不可用（docker info 失败）：启动 dockerd 后重试"
  docker ps >/dev/null 2>&1 || die "无权访问 docker（把当前用户加入 docker 组或使用 root）"
}

detect_compose() {
  if docker compose version >/dev/null 2>&1; then
    COMPOSE=(docker compose)
  elif command -v docker-compose >/dev/null 2>&1; then
    COMPOSE=(docker-compose)
  else
    die "未找到 docker compose（需要 Docker Compose v2 插件，或独立的 docker-compose 1.29+）"
  fi
  log "compose 命令：${COMPOSE[*]}"
}

compose() { "${COMPOSE[@]}" -p "${PROJECT_NAME}" -f "${COMPOSE_FILE}" "$@"; }

# =============================================================================
# .env 生成与校验
# =============================================================================
ensure_env_file() {
  if [[ -f "${ENV_FILE}" ]]; then
    log "沿用已有 ${ENV_FILE}（不覆盖）"
  else
    [[ -f "${ENV_EXAMPLE}" ]] || die "缺少 ${ENV_EXAMPLE}，无法生成 .env"
    cp "${ENV_EXAMPLE}" "${ENV_FILE}"
    chmod 600 "${ENV_FILE}"
    log "已由 .env.example 生成 ${ENV_FILE}（chmod 600）"
  fi
  generate_secrets
}

generate_secrets() {
  local key value
  for key in POSTGRES_PASSWORD PREVIEW_TICKET_SECRET PREVIEW_EMBED_SECRET ADMIN_PASSWORD; do
    value="$(env_get "${key}")"
    if [[ -z "${value}" ]] || env_has_placeholder "${value}"; then
      set_env_value "${key}" "$(random_secret "${key}")"
      log "已为 ${key} 生成随机值并写入 ${ENV_FILE}"
    fi
  done
}

validate_env() {
  local problems=0 key value app_env driver origin_app origin_preview

  for key in APP_ENV DB_DRIVER API_PUBLIC_BASE_URL PREVIEW_DOMAIN POSTGRES_DB POSTGRES_USER \
             POSTGRES_PASSWORD ADMIN_USERNAME ADMIN_PASSWORD PREVIEW_TICKET_SECRET \
             PREVIEW_EMBED_SECRET PREVIEW_STORAGE_PATH MCP_PATH \
             GATEWAY_APP_HOST GATEWAY_PREVIEW_HOST; do
    value="$(env_get "${key}")"
    if [[ -z "${value}" ]]; then warn "缺少必填项：${key}"; problems=$((problems + 1)); fi
  done

  app_env="$(env_get APP_ENV development)"
  driver="$(env_get DB_DRIVER postgres)"

  if [[ "${driver}" != "postgres" ]]; then
    warn "DB_DRIVER=${driver}：生产必须 postgres（pglite 重启即清空，config.ts 在生产会拒绝）"
    problems=$((problems + 1))
  fi
  if [[ "${app_env}" != "production" ]]; then
    if (( ALLOW_DEV )); then
      warn "APP_ENV=${app_env}（--dev 已允许）：仅用于本机验收，生产必须 production"
    else
      warn "APP_ENV=${app_env}：生产必须 production；本机无证书验收请显式加 --dev"
      problems=$((problems + 1))
    fi
  fi

  for key in POSTGRES_PASSWORD ADMIN_PASSWORD PREVIEW_TICKET_SECRET PREVIEW_EMBED_SECRET; do
    value="$(env_get "${key}")"
    [[ -n "${value}" ]] || continue
    case "$(lower "${value}")" in
      change_me|changeme|secret|123456|youzhao_embed_dev_secret)
        warn "${key} 使用了被 server/config.ts FORBIDDEN_SECRETS 拒绝的取值"; problems=$((problems + 1)) ;;
    esac
    if env_has_placeholder "${value}"; then
      warn "${key} 仍是占位符（please-change-this-*）：请替换为随机值（openssl rand -hex 32）"
      problems=$((problems + 1))
    fi
    if [[ "${app_env}" == "production" && "${#value}" -lt 32 ]]; then
      warn "${key} 在 production 下长度必须 ≥32（当前 ${#value}）"
      problems=$((problems + 1))
    fi
  done

  origin_app="$(origin_of "$(env_get API_PUBLIC_BASE_URL)")"
  origin_preview="$(origin_of "$(env_get PREVIEW_DOMAIN)")"
  if [[ -z "${origin_app}" || -z "${origin_preview}" ]]; then
    warn "API_PUBLIC_BASE_URL / PREVIEW_DOMAIN 必须是完整 URL（含 scheme 与主机）"
    problems=$((problems + 1))
  elif [[ "${origin_app}" == "${origin_preview}" ]]; then
    warn "PREVIEW_DOMAIN 必须与应用域不同源（两者都是 ${origin_app}）：同源会让产物拿到会话能力"
    problems=$((problems + 1))
  fi

  if [[ "${app_env}" == "production" ]]; then
    case "$(env_get API_PUBLIC_BASE_URL)" in
      https://*) ;;
      *) warn "production 下 API_PUBLIC_BASE_URL 必须 https://"; problems=$((problems + 1)) ;;
    esac
    case "$(env_get PREVIEW_DOMAIN)" in
      https://*) ;;
      *) warn "production 下 PREVIEW_DOMAIN 必须 https://"; problems=$((problems + 1)) ;;
    esac
  fi

  local body_limit mcp_body
  body_limit="$(env_get API_JSON_BODY_LIMIT_BYTES 5242880)"
  mcp_body="$(env_get MCP_MAX_BODY_BYTES 5242880)"
  case "${body_limit}" in ''|*[!0-9]*) warn "API_JSON_BODY_LIMIT_BYTES 必须是非负整数"; problems=$((problems + 1)) ;; esac
  case "${mcp_body}" in ''|*[!0-9]*) warn "MCP_MAX_BODY_BYTES 必须是非负整数"; problems=$((problems + 1)) ;; esac
  if [[ "${mcp_body}" =~ ^[0-9]+$ && "${body_limit}" =~ ^[0-9]+$ ]] && (( mcp_body > body_limit )); then
    warn "MCP_MAX_BODY_BYTES(${mcp_body}) > API_JSON_BODY_LIMIT_BYTES(${body_limit})：网关 client_max_body_size 会先 413，请同步调大后者"
  fi

  if (( problems > 0 )); then
    die "deploy/.env 校验不通过（${problems} 项）：修正后重跑本脚本"
  fi
  log "deploy/.env 校验通过（APP_ENV=${app_env}, DB_DRIVER=${driver}）"
}

load_deploy_vars() {
  PROJECT_NAME="$(env_get COMPOSE_PROJECT_NAME youzhao)"
  DATA_ROOT="$(env_get DATA_ROOT /data/youzhao)"
  GATEWAY_HTTP_PORT="$(env_get GATEWAY_HTTP_PORT 80)"
  GATEWAY_PREVIEW_HTTP_PORT="$(env_get GATEWAY_PREVIEW_HTTP_PORT 8080)"
  [[ -n "${PROJECT_NAME}" ]] || PROJECT_NAME="youzhao"
  [[ -n "${DATA_ROOT}" ]] || DATA_ROOT="/data/youzhao"
  [[ -n "${GATEWAY_HTTP_PORT}" ]] || GATEWAY_HTTP_PORT="80"
  [[ -n "${GATEWAY_PREVIEW_HTTP_PORT}" ]] || GATEWAY_PREVIEW_HTTP_PORT="8080"
  if (( ! TIMEOUT_SET )); then
    HEALTH_TIMEOUT="$(env_get INSTALL_HEALTH_TIMEOUT "${HEALTH_TIMEOUT}")"
  fi
  [[ -n "${HEALTH_TIMEOUT}" ]] || HEALTH_TIMEOUT="300"
  case "${DATA_ROOT}" in
    /*) ;;
    *) die "DATA_ROOT 必须是绝对路径（当前 ${DATA_ROOT}）" ;;
  esac
  [[ "${DATA_ROOT}" != "/" ]] || die "DATA_ROOT 不能是 /"
}

# =============================================================================
# 目录与端口
# =============================================================================
ensure_dirs() {
  local sub
  for sub in postgres previews backups logs uploads; do
    mkdir -p "${DATA_ROOT}/${sub}" || die "无法创建 ${DATA_ROOT}/${sub}（需要 root 权限，或先手动创建并授权）"
  done
  chmod 750 "${DATA_ROOT}" 2>/dev/null || true
  chmod 700 "${DATA_ROOT}/backups" 2>/dev/null || true
  log "数据目录就绪：${DATA_ROOT}/{postgres,previews,backups,logs,uploads}"
  fix_previews_owner
}

fix_previews_owner() {
  local dir="${DATA_ROOT}/previews" owner
  owner="$(stat -c '%u' "${dir}" 2>/dev/null || stat -f '%u' "${dir}" 2>/dev/null || printf '')"
  [[ "${owner}" == "1000" ]] && return 0
  if [[ "$(id -u)" != "0" ]]; then
    warn "${dir} 属主不是 uid 1000（当前 ${owner:-未知}）：api 容器内以 node(1000) 运行，发布会报 EACCES"
    warn "  修法： sudo chown -R 1000:1000 ${dir}"
    return 0
  fi
  chown -R 1000:1000 "${dir}" && log "已把 ${dir} 属主设为 1000:1000（api 容器内 node 用户）"
}

port_in_use() {                    # 0=占用 1=空闲 2=无法判断
  local port="$1"
  if command -v ss >/dev/null 2>&1; then
    if ss -ltn 2>/dev/null | awk '{print $4}' | grep -Eq "[:.]${port}$"; then return 0; else return 1; fi
  fi
  if command -v lsof >/dev/null 2>&1; then
    if lsof -nP -iTCP:"${port}" -sTCP:LISTEN >/dev/null 2>&1; then return 0; else return 1; fi
  fi
  if command -v nc >/dev/null 2>&1; then
    if nc -z 127.0.0.1 "${port}" >/dev/null 2>&1; then return 0; else return 1; fi
  fi
  return 2
}

check_port() {
  local port="$1" label="$2" rc=0
  port_in_use "${port}" || rc=$?
  if [[ "${rc}" == "2" ]]; then
    warn "无法判断端口 ${port}（${label}）：缺少 ss/lsof/nc，请自行确认"
    return 0
  fi
  if [[ "${rc}" == "1" ]]; then
    log "端口 ${port}（${label}）可用"
    return 0
  fi
  if docker ps --filter "label=com.docker.compose.project=${PROJECT_NAME}" --format '{{.Ports}}' 2>/dev/null \
       | grep -Eq "(:|\.)${port}->"; then
    log "端口 ${port}（${label}）已由本项目容器占用 → 视为重复执行，继续"
    return 0
  fi
  die "端口 ${port}（${label}）被其他进程占用：释放端口，或改 deploy/.env 的 GATEWAY_*_PORT"
}

check_ports() {
  check_port "${GATEWAY_HTTP_PORT}" "应用域"
  if [[ "${GATEWAY_PREVIEW_HTTP_PORT}" != "${GATEWAY_HTTP_PORT}" ]]; then
    check_port "${GATEWAY_PREVIEW_HTTP_PORT}" "预览域"
  fi
}

# =============================================================================
# 起服务 + 等健康
# =============================================================================
http_ok() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsS -o /dev/null --max-time 5 "$1" >/dev/null 2>&1
  else
    wget -q -O /dev/null --timeout=5 "$1" >/dev/null 2>&1
  fi
}

wait_for_health() {
  local url="$1" label="$2" timeout="${3:-${HEALTH_TIMEOUT}}" start now
  start="$(date +%s)"
  log "等 ${label} 就绪（最多 ${timeout}s）：${url}"
  while :; do
    if http_ok "${url}"; then
      log "✓ ${label} 健康"
      return 0
    fi
    now="$(date +%s)"
    if (( now - start >= timeout )); then
      warn "✗ ${label} 在 ${timeout}s 内未通过健康检查"
      compose ps || true
      compose logs --tail=40 api gateway 2>/dev/null || true
      return 1
    fi
    sleep 3
  done
}

confirm() {
  local prompt="$1" reply=""
  if (( ASSUME_YES )); then log "${prompt} → --yes 自动确认"; return 0; fi
  read -r -p "${prompt} [y/N] " reply || true
  case "${reply}" in [Yy]*) return 0 ;; *) return 1 ;; esac
}

# =============================================================================
# 参数
# =============================================================================
parse_args() {
  while (( $# > 0 )); do
    case "$1" in
      -h|--help) usage; exit 0 ;;
      -y|--yes) ASSUME_YES=1 ;;
      --dev) ALLOW_DEV=1 ;;
      --timeout)
        [[ $# -ge 2 ]] || die "--timeout 需要一个秒数"
        HEALTH_TIMEOUT="$2"; TIMEOUT_SET=1; shift ;;
      *) die "未知参数：$1（用 --help 查看用法）" ;;
    esac
    shift
  done
}

print_summary() {
  local app_host gateway_host preview_host gateway_preview
  app_host="$(env_get APP_HOST)"
  gateway_host="$(env_get GATEWAY_APP_HOST)"
  preview_host="$(env_get PREVIEW_DOMAIN)"
  gateway_preview="$(env_get GATEWAY_PREVIEW_HTTP_PORT 8080)"
  printf '\n'
  log "部署完成。"
  printf '  应用入口   : %s\n' "${app_host:-https://${gateway_host}}"
  printf '  网关自检   : http://127.0.0.1:%s/health\n' "${GATEWAY_HTTP_PORT}"
  printf '  预览域     : %s%s\n' "${preview_host}" "$(env_get PREVIEW_PUBLIC_BASE_PATH /preview)"
  printf '  预览域自检 : http://127.0.0.1:%s/health\n' "${gateway_preview}"
  printf '  管理员账号 : %s（密码见 %s 的 ADMIN_PASSWORD，首次登录后请立即改）\n' "$(env_get ADMIN_USERNAME admin)" "${ENV_FILE}"
  printf '  数据目录   : %s\n' "${DATA_ROOT}"
  printf '  compose    : %s\n' "${COMPOSE[*]} -p ${PROJECT_NAME} -f ${COMPOSE_FILE}"
  printf '\n下一步：\n'
  printf '  1) 域名/证书：改 .env 的 GATEWAY_*_HOST，TLS 见 deploy/gateway/nginx.conf 文末注释\n'
  printf '  2) 定时备份：crontab -e  加一行  30 3 * * * %s/backup.sh >> %s/logs/backup.log 2>&1\n' "${SCRIPT_DIR}" "${DATA_ROOT}"
  printf '  3) MCP 客户端指向 https://%s/mcp（Bearer 令牌在应用「令牌」页生成）\n' "${gateway_host}"
  printf '  4) 排障手册：deploy/README.md\n'
}

main() {
  parse_args "$@"
  [[ -f "${COMPOSE_FILE}" ]] || die "缺少 ${COMPOSE_FILE}（请在仓库内运行本脚本）"
  check_docker
  detect_compose
  ensure_env_file
  load_deploy_vars
  validate_env
  ensure_dirs
  check_ports

  if ! confirm "将构建并启动 有招（数据目录 ${DATA_ROOT}），继续？"; then
    die "已取消（未做任何改动）"
  fi

  log "构建镜像（首次会拉取基础镜像并安装依赖，耗时较长）"
  compose build
  log "启动容器"
  compose up -d

  if ! wait_for_health "http://127.0.0.1:${GATEWAY_HTTP_PORT}/health" "api + gateway"; then
    die "健康检查失败：${COMPOSE[*]} -p ${PROJECT_NAME} -f ${COMPOSE_FILE} logs --tail=100 api"
  fi
  print_summary
}

main "$@"
