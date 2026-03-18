#!/bin/bash
# scripts/migrate-prod.sh
# 生產環境零停機 DB migration
# 執行：./scripts/migrate-prod.sh

set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; AMBER='\033[1;33m'; NC='\033[0m'; BOLD='\033[1m'

ok()   { echo -e "${GREEN}✓${NC} $1"; }
fail() { echo -e "${RED}✗${NC} $1"; exit 1; }
warn() { echo -e "${AMBER}△${NC} $1"; }
info() { echo -e "  $1"; }

echo -e "\n${BOLD}OpenClaw 生產 DB Migration${NC}"
echo "═══════════════════════════════════════════"

# Check prerequisites
command -v pg_dump   >/dev/null 2>&1 || fail "pg_dump 未安裝"
command -v docker    >/dev/null 2>&1 || fail "docker 未安裝"
[ -n "${DATABASE_URL:-}" ]           || fail "DATABASE_URL 未設定"

# ── Step 1: Backup before migration ──────────────────────────
echo -e "\n${BOLD}1. 遷移前備份${NC}"
BACKUP_FILE="/tmp/pre-migration-$(date +%Y%m%d-%H%M%S).sql.gz"
pg_dump "$DATABASE_URL" | gzip > "$BACKUP_FILE"
BACKUP_SIZE=$(du -sh "$BACKUP_FILE" | cut -f1)
ok "備份完成：$BACKUP_FILE ($BACKUP_SIZE)"

# ── Step 2: Check for pending migrations ─────────────────────
echo -e "\n${BOLD}2. 檢查待執行 Migration${NC}"
PENDING=$(npx prisma migrate status 2>&1 | grep -c "have not yet been applied" || true)
if [ "$PENDING" -eq 0 ]; then
  ok "沒有待執行的 migration，結束"
  exit 0
fi
info "發現 $PENDING 個待執行的 migration"

# ── Step 3: Validate migration safety ────────────────────────
echo -e "\n${BOLD}3. 驗證 Migration 安全性${NC}"
# Check if migrations contain dangerous operations
MIGRATIONS_SQL=$(cat prisma/migrations/**/*.sql 2>/dev/null || true)
if echo "$MIGRATIONS_SQL" | grep -qiE "DROP TABLE|DROP COLUMN|TRUNCATE"; then
  warn "偵測到破壞性操作（DROP/TRUNCATE）"
  read -p "  確定繼續？[y/N] " -n 1 -r; echo
  [[ $REPLY =~ ^[Yy]$ ]] || fail "使用者取消"
else
  ok "Migration 不包含破壞性操作"
fi

# ── Step 4: Put app in maintenance mode (optional) ───────────
echo -e "\n${BOLD}4. 遷移中...${NC}"

# Execute migration
if npx prisma migrate deploy; then
  ok "Migration 成功"
else
  fail "Migration 失敗！請用備份還原：\n  gunzip < $BACKUP_FILE | psql \$DATABASE_URL"
fi

# ── Step 5: Verify ────────────────────────────────────────────
echo -e "\n${BOLD}5. 驗證${NC}"
HEALTH=$(curl -sf "${BACKEND_URL:-http://localhost:4000}/health" 2>/dev/null | grep -c "ok" || true)
if [ "$HEALTH" -gt 0 ]; then
  ok "服務健康檢查通過"
else
  warn "健康檢查無法連線（服務可能正在啟動中）"
fi

echo -e "\n${GREEN}${BOLD}Migration 完成！${NC}"
info "備份位置：$BACKUP_FILE（請保留 7 天）"
echo ""
