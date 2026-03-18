// src/services/webhook-retry.service.ts
// Webhook 死信隊列：指數退避重試
import { prisma } from "@/db/client";
import { deliver } from "@/routes/admin/webhooks";
import { DLQStatus } from "@prisma/client";

// 指數退避：1m, 5m, 30m, 2h, 24h
const RETRY_DELAYS_MS = [60_000, 5*60_000, 30*60_000, 2*3600_000, 24*3600_000];

// ── Add to DLQ ────────────────────────────────────────────────
export async function addToDLQ(params: {
  endpointId: string;
  event:      string;
  payload:    object;
  error:      string;
}): Promise<void> {
  const nextRetryAt = new Date(Date.now() + RETRY_DELAYS_MS[0]);
  await prisma.webhookDLQ.create({
    data: {
      endpointId:   params.endpointId,
      event:        params.event,
      payload:      params.payload,
      lastError:    params.error,
      nextRetryAt,
      status:       "PENDING",
    },
  });
}

// ── Process DLQ (called by scheduler every 5 minutes) ────────
export async function processDLQ(): Promise<{ processed: number; resolved: number; dead: number }> {
  const now = new Date();
  let processed = 0, resolved = 0, dead = 0;

  const pending = await prisma.webhookDLQ.findMany({
    where:  { status: { in: ["PENDING","RETRYING"] }, nextRetryAt: { lte: now } },
    take:   50,
    orderBy:{ nextRetryAt: "asc" },
  });

  for (const item of pending) {
    processed++;
    await prisma.webhookDLQ.update({ where: { id: item.id }, data: { status: "RETRYING" } });

    try {
      const endpoint = await prisma.webhookEndpoint.findUnique({ where: { id: item.endpointId } });
      if (!endpoint) {
        await prisma.webhookDLQ.update({ where: { id: item.id }, data: { status: "DEAD" } });
        dead++;
        continue;
      }

      const result = await deliver(endpoint.id, endpoint.url, endpoint.secret, item.event, item.payload as object);

      if (result.ok) {
        await prisma.webhookDLQ.update({
          where: { id: item.id },
          data:  { status: "RESOLVED", resolvedAt: new Date() },
        });
        resolved++;
      } else {
        throw new Error(result.error ?? `HTTP ${result.status}`);
      }

    } catch (err) {
      const attempt = item.attemptCount + 1;
      const isExhausted = attempt >= item.maxAttempts;
      const delay = RETRY_DELAYS_MS[Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1)];

      await prisma.webhookDLQ.update({
        where: { id: item.id },
        data: {
          status:       isExhausted ? "DEAD" : "PENDING",
          lastError:    (err as Error).message,
          attemptCount: attempt,
          nextRetryAt:  isExhausted ? new Date() : new Date(Date.now() + delay),
        },
      });
      if (isExhausted) dead++;
    }
  }

  return { processed, resolved, dead };
}
