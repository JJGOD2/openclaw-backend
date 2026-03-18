# MyWrapper Technologies — Backend

AI 客服 Agent 管理平台後端 v2.0

## 本地開發

```bash
cp .env.example .env
# 填入 .env 的值（至少要有 DATABASE_URL、JWT_SECRET、ENCRYPTION_KEY）

npm install
npx prisma db push
npx prisma db seed
npm run dev
```

服務啟動於 `http://localhost:4000`

預設帳號：`admin@example.com` / `admin1234`（**上線後立即更改**）

## Zeabur 部署

1. 連接此 GitHub repo 到 Zeabur
2. 設定環境變數（參考 `.env.example`）
3. 在 Zeabur Terminal 執行：
   ```bash
   npx prisma db push
   npx prisma db seed
   ```

## 上線前檢查

```bash
node scripts/pre-launch-check.mjs
```
