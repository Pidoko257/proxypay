import { executeGracefulShutdown, ShutdownDependencies } from "../../src/index";

describe("Graceful Shutdown Sequence", () => {
  it("executes shutdown steps in bounded, predictable order", async () => {
    const executionOrder: string[] = [];

    const mockDeps: ShutdownDependencies = {
      server: {
        close: (cb) => {
          executionOrder.push("stop_http_listener");
          cb();
        },
      },
      requestTracker: {
        activeCount: 0,
        waitForZero: async () => {
          executionOrder.push("drain_active_requests");
        },
      },
      stopWorkers: async () => {
        executionOrder.push("stop_background_workers");
      },
      shutdownQueue: async () => {
        executionOrder.push("stop_queues");
      },
      stopHeartbeat: () => {
        executionOrder.push("stop_heartbeat");
      },
      wsManager: {
        close: async () => {
          executionOrder.push("close_websocket_manager");
        },
      },
      graphqlCleanup: {
        dispose: async () => {
          executionOrder.push("close_graphql_cleanup");
        },
      },
      disconnectRedis: async () => {
        executionOrder.push("disconnect_redis");
      },
      closeDbPool: async () => {
        executionOrder.push("close_db_pool");
      },
    };

    const result = await executeGracefulShutdown(mockDeps, 1000, 500);

    expect(result.success).toBe(true);
    expect(result.errors).toEqual([]);
    expect(executionOrder).toEqual([
      "stop_http_listener",
      "drain_active_requests",
      "stop_background_workers",
      "stop_queues",
      "stop_heartbeat",
      "close_websocket_manager",
      "close_graphql_cleanup",
      "disconnect_redis",
      "close_db_pool",
    ]);
  });

  it("handles step timeouts or failures gracefully without aborting remaining steps", async () => {
    const executed: string[] = [];

    const mockDeps: ShutdownDependencies = {
      stopWorkers: async () => {
        executed.push("stop_background_workers");
        throw new Error("Worker connection dropped");
      },
      shutdownQueue: async () => {
        executed.push("stop_queues");
      },
      closeDbPool: async () => {
        executed.push("close_db_pool");
      },
    };

    const result = await executeGracefulShutdown(mockDeps, 500, 200);

    expect(result.success).toBe(false);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0].step).toBe("stop_background_workers");
    expect(result.closedSteps).toContain("stop_queues");
    expect(result.closedSteps).toContain("close_db_pool");
  });
});
