#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="${APP_DIR:-/opt/youzhao/app}"
DATA_DIR="${YOUZHAO_DATA_DIR:-/data/youzhao}"
BACKUP_DIR="${YOUZHAO_BACKUP_DIR:-$DATA_DIR/backups}"
BRANCH="${YOUZHAO_BRANCH:-main}"
API_SERVICE="${YOUZHAO_API_SERVICE:-youzhao-api}"
HEALTH_URL="${YOUZHAO_HEALTH_URL:-http://127.0.0.1:4174/api/health}"
SKIP_BACKUP="${YOUZHAO_SKIP_BACKUP:-false}"

log() {
  printf '[youzhao-update] %s\n' "$*"
}

run_sudo() {
  if [[ "${EUID}" -eq 0 ]]; then
    "$@"
  else
    sudo "$@"
  fi
}

if [[ ! -d "$APP_DIR/.git" ]]; then
  log "应用目录不存在或不是 Git 仓库：$APP_DIR"
  exit 1
fi

cd "$APP_DIR"

if [[ -n "$(git status --porcelain)" ]]; then
  log "工作区存在未提交变更，请先提交、暂存或清理后再更新。"
  git status --short
  exit 1
fi

if [[ "$SKIP_BACKUP" != "true" ]]; then
  mkdir -p "$BACKUP_DIR"
  backup_file="$BACKUP_DIR/youzhao-data-$(date +%Y%m%d%H%M%S).tar.gz"
  log "备份数据目录：$backup_file"
  if [[ -d "$DATA_DIR" ]]; then
    tar -czf "$backup_file" -C "$(dirname "$DATA_DIR")" "$(basename "$DATA_DIR")"
  else
    log "数据目录不存在，跳过备份：$DATA_DIR"
  fi
fi

current_commit="$(git rev-parse --short HEAD)"
log "当前版本：$current_commit"

log "拉取最新代码：origin/$BRANCH"
git fetch origin "$BRANCH"
git checkout "$BRANCH"
git pull --ff-only origin "$BRANCH"

new_commit="$(git rev-parse --short HEAD)"
log "目标版本：$new_commit"

log "安装依赖"
npm ci

log "构建前端"
npm run build

log "重启后端服务：$API_SERVICE"
run_sudo systemctl restart "$API_SERVICE"

if command -v nginx >/dev/null 2>&1; then
  log "检查并重载 Nginx"
  run_sudo nginx -t
  run_sudo systemctl reload nginx
else
  log "未检测到 nginx，跳过重载"
fi

log "健康检查：$HEALTH_URL"
for attempt in {1..20}; do
  if curl -fsS "$HEALTH_URL" >/dev/null; then
    log "更新完成：$new_commit"
    exit 0
  fi
  sleep 1
done

log "健康检查失败，请查看服务日志：journalctl -u $API_SERVICE -n 100 --no-pager"
exit 1
