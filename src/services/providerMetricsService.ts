import {
  providerSuccessRateGauge,
  providerRequestsTotal,
  providerDegradationAlertTotal,
  providerResponseTimeSeconds,
} from "../utils/metrics";
import { MonitoringService } from "./monitoringService";

export type MobileMoneyProviderName = "MTN" | "Airtel" | "Orange" | string;

interface ProviderWindowStats {
  total: number;
  successes: number;
  failures: number;
  lastUpdated: number;
}

class ProviderMetricsService {
  // Sliding window statistics per provider + operation
  private windowStats: Map<string, ProviderWindowStats> = new Map();
  private readonly windowMs = 5 * 60 * 1000; // 5-minute sliding window
  private readonly degradationThresholdPercent = 85.0; // Alert if success rate drops below 85%

  private getKey(provider: MobileMoneyProviderName, operation: string): string {
    return `${provider.toUpperCase()}:${operation}`;
  }

  /**
   * Records a provider request outcome (success or failure) and updates success rate gauge and metrics.
   */
  public recordProviderCall(
    provider: MobileMoneyProviderName,
    operation: string,
    durationMs: number,
    success: boolean,
    errorType?: string,
  ): void {
    const normProvider = provider.toUpperCase();
    const statusLabel = success ? "success" : "failure";

    // 1. Prometheus counter & latency histogram
    providerRequestsTotal.inc({ provider: normProvider, operation, status: statusLabel });
    providerResponseTimeSeconds.observe(
      { provider: normProvider, operation, status: statusLabel },
      durationMs / 1000,
    );

    // 2. Update sliding window stats for success rate calculation
    const key = this.getKey(normProvider, operation);
    const now = Date.now();
    let stats = this.windowStats.get(key);

    if (!stats || now - stats.lastUpdated > this.windowMs) {
      stats = { total: 0, successes: 0, failures: 0, lastUpdated: now };
    }

    stats.total += 1;
    if (success) {
      stats.successes += 1;
    } else {
      stats.failures += 1;
    }
    stats.lastUpdated = now;
    this.windowStats.set(key, stats);

    // 3. Compute current success rate percentage
    const successRate = (stats.successes / stats.total) * 100;
    providerSuccessRateGauge.set({ provider: normProvider, operation }, parseFloat(successRate.toFixed(2)));

    // 4. Check for provider degradation
    if (stats.total >= 5 && successRate < this.degradationThresholdPercent) {
      const reason = `Success rate dropped to ${successRate.toFixed(1)}% (below ${this.degradationThresholdPercent}% threshold)`;
      providerDegradationAlertTotal.inc({ provider: normProvider, reason });

      console.warn(
        `[ProviderMetrics] DEGRADATION DETECTED for provider ${normProvider} (${operation}): ${reason}`,
      );

      MonitoringService.reportAlert(
        `Provider Degradation Alert: ${normProvider} (${operation}) success rate is ${successRate.toFixed(1)}% over the last ${stats.total} requests.`,
      ).catch((err) => {
        console.error(`[ProviderMetrics] Failed to send degradation alert:`, err);
      });
    }
  }

  /**
   * Helper to fetch current success rate for comparison.
   */
  public getProviderSuccessRate(provider: MobileMoneyProviderName, operation: string): number {
    const key = this.getKey(provider, operation);
    const stats = this.windowStats.get(key);
    if (!stats || stats.total === 0) return 100.0;
    return parseFloat(((stats.successes / stats.total) * 100).toFixed(2));
  }
}

export const providerMetricsService = new ProviderMetricsService();
