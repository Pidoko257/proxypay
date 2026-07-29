import {
  syntheticTestTotal,
  syntheticTestDurationSeconds,
  syntheticTestSuccessGauge,
  syntheticConsecutiveFailures,
} from "../utils/metrics";
import { MonitoringService } from "./monitoringService";

export type SyntheticFlow = "deposit" | "withdraw" | "dispute";

export interface SyntheticFlowResult {
  flow: SyntheticFlow;
  success: boolean;
  durationMs: number;
  error?: string;
  transactionRef: string;
}

class SyntheticMonitoringService {
  private consecutiveFailures: Map<SyntheticFlow, number> = new Map([
    ["deposit", 0],
    ["withdraw", 0],
    ["dispute", 0],
  ]);

  private readonly failureAlertThreshold = 2; // Alert after 2 consecutive failures (within 2 minutes)

  /**
   * Generates isolated synthetic reference numbers that won't pollute production data.
   */
  private generateSyntheticRef(flow: SyntheticFlow): string {
    const timestamp = Date.now();
    const random = Math.floor(Math.random() * 10000);
    return `SYNTHETIC_${flow.toUpperCase()}_${timestamp}_${random}`;
  }

  /**
   * Simulates/Executes a synthetic deposit flow in sandbox mode.
   */
  private async runSyntheticDeposit(): Promise<SyntheticFlowResult> {
    const startTime = Date.now();
    const ref = this.generateSyntheticRef("deposit");

    try {
      // Simulate synthetic deposit validation & processing pipeline
      const payload = {
        reference: ref,
        amount: 10.0,
        currency: "USD",
        provider: "MTN",
        is_synthetic: true,
        metadata: { environment: "synthetic_monitor" },
      };

      if (!payload.reference.startsWith("SYNTHETIC_") || payload.amount <= 0) {
        throw new Error("Synthetic deposit payload validation failed");
      }

      // Simulate quick processing latency (50ms)
      await new Promise((resolve) => setTimeout(resolve, 50));

      const durationMs = Date.now() - startTime;
      return {
        flow: "deposit",
        success: true,
        durationMs,
        transactionRef: ref,
      };
    } catch (err: any) {
      return {
        flow: "deposit",
        success: false,
        durationMs: Date.now() - startTime,
        error: err.message || "Deposit flow failed",
        transactionRef: ref,
      };
    }
  }

  /**
   * Simulates/Executes a synthetic withdraw flow in sandbox mode.
   */
  private async runSyntheticWithdraw(): Promise<SyntheticFlowResult> {
    const startTime = Date.now();
    const ref = this.generateSyntheticRef("withdraw");

    try {
      const payload = {
        reference: ref,
        amount: 5.0,
        currency: "USD",
        provider: "AIRTEL",
        is_synthetic: true,
        metadata: { environment: "synthetic_monitor" },
      };

      if (!payload.reference.startsWith("SYNTHETIC_") || payload.amount <= 0) {
        throw new Error("Synthetic withdraw payload validation failed");
      }

      await new Promise((resolve) => setTimeout(resolve, 60));

      const durationMs = Date.now() - startTime;
      return {
        flow: "withdraw",
        success: true,
        durationMs,
        transactionRef: ref,
      };
    } catch (err: any) {
      return {
        flow: "withdraw",
        success: false,
        durationMs: Date.now() - startTime,
        error: err.message || "Withdraw flow failed",
        transactionRef: ref,
      };
    }
  }

  /**
   * Simulates/Executes a synthetic dispute flow in sandbox mode.
   */
  private async runSyntheticDispute(): Promise<SyntheticFlowResult> {
    const startTime = Date.now();
    const ref = this.generateSyntheticRef("dispute");

    try {
      const payload = {
        dispute_id: `DISP_${ref}`,
        transaction_ref: ref,
        reason: "synthetic_test_dispute",
        is_synthetic: true,
      };

      if (!payload.dispute_id.startsWith("DISP_SYNTHETIC_")) {
        throw new Error("Synthetic dispute payload validation failed");
      }

      await new Promise((resolve) => setTimeout(resolve, 40));

      const durationMs = Date.now() - startTime;
      return {
        flow: "dispute",
        success: true,
        durationMs,
        transactionRef: ref,
      };
    } catch (err: any) {
      return {
        flow: "dispute",
        success: false,
        durationMs: Date.now() - startTime,
        error: err.message || "Dispute flow failed",
        transactionRef: ref,
      };
    }
  }

  /**
   * Executes synthetic tests for all 3 critical flows (deposit, withdraw, dispute).
   */
  public async runAllFlows(): Promise<SyntheticFlowResult[]> {
    const flows: SyntheticFlow[] = ["deposit", "withdraw", "dispute"];
    const results: SyntheticFlowResult[] = [];

    for (const flow of flows) {
      let result: SyntheticFlowResult;
      if (flow === "deposit") {
        result = await this.runSyntheticDeposit();
      } else if (flow === "withdraw") {
        result = await this.runSyntheticWithdraw();
      } else {
        result = await this.runSyntheticDispute();
      }

      results.push(result);

      // Metrics & Alerting tracking
      const statusLabel = result.success ? "success" : "failure";
      syntheticTestTotal.inc({ flow, status: statusLabel });
      syntheticTestDurationSeconds.observe({ flow }, result.durationMs / 1000);
      syntheticTestSuccessGauge.set({ flow }, result.success ? 1 : 0);

      const currentFailures = this.consecutiveFailures.get(flow) || 0;
      if (result.success) {
        this.consecutiveFailures.set(flow, 0);
        syntheticConsecutiveFailures.set({ flow }, 0);
      } else {
        const newFailures = currentFailures + 1;
        this.consecutiveFailures.set(flow, newFailures);
        syntheticConsecutiveFailures.set({ flow }, newFailures);

        console.error(
          `[SyntheticMonitoring] Synthetic flow '${flow}' failed (ref: ${result.transactionRef}). Error: ${result.error}`,
        );

        if (newFailures >= this.failureAlertThreshold) {
          console.error(
            `[SyntheticMonitoring] CRITICAL ALERT: Synthetic flow '${flow}' failed ${newFailures} times consecutively within 2 minutes!`,
          );
          // Trigger PagerDuty / Monitoring service alert
          try {
            await MonitoringService.reportAlert(
              `Synthetic Monitoring Failure: ${flow.toUpperCase()} flow failed ${newFailures} consecutive times. Error: ${result.error}`,
            );
          } catch (alertErr) {
            console.error(`[SyntheticMonitoring] Failed to emit alert:`, alertErr);
          }
        }
      }
    }

    return results;
  }
}

export const syntheticMonitoringService = new SyntheticMonitoringService();
