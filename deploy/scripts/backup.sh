#!/usr/bin/env bash
# =============================================================================
# backup.sh — 有招单机版：备份（PostgreSQL 逻辑导出 + 预览/上传产物 + 部署配置）
#   产物：<DATA_ROOT>/backups/<时间戳>/ 内含
#     db.dump        pg_dump 自定义格式（用 restore.sh / pg_restore 还原）
#     previews.tar.gz / uploads.tar.gz   产物目录打包（uploads 不存在时跳过）
#     env.backup     deploy/.env 快照（含密钥，目录权限 700，请勿外传）
#     compose.yaml / gateway-nginx.conf  部署配置快照
#     MANIFEST      版本、时间、服务、卷、数据库、文件大小与校验和
#     SHA256SUMS    全部归档文件的校验和
#   幂等：同一秒内重复执行会写进同一目录（覆盖同名文件）；正常情况下每次产生新目录。
#   清理：只按 --keep N 清理 backups/ 下符合时间戳命名的旧目录，不动其他任何路径。
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
ENV_FILE="${DEPLOY_DIR}/.env"
COMPOSE_FILE="${DEPLOY_DIR}/compose.yaml"

# ── 可变项（默认值；可在 deploy/.env 里覆盖）───────────────────────────────
PROJECT_NAME="youzhao"
DATA_ROOT="/data/youzhao"
BACKUP_KEEP="7"
PG_READY_TIMEOUT="120"
COMPOSE=()
# 当前正在写的备份目录（全局，供 EXIT trap 使用；局部变量在 main 返回后已失效）
BACKUP_DIR_CURRENT=""

# =============================================================================
# 输出与帮助
# =============================================================================
log()  { printf '\033[32m▸\033[0m %s\n' "$*" >&2; }
warn() { printf '\033[33m!\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
backup.sh — 有招单机版：备份

用法：
  bash deploy/scripts/backup.sh [选项]

选项：
  -h, --help        显示本帮助并退出
  -o, --out DIR     备份根目录（默认 <DATA_ROOT>/backups）
      --keep N      保留最近 N 份（默认取 .env 的 BACKUP_KEEP，再默认 7；0 = 不清理）
      --no-prune    不清理旧备份
      --db-only     只导出数据库（不打包产物）
      --files-only  只打包产物（不导出数据库）

约定：
  * 数据库用 pg_dump 自定义格式（逻辑备份、可跨小版本还原），必须 postgres 容器健康时才执行；
  * 产物用 tar 打包（保留权限）；.env 快照含密钥，目录 700、文件 600；
  * 结束时把「备份目录绝对路径」作为最后一行打到 stdout（供 upgrade.sh 等脚本捕获），
    其余日志都走 stderr，因此 `backup_dir="$(backup.sh | tail -n 1)"` 是安全的。

定时任务示例（每天 03:30，保留 14 份）：
  30 3 * * * /path/to/deploy/scripts/backup.sh --keep 14 >> /data/youzhao/logs/backup.log 2>&1
EOF
}

# =============================================================================
# .env 读取（不 source）
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
  BACKUP_KEEP="$(env_get BACKUP_KEEP "${BACKUP_KEEP}")"
  [[ -n "${PROJECT_NAME}" ]] || PROJECT_NAME="youzhao"
  [[ -n "${DATA_ROOT}" ]] || DATA_ROOT="/data/youzhao"
  [[ -n "${BACKUP_KEEP}" ]] || BACKUP_KEEP="7"
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
    die "未找到 docker compose"
  fi
}

compose() { "${COMPOSE[@]}" -p "${PROJECT_NAME}" -f "${COMPOSE_FILE}" "$@"; }

container_of() { compose ps -q "$1" 2>/dev/null | head -n 1; }

container_health() {
  local cid="$1"
  [[ -n "${cid}" ]] || { printf 'unknown'; return 0; }
  docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "${cid}" 2>/dev/null \
    || printf 'unknown'
}

wait_postgres() {
  local timeout="$1" start now cid
  start="$(date +%s)"
  while :; do
    cid="$(container_of postgres)"
    if [[ -z "${cid}" ]]; then
      now="$(date +%s)"
      (( now - start < timeout )) || die "postgres 容器未运行：先 bash deploy/scripts/install.sh"
      sleep 3; continue
    fi
    case "$(container_health "${cid}")" in
      healthy) return 0 ;;
    esac
    now="$(date +%s)"
    (( now - start < timeout )) || die "postgres 在 ${timeout}s 内未健康，放弃备份"
    sleep 3
  done
}

sha256_of() {                       # 打印 "<hash>  <文件名>"，兼容 coreutils / BSD
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$@" | sed 's#  \./#  #'
  else
    shasum -a 256 "$@" | sed 's#  \./#  #'
  fi
}

# =============================================================================
# 参数
# =============================================================================
BACKUP_ROOT=""
DO_DB=1
DO_FILES=1
PRUNE=1

parse_args() {
  while (( $# > 0 )); do
    case "$1" in
      -h|--help) usage; exit 0 ;;
      -o|--out)
        [[ $# -ge 2 ]] || die "--out 需要一个目录"
        BACKUP_ROOT="$2"; shift ;;
      --keep)
        [[ $# -ge 2 ]] || die "--keep 需要份数"
        BACKUP_KEEP="$2"; shift ;;
      --no-prune) PRUNE=0 ;;
      --db-only) DO_FILES=0 ;;
      --files-only) DO_DB=0 ;;
      *) die "未知参数：$1（用 --help 查看用法）" ;;
    esac
    shift
  done
  case "${BACKUP_KEEP}" in ''|*[!0-9]*) die "BACKUP_KEEP 必须是非负整数（当前 ${BACKUP_KEEP}）" ;; esac
}

# 只允许删除 <DATA_ROOT>/backups 下的时间戳目录，防止路径写错删到别处
assert_prunable() {
  local dir="$1"
  case "${dir}" in
    "${BACKUP_ROOT%/}"/*) ;;
    *) die "拒绝清理不在备份根目录下的路径：${dir}" ;;
  esac
  [[ "${dir}" != "${BACKUP_ROOT%/}" ]] || die "拒绝清理备份根目录本身"
  case "$(basename "${dir}")" in
    [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]-[0-9][0-9][0-9][0-9][0-9][0-9]) ;;
    *) die "拒绝清理非时间戳命名目录：${dir}" ;;
  esac
}

prune_old() {
  local keep="$1" i=0 d dirs=()
  (( keep > 0 )) || { log "不清理旧备份（--keep 0）"; return 0; }
  while IFS= read -r d; do
    [[ -n "${d}" ]] && dirs+=("${d}")
  done < <(find "${BACKUP_ROOT}" -mindepth 1 -maxdepth 1 -type d -name '[0-9]*-[0-9]*' 2>/dev/null | sort -r)
  for d in "${dirs[@]}"; do
    i=$((i + 1))
    (( i <= keep )) && continue
    assert_prunable "${d}"
    rm -rf "${d}"
    log "已清理旧备份：${d}"
  done
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
  [[ -n "${BACKUP_ROOT}" ]] || BACKUP_ROOT="${DATA_ROOT}/backups"
  BACKUP_ROOT="${BACKUP_ROOT%/}"
  case "${BACKUP_ROOT}" in
    /*) ;;
    *) die "备份根目录必须是绝对路径：${BACKUP_ROOT}" ;;
  esac
  [[ "${BACKUP_ROOT}" != "/" ]] || die "备份根目录不能是 /（--out / 会允许在根目录下按时间戳名批量删除）"

  local ts stamp dir db_name db_user db_host db_port
  ts="$(date +%Y%m%d-%H%M%S)"
  dir="${BACKUP_ROOT}/${ts}"
  BACKUP_DIR_CURRENT="${dir}"
  db_name="$(env_get POSTGRES_DB youzhao)"
  db_user="$(env_get POSTGRES_USER youzhao)"
  db_host="$(env_get POSTGRES_HOST postgres)"
  db_port="$(env_get POSTGRES_PORT 5432)"

  mkdir -p "${dir}"
  chmod 700 "${dir}"
  : > "${dir}/.incomplete"          # restore.sh 见到它就拒绝这份备份（写到一半的备份不可信）
  trap 'warn "备份中断：保留 ${BACKUP_DIR_CURRENT}（含 .incomplete 标记，restore.sh 会拒绝它）"' EXIT

  # ── 数据库 ────────────────────────────────────────────────────────────────
  if (( DO_DB )); then
    wait_postgres "${PG_READY_TIMEOUT}"
    log "导出数据库 ${db_name}（pg_dump -Fc）"
    compose exec -T postgres \
      pg_dump --username="${db_user}" --dbname="${db_name}" \
              --format=custom --no-owner --no-privileges \
      > "${dir}/db.dump" \
      || die "pg_dump 失败：检查 postgres 容器日志与 POSTGRES_* 配置"
    [[ -s "${dir}/db.dump" ]] || die "pg_dump 产物为空（${dir}/db.dump）"
    log "已导出 db.dump（$(du -h "${dir}/db.dump" | cut -f1)）"
  else
    log "跳过数据库导出（--files-only）"
  fi

  # ── 产物目录 ─────────────────────────────────────────────────────────────
  if (( DO_FILES )); then
    if [[ -d "${DATA_ROOT}/previews" ]]; then
      log "打包 ${DATA_ROOT}/previews"
      tar -czf "${dir}/previews.tar.gz" -C "${DATA_ROOT}" previews
    else
      warn "缺少 ${DATA_ROOT}/previews，跳过产物打包"
    fi
    if [[ -d "${DATA_ROOT}/uploads" ]]; then
      log "打包 ${DATA_ROOT}/uploads"
      tar -czf "${dir}/uploads.tar.gz" -C "${DATA_ROOT}" uploads
    fi
  else
    log "跳过产物打包（--db-only）"
  fi

  # ── 部署配置 ─────────────────────────────────────────────────────────────
  cp "${ENV_FILE}" "${dir}/env.backup" && chmod 600 "${dir}/env.backup"
  cp "${COMPOSE_FILE}" "${dir}/compose.yaml"
  [[ -f "${DEPLOY_DIR}/gateway/nginx.conf" ]] && cp "${DEPLOY_DIR}/gateway/nginx.conf" "${dir}/gateway-nginx.conf"
  [[ -f "${DEPLOY_DIR}/Dockerfile.api" ]] && cp "${DEPLOY_DIR}/Dockerfile.api" "${dir}/Dockerfile.api"
  [[ -f "${DEPLOY_DIR}/Dockerfile.web" ]] && cp "${DEPLOY_DIR}/Dockerfile.web" "${dir}/Dockerfile.web"

  # ── MANIFEST ─────────────────────────────────────────────────────────────
  local git_sha="unknown" git_branch="unknown"
  if command -v git >/dev/null 2>&1; then
    git_sha="$(git -C "${DEPLOY_DIR}" rev-parse --short HEAD 2>/dev/null || printf unknown)"
    git_branch="$(git -C "${DEPLOY_DIR}" rev-parse --abbrev-ref HEAD 2>/dev/null || printf unknown)"
  fi
  {
    printf 'MANIFEST_VERSION=1\n'
    printf 'CREATED_AT=%s\n' "$(date -Iseconds)"
    printf 'HOSTNAME=%s\n' "$(hostname)"
    printf 'BACKUP_DIR=%s\n' "${dir}"
    printf 'COMPOSE_PROJECT_NAME=%s\n' "${PROJECT_NAME}"
    printf 'COMPOSE_FILE=%s\n' "${COMPOSE_FILE}"
    printf 'APP_ENV=%s\n' "$(env_get APP_ENV development)"
    printf 'DB_DRIVER=%s\n' "$(env_get DB_DRIVER postgres)"
    printf 'POSTGRES_IMAGE=%s\n' "$(env_get POSTGRES_IMAGE postgres:16-alpine)"
    printf 'POSTGRES_HOST=%s\n' "${db_host}"
    printf 'POSTGRES_PORT=%s\n' "${db_port}"
    printf 'POSTGRES_DB=%s\n' "${db_name}"
    printf 'POSTGRES_USER=%s\n' "${db_user}"
    printf 'DATA_ROOT=%s\n' "${DATA_ROOT}"
    printf 'PREVIEW_STORAGE_PATH=%s\n' "$(env_get PREVIEW_STORAGE_PATH /data/youzhao/previews)"
    printf 'PREVIEW_PUBLIC_BASE_PATH=%s\n' "$(env_get PREVIEW_PUBLIC_BASE_PATH /preview)"
    printf 'PREVIEW_DOMAIN=%s\n' "$(env_get PREVIEW_DOMAIN '')"
    printf 'API_JSON_BODY_LIMIT_BYTES=%s\n' "$(env_get API_JSON_BODY_LIMIT_BYTES 5242880)"
    printf 'MCP_PATH=%s\n' "$(env_get MCP_PATH /mcp)"
    printf 'GIT_COMMIT=%s\n' "${git_sha}"
    printf 'GIT_BRANCH=%s\n' "${git_branch}"
    printf 'INCLUDED_DB=%s\n' "$(( DO_DB ))"
    printf 'INCLUDED_FILES=%s\n' "$(( DO_FILES ))"
    printf '\n# images\n'
    local svc cid
    for svc in postgres api web gateway; do
      cid="$(container_of "${svc}")"
      if [[ -n "${cid}" ]]; then
        printf '%s.image_ref=%s\n' "${svc}" "$(docker inspect -f '{{.Config.Image}}' "${cid}" 2>/dev/null || printf unknown)"
        printf '%s.image_id=%s\n' "${svc}" "$(docker inspect -f '{{.Image}}' "${cid}" 2>/dev/null || printf unknown)"
      fi
    done
    printf '\n# files (size_bytes  sha256  name)\n'
    local f
    while IFS= read -r f; do
      printf '%s  %s  %s\n' "$(wc -c < "${f}" | tr -d ' ')" "$(sha256_of "${f}" | cut -d' ' -f1)" "$(basename "${f}")"
    done < <(find "${dir}" -maxdepth 1 -type f ! -name MANIFEST ! -name SHA256SUMS ! -name .incomplete | sort)
  } > "${dir}/MANIFEST"

  # ── 校验和 ───────────────────────────────────────────────────────────────
  ( cd "${dir}" && sha256_of $(find . -maxdepth 1 -type f ! -name SHA256SUMS ! -name .incomplete -exec basename {} \; | sort) > SHA256SUMS )
  rm -f "${dir}/.incomplete"

  # ── 清理 ─────────────────────────────────────────────────────────────────
  if (( PRUNE )); then prune_old "${BACKUP_KEEP}"; fi

  trap - EXIT
  log "备份完成：${dir}"
  printf '%s\n' "${dir}"              # ← 唯一写 stdout 的内容：备份目录路径
}

main "$@"
