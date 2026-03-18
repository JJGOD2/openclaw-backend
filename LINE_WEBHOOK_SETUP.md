# LINE Webhook 設定指南

## 概覽

OpenClaw Console 的 LINE Webhook 接收器負責：
1. 接收 LINE 平台推送的訊息事件
2. 驗證 LINE 簽名（防偽造）
3. 檢查 Sender Allowlist
4. 呼叫對應 Agent（Claude API）
5. 自動回覆 or 送入人工審核佇列

## Webhook URL 格式

```
POST https://your-backend.com/webhook/line/{workspaceId}/{channelBindingId}
```

## 設定步驟

### Step 1｜取得 Channel 資訊

1. 登入 [LINE Developers Console](https://developers.line.biz/)
2. 選擇你的 Messaging API Channel
3. 複製以下資訊：
   - **Channel Secret** → 存入 Secrets 管理：`LINE_CHANNEL_SECRET`
   - **Channel Access Token** → 存入：`LINE_CHANNEL_ACCESS_TOKEN`

### Step 2｜在 OpenClaw Console 建立 Channel

1. 前往 **Channels** → 新增通道
2. 選擇 **LINE Official Account**
3. 填入 handle（你的 @LINE_ID）
4. 綁定預設 Agent

取得 `channelBindingId`（建立後在 Channels 頁面可複製）

### Step 3｜設定 LINE Webhook URL

回到 LINE Developers Console：

```
Webhook URL: https://your-backend.com/webhook/line/{workspaceId}/{channelBindingId}
```

- 開啟 **Use webhook**
- 點擊 **Verify** 確認連線

### Step 4｜設定 Secrets

在 OpenClaw Console → Security → Secrets 管理，新增：

| Key 名稱 | 值 |
|----------|----|
| `LINE_CHANNEL_SECRET` | 從 LINE Developers 複製 |
| `LINE_CHANNEL_ACCESS_TOKEN` | 從 LINE Developers 複製（長效 token） |
| `ANTHROPIC_API_KEY` | 你的 Anthropic API Key |

### Step 5｜測試

在 LINE Developers Console 點擊 **Verify**，或直接用 LINE App 傳訊給你的 Official Account。

---

## 安全設定建議

### Sender Allowlist（建議啟用）

在 Channel Policy 開啟 **Allowlist Mode**：
- 只有白名單內的 userId 才能觸發 Agent
- 其他來源會被記錄至 Logs 並忽略

### DM Scope

LINE 私訊視為不可信輸入：
- 設定為 `restricted` 模式
- 配合 allowlist 使用效果最佳

### 人工審核觸發條件

以下情況會自動送入審核佇列：
- 訊息包含「退款、取消、刪除、退貨」等關鍵字
- 涉及高風險 tool（`requireApproval: true`）

---

## 常見問題

**Q: LINE 顯示 Webhook 驗證失敗**
- 確認後端已啟動且可外部訪問
- 確認 URL 格式正確（含 workspaceId 和 channelBindingId）
- 確認 LINE_CHANNEL_SECRET 已正確設定

**Q: 訊息沒有回覆**
- 確認 ANTHROPIC_API_KEY 已設定
- 確認 Channel Binding 已綁定 defaultAgent
- 查看 Logs 頁面確認是否有錯誤記錄

**Q: replyToken 過期**
- LINE replyToken 只有 30 秒有效期
- 若使用人工審核，系統會改用 Push API 發送
- 確認 LINE_CHANNEL_ACCESS_TOKEN 已設定（Push API 需要）

---

## 流量架構

```
使用者 LINE App
    ↓  訊息
LINE Platform
    ↓  POST (HMAC-SHA256 簽名)
OpenClaw Backend /webhook/line/{wsId}/{bindingId}
    ↓  200 OK (立即回應)
    ↓  驗證簽名
    ↓  檢查 Allowlist
    ↓  invokeAgent()
         ↓  Claude API
         ↓  產生回覆
    ↓  needsReview?
    ├── No  → lineReply() 直接回覆
    └── Yes → ReviewQueue → 人工審核 → linePush()
```
