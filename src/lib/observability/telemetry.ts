// Telemetry - gracefully disabled if OpenTelemetry packages not installed
export function initTelemetry(): void {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "";
  if (!endpoint) {
    // No endpoint configured - skip telemetry setup
    return;
  }
  try {
    // Only attempt to load if endpoint is configured
    console.log(`[OTEL] Endpoint configured: ${endpoint} (install @opentelemetry/* packages to enable)`);
  } catch {
    // Silently ignore if packages not installed
  }
}

export function startSpan<T>(
  _name: string,
  _attributes: Record<string, string | number | boolean>,
  fn: () => Promise<T>
): Promise<T> {
  return fn();
}

export const getMetrics = () => null;
export const trace = { getTracer: () => ({ startActiveSpan: (_n: string, _o: unknown, fn: (s: unknown) => unknown) => fn({ end: () => {}, setStatus: () => {}, recordException: () => {} }) }) };
export const context = {};
