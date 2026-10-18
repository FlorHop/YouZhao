#!/usr/bin/env bash
# =============================================================================
# upgrade.sh — 有招单机版：升级（先备份 → 构建 → 起服务 → 等健康 → 失败给回滚指引）
#   顺序刻意如此：任何一步失败都不会丢掉「升级前」的数据快照。
#   数据库迁移由 api 容器启动时执行（db/migrate.ts），因此只要 api 健康即视为迁移完成。
#   幂等：重复执行只是再构建/重启一次，不会重复迁移（迁移表记录已应用版本）。
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
ENV_FILE="${DEPLOY_DIR}/.env"
COMPOSE_FILE="${DEPLOY_DIR}/compose.yaml"

# ── 可变项（默认值；可在 deploy/.env 里覆盖）───────────────────────────────
PROJECT_NAME="youzhao"
DATA_ROOT="/data/youzhao"
HEALTH_TIMEOUT="300"
GATEWAY_HTTP_PORT="80"
GATEWAY_PREVIEW_HTTP_PORT="8080"
BACKUP_KEEP="7"
BACKUP_BEFORE=1
PULL_BASE=0
ASSUME_YES=0
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
upgrade.sh — 有招单机版：升级到当前代码

用法：
  bash deploy/scripts/upgrade.sh [选项]

选项：
  -h, --help          显示本帮助并退出
  -y, --yes           无人值守：不交互确认
      --no-backup     跳过升级前备份（不推荐：升完才发现问题就没有还原点了）
      --pull          构建前先拉取基础镜像（Dockerfile/依赖有更新时用）
      --keep N        备份保留份数（默认取 .env 的 BACKUP_KEEP，再默认 7）
      --timeout N     等 api 健康的秒数（默认取 .env 的 UPGRADE_HEALTH_TIMEOUT，再默认 300）

流程：备份 → compose build → compose up -d → 等 api 健康 → 重建 gateway（刷新 upstream IP）
      → 健康则结束；不健康则打印回滚指引并用非零码退出（数据保持升级前状态）。

回滚三条路：
  1) 只回滚镜像：git checkout <升级前的 commit>，再跑一次本脚本（脚本会先备份当前状态）
  2) 只回滚数据：bash deploy/scripts/restore.sh <升级前那次备份目录>
  3) 一起回滚：先 1) 再 2)
EOF
}

# =============================================================================
# .env 读取（同 install.sh：不 source，避免值被执行）
# =============================================================================
env_get() {
  local key="$1" fallback="${2-}" line value
  if [[ ! -f "${ENV_FILE}" ]]; then printf '%s' "${fallback}"; return 0; fi
  line="$(grep -E "^[[:space:]]*${key}=" "${ENV_FILE}" 2>/dev/null | tail -n 1 || true)"
  if [[ -z "${line}" ]]; then printf '%s' "${fallback}"; return 0; fi
  value="${line#*=}"
  value="${value%$'\r'}"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  case "${value}" in
    *[[:space:]]'#'*) value="${value%%[[:space:]]'#'*}" ;;
  esac
  value="${value%"${value##*[![:space:]]}"}"
  case "${value}" in
    \"*\") value="${value#\"}"; value="${value%\"}" ;;
    \'*\') value="${value#\'}"; value="${value%\'}" ;;
  esac
  printf '%s' "${value}"
}

load_deploy_vars() {
  PROJECT_NAME="$(env_get COMPOSE_PROJECT_NAME youzhao)"
  DATA_ROOT="$(env_get DATA_ROOT /data/youzhao)"
  GATEWAY_HTTP_PORT="$(env_get GATEWAY_HTTP_PORT 80)"
  GATEWAY_PREVIEW_HTTP_PORT="$(env_get GATEWAY_PREVIEW_HTTP_PORT 8080)"
  BACKUP_KEEP="$(env_get BACKUP_KEEP "${BACKUP_KEEP}")"
  if (( ! TIMEOUT_SET )); then
    HEALTH_TIMEOUT="$(env_get UPGRADE_HEALTH_TIMEOUT "${HEALTH_TIMEOUT}")"
  fi
  [[ -n "${PROJECT_NAME}" ]] || PROJECT_NAME="youzhao"
  [[ -n "${DATA_ROOT}" ]] || DATA_ROOT="/data/youzhao"
  [[ -n "${GATEWAY_HTTP_PORT}" ]] || GATEWAY_HTTP_PORT="80"
  [[ -n "${GATEWAY_PREVIEW_HTTP_PORT}" ]] || GATEWAY_PREVIEW_HTTP_PORT="8080"
  [[ -n "${BACKUP_KEEP}" ]] || BACKUP_KEEP="7"
  [[ -n "${HEALTH_TIMEOUT}" ]] || HEALTH_TIMEOUT="300"
}

# =============================================================================
# docker / compose
# =============================================================================
check_docker() {
  command -v docker >/dev/null 2>&1 || die "未找到 docker"
  docker info >/dev/null 2>&1 || die "docker 守护进程不可用（docker info 失败）"
}

detect_compose() {
  if docker compose version >/dev/null 2>&1; then
    COMPOSE=(docker compose)
  elif command -v docker-compose >/dev/null 2>&1; then
    COMPOSE=(docker-compose)
  else
    die "未找到 docker compose（需要 v2 插件，或独立的 docker-compose 1.29+）"
  fi
}

compose() { "${COMPOSE[@]}" -p "${PROJECT_NAME}" -f "${COMPOSE_FILE}" "$@"; }

container_of() { compose ps -q "$1" 2>/dev/null | head -n 1; }

container_health() {                # 打印 starting/healthy/unhealthy/none/unknown
  local cid="$1"
  [[ -n "${cid}" ]] || { printf 'unknown'; return 0; }
  docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "${cid}" 2>/dev/null \
    || printf 'unknown'
}

wait_service_health() {
  local service="$1" timeout="$2" start now cid status
  start="$(date +%s)"
  log "等 ${service} 健康（最多 ${timeout}s）"
  while :; do
    cid="$(container_of "${service}")"
    status="$(container_health "${cid}")"
    case "${status}" in
      healthy) log "✓ ${service} 健康"; return 0 ;;
      none)    log "✓ ${service} 已运行（该容器未定义 healthcheck）"; return 0 ;;
    esac
    now="$(date +%s)"
    if (( now - start >= timeout )); then
      warn "✗ ${service} 在 ${timeout}s 内未健康（最后状态：${status}）"
      return 1
    fi
    sleep 3
  done
}

http_ok() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsS -o /dev/null --max-time 5 "$1" >/dev/null 2>&1
  else
    wget -q -O /dev/null --timeout=5 "$1" >/dev/null 2>&1
  fi
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
      --no-backup) BACKUP_BEFORE=0 ;;
      --pull) PULL_BASE=1 ;;
      --keep)
        [[ $# -ge 2 ]] || die "--keep 需要份数"
        BACKUP_KEEP="$2"; shift ;;
      --timeout)
        [[ $# -ge 2 ]] || die "--timeout 需要秒数"
        HEALTH_TIMEOUT="$2"; TIMEOUT_SET=1; shift ;;
      *) die "未知参数：$1（用 --help 查看用法）" ;;
    esac
    shift
  done
}

snapshot_state() {
  local log_dir="${DATA_ROOT}/logs" out
  mkdir -p "${log_dir}" 2>/dev/null || true
  out="${log_dir}/upgrade-$(date +%Y%m%d-%H%M%S).txt"
  {
    printf 'time=%s\n' "$(date -Iseconds)"
    printf 'host=%s\n' "$(hostname)"
    printf 'cwd=%s\n' "${DEPLOY_DIR}"
    if command -v git >/dev/null 2>&1; then
      printf 'git_sha=%s\n' "$(git -C "${DEPLOY_DIR}" rev-parse --short HEAD 2>/dev/null || printf unknown)"
      printf 'git_branch=%s\n' "$(git -C "${DEPLOY_DIR}" rev-parse --abbrev-ref HEAD 2>/dev/null || printf unknown)"
      printf 'git_dirty=%s\n' "$(git -C "${DEPLOY_DIR}" status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
    fi
    local svc cid
    for svc in postgres api web gateway; do
      cid="$(container_of "${svc}")"
      if [[ -n "${cid}" ]]; then
        printf '%s.container=%s\n' "${svc}" "${cid}"
        printf '%s.image_id=%s\n' "${svc}" "$(docker inspect -f '{{.Image}}' "${cid}" 2>/dev/null || printf unknown)"
        printf '%s.image_ref=%s\n' "${svc}" "$(docker inspect -f '{{.Config.Image}}' "${cid}" 2>/dev/null || printf unknown)"
      fi
    done
  } > "${out}" 2>/dev/null || true
  printf '%s' "${out}"
}

rollback_hint() {
  local phase="$1" backup_dir="${2:-}" pre_state="${3:-}"
  printf '\n' >&2
  warn "升级失败（阶段：${phase}）。数据未被破坏。"
  printf '  回滚指引：\n' >&2
  [[ -n "${pre_state}" ]] && printf '  1) 升级前状态快照（commit/镜像 ID）：%s\n' "${pre_state}" >&2
  [[ -n "${backup_dir}" ]] && printf '  2) 升级前数据备份（可直接还原）：%s\n' "${backup_dir}" >&2
  printf '  3) 还原数据：bash %s/restore.sh %s\n' "${SCRIPT_DIR}" "${backup_dir:-<备份目录>}" >&2
  printf '  4) 回退代码：git checkout <升级前的 commit>，再跑一次本脚本\n' >&2
  printf '  5) 看日志：%s -p %s -f %s logs --tail=200 api\n' "${COMPOSE[*]}" "${PROJECT_NAME}" "${COMPOSE_FILE}" >&2
  printf '  6) 只重启网关：%s -p %s -f %s up -d --no-deps --force-recreate gateway\n' "${COMPOSE[*]}" "${PROJECT_NAME}" "${COMPOSE_FILE}" >&2
  printf '\n  注意：数据库迁移是单向的（向后兼容字段用「加列」实现）。若新版本已改过数据，\n' >&2
  printf '        仅回退镜像可能因结构不匹配而起不来；此时请连数据一起还原（第 2/3 步）。\n' >&2
}

# =============================================================================
# 主流程
# =============================================================================
main() {
  parse_args "$@"
  [[ -f "${COMPOSE_FILE}" ]] || die "缺少 ${COMPOSE_FILE}"
  [[ -f "${ENV_FILE}" ]] || die "缺少 ${ENV_FILE}：请先跑 bash deploy/scripts/install.sh"
  check_docker
  detect_compose
  load_deploy_vars

  local pre_state="" backup_dir="" phase="preflight"
  trap 'rollback_hint "${phase}" "${backup_dir}" "${pre_state}"' ERR

  phase="preflight"
  compose config -q || die "compose 配置校验失败（deploy/.env 或 compose.yaml 有问题）"
  pre_state="$(snapshot_state)"
  [[ -n "${pre_state}" ]] && log "升级前状态已记录：${pre_state}"

  phase="backup"
  if (( BACKUP_BEFORE )); then
    log "先备份（失败即中止升级）"
    backup_dir="$(bash "${SCRIPT_DIR}/backup.sh" --keep "${BACKUP_KEEP}" | tail -n 1)"
    [[ -n "${backup_dir}" ]] || die "备份脚本未返回备份目录"
    log "备份完成：${backup_dir}"
  else
    warn "已跳过升级前备份（--no-backup）：本次没有自动还原点"
  fi

  phase="build"
  if (( PULL_BASE )); then
    log "构建镜像（--pull 先刷新基础镜像）"
    compose build --pull
  else
    log "构建镜像"
    compose build
  fi

  phase="up"
  log "启动容器"
  compose up -d --remove-orphans

  phase="health"
  if ! wait_service_health api "${HEALTH_TIMEOUT}"; then
    compose logs --tail=80 api >&2 || true
    die "api 未能健康（迁移或启动失败）"
  fi

  phase="gateway"
  # api 容器重建后 IP 会变，而网关用的是静态 upstream，必须重建网关以刷新解析
  log "重建 gateway（刷新 upstream IP）"
  compose up -d --no-deps --force-recreate gateway

  phase="verify"
  if ! wait_service_health gateway 60; then
    compose logs --tail=40 gateway >&2 || true
    die "gateway 未能健康"
  fi

  if [[ -n "${GATEWAY_HTTP_PORT}" ]] && ! http_ok "http://127.0.0.1:${GATEWAY_HTTP_PORT}/health"; then
    warn "网关 /health 未通过：可能是端口冲突或上游未就绪"
    die "网关自检失败"
  fi

  trap - ERR
  printf '\n'
  log "升级完成。"
  printf '  应用入口   : %s\n' "$(env_get APP_HOST "https://$(env_get GATEWAY_APP_HOST)")"
  printf '  预览域     : %s\n' "$(env_get PREVIEW_DOMAIN)"
  [[ -n "${backup_dir}" ]] && printf '  升级前备份 : %s（出问题用 restore.sh 还原）\n' "${backup_dir}"
  [[ -n "${pre_state}" ]] && printf '  状态快照   : %s\n' "${pre_state}"
  printf '  健康快照   : api=%s gateway=%s\n' "$(container_health "$(container_of api)")" "$(container_health "$(container_of gateway)")"
}

main "$@"
