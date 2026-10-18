#!/usr/bin/env bash
# =============================================================================
# restore.sh — 有招单机版：从备份恢复（必须二次确认；恢复前自动再备份当前状态）
#   安全设计：
#     1) 先校验备份完整（MANIFEST 存在、无 .incomplete、SHA256SUMS 全部匹配）
#     2) 二次确认：先 y/N，再要求逐字输入 RESTORE（--force 可跳过第二问，仅供演示/CI）
#     3) 自动对「当前状态」再做一次备份，把它的路径作为撤销点打印出来
#     4) 只停 api/web/gateway，postgres 保持运行；数据库用 DROP+CREATE 后 pg_restore 还原
#     5) 删除产物目录前校验路径必须在 DATA_ROOT 之下（防手滑）
#   幂等：重复执行同一份备份会收敛到同一状态（不追加、不合并）。
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
HEALTH_TIMEOUT="300"
CONFIRM_TOKEN="RESTORE"
PREVIEWS_UID="1000"
PREVIEWS_GID="1000"
COMPOSE=()

# ── 开关 ────────────────────────────────────────────────────────────────────
ASSUME_YES=0
FORCE=0
DO_DB=1
DO_FILES=1
SAFETY_BACKUP=1
SKIP_VERIFY=0
BACKUP_DIR=""

# =============================================================================
# 输出与帮助
# =============================================================================
log()  { printf '\033[32m▸\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
restore.sh — 有招单机版：从备份恢复

用法：
  bash deploy/scripts/restore.sh <备份目录> [选项]
  bash deploy/scripts/restore.sh --list          # 列出可用备份

参数：
  <备份目录>        backup.sh 产生的目录，如 /data/youzhao/backups/20261019-033000

选项：
  -h, --help        显示本帮助并退出
      --list        列出 <DATA_ROOT>/backups 下的备份（含时间、大小、是否完整）后退出
  -y, --yes         跳过第一道 y/N 确认（第二道「逐字输入 RESTORE」仍然要）
      --force       跳过全部确认（危险：仅用于演示/CI，务必确认目录选对）
      --db-only     只恢复数据库
      --files-only  只恢复产物目录（previews/uploads）
      --no-safety-backup  不先备份当前状态（危险：将失去撤销点）
      --skip-verify 跳过 SHA256SUMS 校验（备份文件被手工改过时才用）
      --keep N      安全备份的保留份数（默认取 .env 的 BACKUP_KEEP，再默认 7）

流程：校验备份 → 二次确认 → 备份当前状态（撤销点）→ 停 api/web/gateway
      → DROP/CREATE 数据库 + pg_restore → 覆盖产物目录 → 起服务 → 等健康 → 打印结果

注意：数据库恢复是「整库替换」，不是合并；备份比当前数据旧时，期间的新数据会消失。
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

wait_service_health() {
  local service="$1" timeout="$2" start now status
  start="$(date +%s)"
  log "等 ${service} 健康（最多 ${timeout}s）"
  while :; do
    status="$(container_health "$(container_of "${service}")")"
    case "${status}" in
      healthy) log "✓ ${service} 健康"; return 0 ;;
      none)    log "✓ ${service} 已运行"; return 0 ;;
    esac
    now="$(date +%s)"
    (( now - start < timeout )) || { warn "✗ ${service} 未在 ${timeout}s 内健康（最后状态：${status}）"; return 1; }
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

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$@"
  else
    shasum -a 256 "$@"
  fi
}

scope_text() {                      # 人类可读的「本次恢复范围」
  local s=""
  if (( DO_DB )); then s="${s}数据库 "; fi
  if (( DO_FILES )); then s="${s}产物目录 "; fi
  if [[ -z "${s}" ]]; then s="（无）"; fi
  printf '%s' "${s}"
}

# =============================================================================
# 路径安全
# =============================================================================
assert_path_in_data_root() {
  local p="$1" label="$2"
  case "${p}" in
    "${DATA_ROOT%/}"/*) ;;
    *) die "${label} 不在 DATA_ROOT(${DATA_ROOT}) 之下：${p}（拒绝操作）" ;;
  esac
  [[ "${p}" != "${DATA_ROOT%/}" ]] || die "${label} 不能是 DATA_ROOT 本身"
}

# =============================================================================
# 参数
# =============================================================================
LIST_ONLY=0

parse_args() {
  while (( $# > 0 )); do
    case "$1" in
      -h|--help) usage; exit 0 ;;
      --list) LIST_ONLY=1 ;;
      -y|--yes) ASSUME_YES=1 ;;
      --force) FORCE=1 ;;
      --db-only) DO_FILES=0 ;;
      --files-only) DO_DB=0 ;;
      --no-safety-backup) SAFETY_BACKUP=0 ;;
      --skip-verify) SKIP_VERIFY=1 ;;
      --keep)
        [[ $# -ge 2 ]] || die "--keep 需要份数"
        BACKUP_KEEP="$2"; shift ;;
      -*) die "未知参数：$1（用 --help 查看用法）" ;;
      *)
        [[ -z "${BACKUP_DIR}" ]] || die "只能指定一个备份目录（已指定 ${BACKUP_DIR}）"
        BACKUP_DIR="$1" ;;
    esac
    shift
  done
  case "${BACKUP_KEEP}" in ''|*[!0-9]*) die "BACKUP_KEEP 必须是非负整数" ;; esac
}

list_backups() {
  local root="${DATA_ROOT}/backups" d size flag
  [[ -d "${root}" ]] || { warn "没有备份目录：${root}"; return 0; }
  printf '%-22s %10s  %s\n' "备份" "大小" "状态"
  while IFS= read -r d; do
    [[ -n "${d}" ]] || continue
    size="$(du -sh "${d}" 2>/dev/null | cut -f1)"
    flag="完整"
    [[ -f "${d}/.incomplete" ]] && flag="不完整(勿用)"
    [[ -f "${d}/MANIFEST" ]] || flag="缺 MANIFEST(勿用)"
    printf '%-22s %10s  %s\n' "$(basename "${d}")" "${size}" "${flag}"
  done < <(find "${root}" -mindepth 1 -maxdepth 1 -type d | sort)
}

# =============================================================================
# 校验备份
# =============================================================================
verify_backup() {
  local dir="$1"
  [[ -d "${dir}" ]] || die "备份目录不存在：${dir}"
  [[ -f "${dir}/MANIFEST" ]] || die "缺少 ${dir}/MANIFEST：这不是 backup.sh 产生的备份"
  [[ -f "${dir}/.incomplete" ]] && die "备份不完整（存在 ${dir}/.incomplete）：请改用更早的备份"
  if (( DO_DB )) && [[ ! -s "${dir}/db.dump" ]]; then
    die "备份里没有 db.dump（或为空）：该备份可能是用 --files-only 生成的；用 --files-only 恢复，或换备份"
  fi
  [[ -f "${dir}/SHA256SUMS" ]] || { warn "缺少 SHA256SUMS，跳过校验"; return 0; }
  (( SKIP_VERIFY )) && { warn "已跳过 SHA256SUMS 校验（--skip-verify）"; return 0; }
  log "校验备份校验和（SHA256SUMS）"
  ( cd "${dir}" && sha256_of -c SHA256SUMS >/dev/null ) \
    || die "备份校验和不匹配：文件可能损坏，请换一份备份（或确认后加 --skip-verify）"
}

manifest_get() {
  local dir="$1" key="$2" line=""
  line="$(grep -E "^${key}=" "${dir}/MANIFEST" 2>/dev/null | head -n 1 || true)"
  printf '%s' "${line#*=}"
}

# =============================================================================
# 确认
# =============================================================================
confirm_restore() {
  local dir="$1" reply="" token=""
  local m_db m_env m_created m_files
  m_db="$(manifest_get "${dir}" POSTGRES_DB)"
  m_env="$(manifest_get "${dir}" APP_ENV)"
  m_created="$(manifest_get "${dir}" CREATED_AT)"
  printf '\n将要恢复：\n'
  printf '  备份目录   : %s\n' "${dir}"
  printf '  备份时间   : %s\n' "${m_created:-未知}"
  printf '  备份时环境 : APP_ENV=%s POSTGRES_DB=%s\n' "${m_env:-未知}" "${m_db:-未知}"
  printf '  本机环境   : APP_ENV=%s POSTGRES_DB=%s\n' "$(env_get APP_ENV development)" "$(env_get POSTGRES_DB youzhao)"
  printf '  恢复范围   : %s\n' "$(scope_text)"
  printf '\n当前数据库与产物目录将被整体替换（不是合并）。\n\n'

  if (( FORCE )); then
    warn "--force：跳过全部确认（这是危险操作）"
    return 0
  fi
  if (( ! ASSUME_YES )); then
    read -r -p "确认要从这份备份恢复？[y/N] " reply || true
    case "${reply}" in [Yy]*) ;; *) die "已取消（未做任何改动）" ;; esac
  fi
  printf '二次确认：请逐字输入 %s 以继续（其他输入 = 取消）：' "${CONFIRM_TOKEN}"
  read -r token || true
  [[ "${token}" == "${CONFIRM_TOKEN}" ]] || die "确认失败（输入不是 ${CONFIRM_TOKEN}），已取消"
}

# =============================================================================
# 恢复
# =============================================================================
restore_db() {
  local dir="$1" db="$2" user="$3" m_db
  m_db="$(manifest_get "${dir}" POSTGRES_DB)"
  [[ -z "${m_db}" || "${m_db}" == "${db}" ]] || warn "备份的库名(${m_db})与当前 POSTGRES_DB(${db}) 不一致：将还原进 ${db}"

  log "停止 api/web/gateway（postgres 保持运行）"
  compose stop api web gateway 2>/dev/null || true

  log "重建数据库 ${db}（DROP + CREATE，整库替换）"
  compose exec -T postgres psql --username="${user}" --dbname=postgres -v ON_ERROR_STOP=1 \
    -c "DROP DATABASE IF EXISTS \"${db}\" WITH (FORCE);" \
    || die "DROP DATABASE 失败（检查 POSTGRES_USER 是否有权限）"
  compose exec -T postgres psql --username="${user}" --dbname=postgres -v ON_ERROR_STOP=1 \
    -c "CREATE DATABASE \"${db}\" OWNER \"${user}\";" \
    || die "CREATE DATABASE 失败"

  log "pg_restore 导入 ${dir}/db.dump"
  # 仓库内不存在 CONCURRENTLY 索引，因此 --single-transaction 是安全的（失败即整体回滚）
  compose exec -T postgres \
    pg_restore --username="${user}" --dbname="${db}" \
               --no-owner --no-privileges --single-transaction --exit-on-error \
    < "${dir}/db.dump" \
    || die "pg_restore 失败：数据库现在是空库，请检查备份文件或重跑本脚本换一份备份"
  log "数据库已还原"
}

restore_files() {
  local dir="$1" archive target
  for target in previews uploads; do
    archive="${dir}/${target}.tar.gz"
    [[ -f "${archive}" ]] || { [[ "${target}" == "uploads" ]] || warn "备份里没有 ${target}.tar.gz，跳过"; continue; }
    assert_path_in_data_root "${DATA_ROOT}/${target}" "${target} 目录"
    log "还原 ${target}（先清空 ${DATA_ROOT}/${target}）"
    rm -rf "${DATA_ROOT:?}/${target}"
    mkdir -p "${DATA_ROOT}/${target}"
    tar -xzf "${archive}" -C "${DATA_ROOT}" || die "解包 ${archive} 失败"
    if [[ "${target}" == "previews" ]]; then
      if [[ "$(id -u)" == "0" ]]; then
        chown -R "${PREVIEWS_UID}:${PREVIEWS_GID}" "${DATA_ROOT}/${target}"
      else
        warn "非 root：未调整 ${DATA_ROOT}/${target} 属主；api 容器内是 uid ${PREVIEWS_UID}，若发布报 EACCES 请执行 sudo chown -R ${PREVIEWS_UID}:${PREVIEWS_GID} ${DATA_ROOT}/${target}"
      fi
    fi
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

  if (( LIST_ONLY )); then list_backups; return 0; fi
  [[ -n "${BACKUP_DIR}" ]] || die "缺少参数：备份目录（--help 查看用法，--list 列出可用备份）"
  BACKUP_DIR="${BACKUP_DIR%/}"
  case "${BACKUP_DIR}" in
    /*) ;;
    *) die "备份目录必须是绝对路径：${BACKUP_DIR}" ;;
  esac

  verify_backup "${BACKUP_DIR}"
  confirm_restore "${BACKUP_DIR}"

  local safety_dir=""
  if (( SAFETY_BACKUP )); then
    log "先备份当前状态（作为撤销点）"
    safety_dir="$(bash "${SCRIPT_DIR}/backup.sh" --keep "${BACKUP_KEEP}" | tail -n 1)"
    [[ -n "${safety_dir}" ]] || die "当前状态备份失败：为安全起见中止恢复"
    log "撤销点：${safety_dir}"
  else
    warn "已跳过恢复前备份（--no-safety-backup）：本次没有撤销点"
  fi

  local db user
  db="$(env_get POSTGRES_DB youzhao)"
  user="$(env_get POSTGRES_USER youzhao)"

  if (( DO_DB )); then
    restore_db "${BACKUP_DIR}" "${db}" "${user}"
  else
    log "跳过数据库恢复（--files-only）"
  fi

  if (( DO_FILES )); then
    restore_files "${BACKUP_DIR}"
  else
    log "跳过产物恢复（--db-only）"
  fi

  log "启动服务"
  compose up -d
  if ! wait_service_health api "${HEALTH_TIMEOUT}"; then
    compose logs --tail=80 api >&2 || true
    warn "api 未健康。撤销点：${safety_dir:-（无）}"
    die "恢复后 api 启动失败：可用撤销点再恢复一次，或查看上面日志"
  fi
  compose up -d --no-deps --force-recreate gateway >/dev/null 2>&1 || true
  wait_service_health gateway 60 || warn "gateway 未健康（检查端口冲突）"

  local port
  port="$(env_get GATEWAY_HTTP_PORT 80)"
  http_ok "http://127.0.0.1:${port}/health" && log "网关 /health 通过"

  printf '\n'
  log "恢复完成：${BACKUP_DIR}"
  printf '  撤销点     : %s\n' "${safety_dir:-（本次未创建；--no-safety-backup）}"
  printf '  还原内容   : %s\n' "$(scope_text)"
  printf '  提示       : 恢复的数据库若来自更早版本，api 启动时会自动把缺失的迁移补上\n'
  printf '  提示       : 备份里的 env.backup 只是快照；deploy/.env 未被覆盖（密钥仍以本机为准）\n'
}

main "$@"
