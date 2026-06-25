describe("OpenTelemetry tracer initialisation", () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...ORIGINAL_ENV };
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it("starts the NodeSDK with the configured service name", () => {
    process.env.NODE_ENV = "production";
    process.env.OTEL_SERVICE_NAME = "proxypay";

    const startMock = jest.fn();
    jest.doMock("@opentelemetry/sdk-node", () => ({
      NodeSDK: jest.fn().mockImplementation(() => ({ start: startMock, shutdown: jest.fn() })),
    }));
    jest.doMock("@opentelemetry/auto-instrumentations-node", () => ({
      getNodeAutoInstrumentations: jest.fn().mockReturnValue([]),
    }));
    jest.doMock("@opentelemetry/exporter-trace-otlp-http", () => ({
      OTLPTraceExporter: jest.fn().mockImplementation(() => ({})),
    }));
    jest.doMock("@opentelemetry/exporter-jaeger", () => ({
      JaegerExporter: jest.fn().mockImplementation(() => ({})),
    }));

    require("../src/tracer");

    expect(startMock).toHaveBeenCalledTimes(1);
  });

  it("selects the Jaeger exporter when OTEL_EXPORTER=jaeger", () => {
    process.env.OTEL_EXPORTER = "jaeger";

    const JaegerExporterMock = jest.fn().mockImplementation(() => ({}));
    const OTLPExporterMock = jest.fn().mockImplementation(() => ({}));

    jest.doMock("@opentelemetry/sdk-node", () => ({
      NodeSDK: jest.fn().mockImplementation(() => ({ start: jest.fn(), shutdown: jest.fn() })),
    }));
    jest.doMock("@opentelemetry/auto-instrumentations-node", () => ({
      getNodeAutoInstrumentations: jest.fn().mockReturnValue([]),
    }));
    jest.doMock("@opentelemetry/exporter-trace-otlp-http", () => ({
      OTLPTraceExporter: OTLPExporterMock,
    }));
    jest.doMock("@opentelemetry/exporter-jaeger", () => ({
      JaegerExporter: JaegerExporterMock,
    }));

    require("../src/tracer");

    expect(JaegerExporterMock).toHaveBeenCalledTimes(1);
    expect(OTLPExporterMock).not.toHaveBeenCalled();
  });
});
