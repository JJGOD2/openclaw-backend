// src/lib/observability/telemetry.ts
// OpenTelemetry：traces + metrics
// 相容 Grafana Cloud、Jaeger、Honeycomb、Datadog 任何 OTLP 後端
//
// 無 OTEL_EXPORTER_OTLP_ENDPOINT → 只 log 到 console（開發模式）
// 有 endpoint → 推送到 OTLP 後端

import { NodeSDK }      from "@opentelemetry/sdk-node";
import { Resource }     from "@opentelemetry/resources";
import { SEMRESATTRS_SERVICE_NAME, SEMRESATTRS_SERVICE_VERSION }
  from "@opentelemetry/semantic-conventions";
import { OTLPTraceExporter }  from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { SimpleSpanProcessor, ConsoleSpanExporter, BatchSpanProcessor }
  from "@opentelemetry/sdk-trace-base";
import { PrismaInstrumentation }     from "@prisma/instrumentation";
import { HttpInstrumentation }        from "@opentelemetry/instrumentation-http";
import { ExpressInstrumentation }     from "@opentelemetry/instrumentation-express";
import {
  trace, metrics, context, SpanStatusCode, SpanKind,
} from "@opentelemetry/api";

// ── Globals ───────────────────────────────────────────────────
let sdk: NodeSDK | null = null;
const SERVICE_NAME    = process.env.OTEL_SERVICE_NAME    ?? "openclaw-backend";
const SERVICE_VERSION = process.env.npm_package_version  ?? "2.0.0";

// ── Initialise ────────────────────────────────────────────────
export function initTelemetry(): void {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "";

  const resource = new Resource({
    [SEMRESATTRS_SERVICE_NAME]:    SERVICE_NAME,
    [SEMRESATTRS_SERVICE_VERSION]: SERVICE_VERSION,
    "deployment.environment":      process.env.NODE_ENV ?? "development",
  });

  const spanProcessor = endpoint
    ? new BatchSpanProcessor(new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }))
    : new SimpleSpanProcessor(new ConsoleSpanExporter());

  const metricReader = new PeriodicExportingMetricReader({
    exporter:       endpoint
      ? new OTLPMetricExporter({ url: `${endpoint}/v1/metrics` })
      : { export: () => {}, forceFlush: async () => {}, shutdown: async () => {} } as never,
    exportIntervalMillis: 60_000,
  });

  sdk = new NodeSDK({
    resource,
    spanProcessor,
    metricReader,
    instrumentations: [
      new HttpInstrumentation({
        ignoreIncomingRequestHook: (req) => {
          const url = req.url ?? "";
          return url === "/health" || url.startsWith("/_next");
        },
      }),
      new ExpressInstrumentation(),
      new PrismaInstrumentation(),
    ],
  });

  sdk.start();

  // ── Custom metrics ─────────────────────────────────────────
  const meter = metrics.getMeter(SERVICE_NAME);

  // Pre-create counters (exported to module scope for reuse)
  globalThis.__otelMetrics = {
    messageCounter: meter.createCounter("openclaw.messages.total", {
      description: "Total messages processed",
    }),
    errorCounter:   meter.createCounter("openclaw.errors.total", {
      description: "Total errors",
    }),
    agentLatency:   meter.createHistogram("openclaw.agent.latency_ms", {
      description: "Agent response latency",
      unit:        "ms",
      advice:      { explicitBucketBoundaries: [50,100,200,500,1000,2000,5000] },
    }),
    activeHandoffs: meter.createUpDownCounter("openclaw.handoffs.active", {
      description: "Currently open handoffs",
    }),
    cacheHits:      meter.createCounter("openclaw.cache.hits"),
    cacheMisses:    meter.createCounter("openclaw.cache.misses"),
  };

  process.on("beforeExit", () => sdk?.shutdown());
  console.log(`[OTEL] Telemetry started (${endpoint ? `OTLP → ${endpoint}` : "console mode"})`);
}

// ── Typed access to pre-created metrics ───────────────────────
interface OtelMetrics {
  messageCounter: ReturnType<ReturnType<typeof metrics.getMeter>["createCounter"]>;
  errorCounter:   ReturnType<ReturnType<typeof metrics.getMeter>["createCounter"]>;
  agentLatency:   ReturnType<ReturnType<typeof metrics.getMeter>["createHistogram"]>;
  activeHandoffs: ReturnType<ReturnType<typeof metrics.getMeter>["createUpDownCounter"]>;
  cacheHits:      ReturnType<ReturnType<typeof metrics.getMeter>["createCounter"]>;
  cacheMisses:    ReturnType<ReturnType<typeof metrics.getMeter>["createCounter"]>;
}

declare global {
  // eslint-disable-next-line no-var
  var __otelMetrics: OtelMetrics | undefined;
}

export function getMetrics(): OtelMetrics | null {
  return globalThis.__otelMetrics ?? null;
}

// ── Span helpers ──────────────────────────────────────────────
export function startSpan<T>(
  name:       string,
  attributes: Record<string, string | number | boolean>,
  fn:         () => Promise<T>
): Promise<T> {
  const tracer = trace.getTracer(SERVICE_NAME);
  return tracer.startActiveSpan(name, { kind: SpanKind.INTERNAL, attributes }, async (span) => {
    try {
      const result = await fn();
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
      span.recordException(err as Error);
      throw err;
    } finally {
      span.end();
    }
  });
}

export { trace, context };
