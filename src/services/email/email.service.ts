// src/services/email/email.service.ts
// 交易型 Email 發送服務（使用 Resend API）
// 無需安裝額外套件，使用原生 fetch

const RESEND_API_KEY = process.env.RESEND_API_KEY ?? "";
const FROM_EMAIL     = process.env.EMAIL_FROM     ?? "noreply@openclaw.example.com";
const FROM_NAME      = process.env.EMAIL_FROM_NAME ?? "MyWrapper Technologies";

async function sendEmail(opts: {
  to:      string | string[];
  subject: string;
  html:    string;
  text?:   string;
}): Promise<{ id: string }> {
  if (!RESEND_API_KEY || RESEND_API_KEY === "") {
    console.log(`[Email DEV] To: ${opts.to}\nSubject: ${opts.subject}`);
    return { id: "dev-mock-id" };
  }

  const res = await fetch("https://api.resend.com/emails", {
    method:  "POST",
    headers: {
      "Authorization": `Bearer ${RESEND_API_KEY}`,
      "Content-Type":  "application/json",
    },
    body: JSON.stringify({
      from:    `${FROM_NAME} <${FROM_EMAIL}>`,
      to:      Array.isArray(opts.to) ? opts.to : [opts.to],
      subject: opts.subject,
      html:    opts.html,
      text:    opts.text,
    }),
  });

  if (!res.ok) {
    const err = await res.json();
    throw new Error(`Resend API error: ${JSON.stringify(err)}`);
  }
  return res.json();
}

// ── Email Templates ───────────────────────────────────────────

function baseTemplate(content: string, title: string): string {
  return `<!DOCTYPE html>
<html lang="zh-TW">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title>
<style>
  body { font-family: -apple-system, sans-serif; background: #f9f9f9; margin: 0; padding: 20px; color: #1a1a1a; }
  .container { max-width: 560px; margin: 0 auto; background: white; border-radius: 12px; border: 1px solid #e5e7eb; overflow: hidden; }
  .header { background: #1a56db; padding: 24px 32px; }
  .header h1 { color: white; margin: 0; font-size: 18px; font-weight: 600; }
  .header p  { color: rgba(255,255,255,0.8); margin: 4px 0 0; font-size: 13px; }
  .body   { padding: 28px 32px; }
  .footer { padding: 16px 32px; border-top: 1px solid #f3f4f6; text-align: center; }
  .footer p { color: #9ca3af; font-size: 12px; margin: 0; }
  .btn    { display: inline-block; background: #1a56db; color: white; padding: 10px 24px; border-radius: 8px; text-decoration: none; font-size: 14px; font-weight: 500; margin: 16px 0; }
  .alert  { background: #fef3c7; border: 1px solid #fde68a; border-radius: 8px; padding: 12px 16px; margin: 12px 0; }
  .error  { background: #fef2f2; border-color: #fecaca; }
  .success{ background: #f0fdf4; border-color: #bbf7d0; }
  .info   { background: #eff6ff; border-color: #bfdbfe; }
  p  { line-height: 1.7; color: #374151; margin: 0 0 12px; font-size: 14px; }
  ul { padding-left: 20px; }
  li { line-height: 1.8; font-size: 14px; color: #374151; }
  .stat { display: inline-block; background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 10px 16px; margin: 4px; min-width: 100px; text-align: center; }
  .stat-val { font-size: 22px; font-weight: 600; color: #111827; }
  .stat-lbl { font-size: 11px; color: #9ca3af; margin-top: 2px; }
</style>
</head>
<body>
<div class="container">
  <div class="header">
    <h1>MyWrapper Technologies</h1>
    <p>${title}</p>
  </div>
  <div class="body">${content}</div>
  <div class="footer"><p>© 2026 MyWrapper Technologies · <a href="#" style="color:#9ca3af">取消訂閱</a></p></div>
</div>
</body></html>`;
}

// ── 每日用量報告 ──────────────────────────────────────────────
export async function sendDailyReport(opts: {
  to:           string;
  date:         string;
  messages:     number;
  tokens:       number;
  costNTD:      number;
  workspaceName:string;
  dashboardUrl: string;
}): Promise<void> {
  const html = baseTemplate(`
<p>您好，以下是 <strong>${opts.workspaceName}</strong> 的每日用量報告：</p>
<div style="text-align:center;margin:20px 0">
  <div class="stat"><div class="stat-val">${opts.messages.toLocaleString()}</div><div class="stat-lbl">訊息量</div></div>
  <div class="stat"><div class="stat-val">${(opts.tokens / 1000).toFixed(1)}k</div><div class="stat-lbl">Token</div></div>
  <div class="stat"><div class="stat-val">NT$${opts.costNTD.toFixed(0)}</div><div class="stat-lbl">費用</div></div>
</div>
<div style="text-align:center">
  <a class="btn" href="${opts.dashboardUrl}">查看完整報表 →</a>
</div>
  `, `每日用量報告 — ${opts.date}`);

  await sendEmail({ to: opts.to, subject: `[MyWrapper] ${opts.workspaceName} 每日報告 ${opts.date}`, html });
}

// ── 告警通知 ──────────────────────────────────────────────────
export async function sendAlertEmail(opts: {
  to:      string;
  title:   string;
  message: string;
  level:   "error" | "warning" | "info";
  url?:    string;
}): Promise<void> {
  const levelClass = opts.level === "error" ? "error" : opts.level === "warning" ? "alert" : "info";
  const levelEmoji = opts.level === "error" ? "🚨" : opts.level === "warning" ? "⚠️" : "ℹ️";

  const html = baseTemplate(`
<div class="alert ${levelClass}">
  <strong>${levelEmoji} ${opts.title}</strong>
  <p style="margin:6px 0 0">${opts.message}</p>
</div>
${opts.url ? `<div style="text-align:center"><a class="btn" href="${opts.url}">查看詳情 →</a></div>` : ""}
  `, opts.title);

  await sendEmail({
    to:      opts.to,
    subject: `[MyWrapper] ${levelEmoji} ${opts.title}`,
    html,
    text:    `${opts.title}\n\n${opts.message}`,
  });
}

// ── 帳單確認 ──────────────────────────────────────────────────
export async function sendInvoiceEmail(opts: {
  to:          string;
  plan:        string;
  amount:      number;
  period:      string;
  invoiceUrl?: string;
}): Promise<void> {
  const html = baseTemplate(`
<div class="alert success">
  <strong>✓ 付款成功</strong>
  <p style="margin:6px 0 0">感謝您的付款，以下是本期帳單摘要：</p>
</div>
<ul>
  <li>訂閱方案：<strong>${opts.plan}</strong></li>
  <li>帳單金額：<strong>NT$${opts.amount.toLocaleString()}</strong></li>
  <li>計費期間：${opts.period}</li>
</ul>
${opts.invoiceUrl ? `<p><a href="${opts.invoiceUrl}" style="color:#BA7517">下載發票 PDF →</a></p>` : ""}
  `, "付款確認");

  await sendEmail({
    to:      opts.to,
    subject: `[MyWrapper] 付款確認 — NT$${opts.amount.toLocaleString()}`,
    html,
  });
}

// ── 邀請成員 ──────────────────────────────────────────────────
export async function sendInviteEmail(opts: {
  to:            string;
  inviterName:   string;
  workspaceName: string;
  role:          string;
  acceptUrl:     string;
}): Promise<void> {
  const roleLabel: Record<string,string> = { ADMIN:"管理員", OPERATOR:"操作員", VIEWER:"檢視者" };
  const html = baseTemplate(`
<p>${opts.inviterName} 邀請您加入 <strong>${opts.workspaceName}</strong> 的 MyWrapper 控制台，擔任 <strong>${roleLabel[opts.role] ?? opts.role}</strong> 角色。</p>
<div style="text-align:center">
  <a class="btn" href="${opts.acceptUrl}">接受邀請 →</a>
</div>
<p style="font-size:12px;color:#9ca3af">此連結有效期 7 天，若您不認識發送人請忽略此信。</p>
  `, "您有一封邀請");

  await sendEmail({
    to:      opts.to,
    subject: `[MyWrapper] ${opts.inviterName} 邀請您加入 ${opts.workspaceName}`,
    html,
  });
}

// ── Token 過期警告 ────────────────────────────────────────────
export async function sendSecretExpiryEmail(opts: {
  to:           string;
  secretName:   string;
  workspaceName:string;
  expiresAt:    string;
  dashboardUrl: string;
}): Promise<void> {
  const html = baseTemplate(`
<div class="alert">
  <strong>⚠ Secret 即將到期</strong>
  <p style="margin:6px 0 0">Workspace <strong>${opts.workspaceName}</strong> 的 <code>${opts.secretName}</code> 將於 <strong>${opts.expiresAt}</strong> 到期。</p>
</div>
<p>請儘快更新此 Secret，以避免 Agent 服務中斷。</p>
<div style="text-align:center">
  <a class="btn" href="${opts.dashboardUrl}">前往更新 →</a>
</div>
  `, "Secret 即將到期");

  await sendEmail({
    to:      opts.to,
    subject: `[MyWrapper] ⚠ ${opts.secretName} 將於 ${opts.expiresAt} 到期`,
    html,
  });
}

export { sendEmail };
