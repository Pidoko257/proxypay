import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { JaegerExporter } from "@opentelemetry/exporter-jaeger";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { Resource } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME, SEMRESATTRS_DEPLOYMENT_ENVIRONMENT } from "@opentelemetry/semantic-conventions";
import { BatchSpanProcessor, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { diag, DiagConsoleLogger, DiagLogLevel } from "@opentelemetry/api";

if (process.env.OTEL_LOG_LEVEL === "debug") {
  diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.DEBUG);
}

const resource = Resource.default().merge(
  new Resource({
    [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME ?? "proxypay",
    [SEMRESATTRS_DEPLOYMENT_ENVIRONMENT]: process.env.NODE_ENV ?? "development",
  }),
);

function buildExporter() {
  if (process.env.OTEL_EXPORTER === "jaeger") {
    return new JaegerExporter({
      endpoint: process.env.JAEGER_ENDPOINT ?? "http://localhost:14268/api/traces",
    });
  }
  // Default: OTLP HTTP
  return new OTLPTraceExporter({
    url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://localhost:4318/v1/traces",
    headers: process.env.OTEL_EXPORTER_OTLP_HEADERS
      ? Object.fromEntries(
          process.env.OTEL_EXPORTER_OTLP_HEADERS.split(",").map((h) => h.split("=") as [string, string]),
        )
      : {},
  });
}

const exporter = buildExporter();
const processor =
  process.env.NODE_ENV === "production"
    ? new BatchSpanProcessor(exporter)
    : new SimpleSpanProcessor(exporter);

const sdk = new NodeSDK({
  resource,
  spanProcessors: [processor],
  instrumentations: [
    getNodeAutoInstrumentations({
      // Instrument HTTP (Express), pg, ioredis automatically
      "@opentelemetry/instrumentation-http": { enabled: true },
      "@opentelemetry/instrumentation-express": { enabled: true },
      "@opentelemetry/instrumentation-pg": { enabled: true },
      "@opentelemetry/instrumentation-ioredis": { enabled: true },
      // Disable noisy instrumentations
      "@opentelemetry/instrumentation-fs": { enabled: false },
      "@opentelemetry/instrumentation-dns": { enabled: false },
    }),
  ],
});

sdk.start();

process.once("SIGTERM", () => sdk.shutdown());
process.once("SIGINT", () => sdk.shutdown());

export { sdk };
