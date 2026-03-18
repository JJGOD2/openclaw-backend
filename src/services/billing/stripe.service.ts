// src/services/billing/stripe.service.ts
// Stripe 訂閱計費服務
// 需要安裝：npm install stripe
import { prisma } from "@/db/client";

// ── Stripe Plans 對應表 ───────────────────────────────────────
// 這些 Price ID 需要在 Stripe Dashboard 建立後填入 .env
export const STRIPE_PLANS: Record<string, { priceId: string; name: string; ntd: number }> = {
  STARTER:  {
    priceId: process.env.STRIPE_PRICE_STARTER  ?? "price_starter",
    name:    "Starter",
    ntd:     1490,
  },
  PRO:      {
    priceId: process.env.STRIPE_PRICE_PRO      ?? "price_pro",
    name:    "Pro",
    ntd:     4990,
  },
  BUSINESS: {
    priceId: process.env.STRIPE_PRICE_BUSINESS ?? "price_business",
    name:    "Business",
    ntd:     0,   // 洽談，不走 Stripe
  },
};

// ── Lazy-load Stripe to avoid import errors if key not set ────
function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY not configured");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Stripe = require("stripe");
  return new Stripe(key, { apiVersion: "2024-04-10" });
}

// ─────────────────────────────────────────────────────────────
// 建立 Stripe Customer + BillingCustomer 記錄
// ─────────────────────────────────────────────────────────────
export async function createBillingCustomer(params: {
  workspaceId: string;
  email:       string;
  name?:       string;
}): Promise<string> {
  const stripe = getStripe();

  // Check if already exists
  const existing = await prisma.billingCustomer.findUnique({
    where: { workspaceId: params.workspaceId },
  });
  if (existing) return existing.stripeCustomerId;

  const customer = await stripe.customers.create({
    email:    params.email,
    name:     params.name,
    metadata: { workspaceId: params.workspaceId },
  });

  await prisma.billingCustomer.create({
    data: {
      workspaceId:      params.workspaceId,
      stripeCustomerId: customer.id,
      email:            params.email,
      name:             params.name,
    },
  });

  return customer.id;
}

// ─────────────────────────────────────────────────────────────
// 建立 Checkout Session（跳轉到 Stripe 付款頁）
// ─────────────────────────────────────────────────────────────
export async function createCheckoutSession(params: {
  workspaceId:  string;
  plan:         "STARTER" | "PRO";
  email:        string;
  successUrl:   string;
  cancelUrl:    string;
  trialDays?:   number;
}): Promise<{ url: string; sessionId: string }> {
  const stripe  = getStripe();
  const planDef = STRIPE_PLANS[params.plan];
  if (!planDef.priceId || planDef.priceId.startsWith("price_")) {
    throw new Error(`Stripe Price ID for ${params.plan} not configured`);
  }

  const customerId = await createBillingCustomer({
    workspaceId: params.workspaceId,
    email:       params.email,
  });

  const session = await stripe.checkout.sessions.create({
    customer:             customerId,
    mode:                 "subscription",
    payment_method_types: ["card"],
    line_items: [{
      price:    planDef.priceId,
      quantity: 1,
    }],
    subscription_data: params.trialDays
      ? { trial_period_days: params.trialDays, metadata: { workspaceId: params.workspaceId } }
      : { metadata: { workspaceId: params.workspaceId } },
    success_url: params.successUrl,
    cancel_url:  params.cancelUrl,
    metadata:    { workspaceId: params.workspaceId, plan: params.plan },
  });

  return { url: session.url!, sessionId: session.id };
}

// ─────────────────────────────────────────────────────────────
// 建立 Customer Portal Session（管理訂閱、發票、取消）
// ─────────────────────────────────────────────────────────────
export async function createPortalSession(params: {
  workspaceId: string;
  returnUrl:   string;
}): Promise<string> {
  const stripe  = getStripe();
  const billing = await prisma.billingCustomer.findUnique({
    where: { workspaceId: params.workspaceId },
  });
  if (!billing) throw new Error("No billing customer found — please subscribe first");

  const session = await stripe.billingPortal.sessions.create({
    customer:   billing.stripeCustomerId,
    return_url: params.returnUrl,
  });
  return session.url;
}

// ─────────────────────────────────────────────────────────────
// 取得訂閱狀態
// ─────────────────────────────────────────────────────────────
export async function getSubscriptionStatus(workspaceId: string) {
  const billing = await prisma.billingCustomer.findUnique({
    where:   { workspaceId },
    include: {
      subscriptions: { orderBy: { createdAt: "desc" }, take: 1 },
      invoices:      { orderBy: { createdAt: "desc" }, take: 5 },
    },
  });

  if (!billing) return { hasBilling: false, status: null, plan: null };

  const sub = billing.subscriptions[0];
  return {
    hasBilling:  true,
    customerId:  billing.stripeCustomerId,
    email:       billing.email,
    status:      sub?.status ?? null,
    plan:        sub?.plan   ?? null,
    periodEnd:   sub?.currentPeriodEnd ?? null,
    cancelAtEnd: sub?.cancelAtPeriodEnd ?? false,
    trialEnd:    sub?.trialEnd ?? null,
    invoices:    billing.invoices.map(inv => ({
      id:     inv.id,
      amount: inv.amount / 100,                // convert cents to dollars
      status: inv.status,
      paidAt: inv.paidAt,
      url:    inv.invoiceUrl,
    })),
  };
}

// ─────────────────────────────────────────────────────────────
// Stripe Webhook 事件處理器
// ─────────────────────────────────────────────────────────────
export async function handleStripeWebhook(
  rawBody:   string,
  signature: string
): Promise<void> {
  const stripe         = getStripe();
  const webhookSecret  = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) throw new Error("STRIPE_WEBHOOK_SECRET not configured");

  let event: {
    type: string;
    data: { object: Record<string, unknown> };
  };

  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch (err) {
    throw new Error(`Stripe webhook signature failed: ${(err as Error).message}`);
  }

  const obj = event.data.object;

  switch (event.type) {
    case "checkout.session.completed": {
      await handleCheckoutCompleted(obj);
      break;
    }
    case "customer.subscription.updated":
    case "customer.subscription.created": {
      await handleSubscriptionUpdated(obj);
      break;
    }
    case "customer.subscription.deleted": {
      await handleSubscriptionDeleted(obj);
      break;
    }
    case "invoice.paid": {
      await handleInvoicePaid(obj);
      break;
    }
    case "invoice.payment_failed": {
      await handleInvoicePaymentFailed(obj);
      break;
    }
  }
}

// ── Event Handlers ────────────────────────────────────────────

async function handleCheckoutCompleted(session: Record<string, unknown>) {
  const workspaceId = (session.metadata as Record<string, string>)?.workspaceId;
  const plan        = (session.metadata as Record<string, string>)?.plan as "STARTER" | "PRO";
  if (!workspaceId || !plan) return;

  // Update workspace plan
  await prisma.workspace.update({
    where: { id: workspaceId },
    data:  { plan: plan as never },
  });

  await prisma.logEntry.create({
    data: {
      workspaceId,
      type:    "SYSTEM",
      message: `[Billing] Checkout 完成，方案已升級至 ${plan}`,
    },
  });
}

async function handleSubscriptionUpdated(sub: Record<string, unknown>) {
  const customerId = sub.customer as string;
  const billing    = await prisma.billingCustomer.findUnique({
    where: { stripeCustomerId: customerId },
  });
  if (!billing) return;

  const planEntry = Object.entries(STRIPE_PLANS).find(
    ([, v]) => v.priceId === (sub.items as { data: { price: { id: string } }[] })?.data?.[0]?.price?.id
  );
  const plan = planEntry?.[0] as "STARTER" | "PRO" | "BUSINESS" | undefined;

  await prisma.subscription.upsert({
    where:  { stripeSubscriptionId: sub.id as string },
    update: {
      status:              sub.status as never,
      currentPeriodStart:  new Date((sub.current_period_start as number) * 1000),
      currentPeriodEnd:    new Date((sub.current_period_end   as number) * 1000),
      cancelAtPeriodEnd:   sub.cancel_at_period_end as boolean,
      trialEnd:            sub.trial_end ? new Date((sub.trial_end as number) * 1000) : null,
    },
    create: {
      customerId:          billing.id,
      stripeSubscriptionId:sub.id as string,
      stripePriceId:       (sub.items as { data: { price: { id: string } }[] })?.data?.[0]?.price?.id ?? "",
      plan:                (plan ?? "STARTER") as never,
      status:              sub.status as never,
      currentPeriodStart:  new Date((sub.current_period_start as number) * 1000),
      currentPeriodEnd:    new Date((sub.current_period_end   as number) * 1000),
      cancelAtPeriodEnd:   sub.cancel_at_period_end as boolean,
      trialEnd:            sub.trial_end ? new Date((sub.trial_end as number) * 1000) : null,
    },
  });
}

async function handleSubscriptionDeleted(sub: Record<string, unknown>) {
  await prisma.subscription.updateMany({
    where: { stripeSubscriptionId: sub.id as string },
    data:  { status: "CANCELED", canceledAt: new Date() },
  });

  // Downgrade workspace to STARTER
  const customerId = sub.customer as string;
  const billing    = await prisma.billingCustomer.findUnique({
    where: { stripeCustomerId: customerId },
  });
  if (billing) {
    await prisma.workspace.update({
      where: { id: billing.workspaceId },
      data:  { plan: "STARTER" },
    });
  }
}

async function handleInvoicePaid(inv: Record<string, unknown>) {
  const customerId = inv.customer as string;
  const billing    = await prisma.billingCustomer.findUnique({
    where: { stripeCustomerId: customerId },
  });
  if (!billing) return;

  await prisma.invoice.upsert({
    where:  { stripeInvoiceId: inv.id as string },
    update: { status: "PAID", paidAt: new Date() },
    create: {
      customerId:     billing.id,
      stripeInvoiceId:inv.id as string,
      amount:         (inv.amount_paid as number) ?? 0,
      currency:       (inv.currency   as string) ?? "twd",
      status:         "PAID",
      paidAt:         new Date(),
      periodStart:    inv.period_start ? new Date((inv.period_start as number) * 1000) : null,
      periodEnd:      inv.period_end   ? new Date((inv.period_end   as number) * 1000) : null,
      invoiceUrl:     inv.hosted_invoice_url as string | null,
      invoicePdf:     inv.invoice_pdf        as string | null,
    },
  });
}

async function handleInvoicePaymentFailed(inv: Record<string, unknown>) {
  const customerId = inv.customer as string;
  const billing    = await prisma.billingCustomer.findUnique({
    where: { stripeCustomerId: customerId },
  });
  if (!billing) return;

  await prisma.logEntry.create({
    data: {
      workspaceId: billing.workspaceId,
      type:        "ERROR",
      message:     `[Billing] 付款失敗，發票金額 NT$${((inv.amount_due as number) ?? 0) / 100}，請更新付款方式`,
    },
  });

  // Fire payment_failed alert rules
  const rules = await prisma.alertRule.findMany({
    where: { workspaceId: billing.workspaceId, trigger: "BUDGET_THRESHOLD", enabled: true },
  });
  for (const rule of rules) {
    const { dispatch } = await import("@/routes/alerts");
    await dispatch(rule.channel as never, rule.destination, {
      title:   "⚠ 付款失敗",
      message: `MyWrapper Technologies 訂閱付款失敗，請前往後台更新付款方式以避免服務中斷。`,
    });
  }
}
