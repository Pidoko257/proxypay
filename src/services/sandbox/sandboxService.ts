export type SandboxOutcome = "success" | "insufficient_funds" | "timeout";

export interface SandboxResult {
  success: boolean;
  providerResponseTimeMs: number;
  error?: string;
  providerReference?: string;
}

export class SandboxService {
  private phoneNumberOutcomes: Map<string, SandboxOutcome>;
  private defaultOutcome: SandboxOutcome;

  constructor() {
    // Default mappings: specific phone numbers trigger specific outcomes
    this.phoneNumberOutcomes = new Map([
      ["+1234567890", "success"],
      ["+1234567891", "insufficient_funds"],
      ["+1234567892", "timeout"],
    ]);
    this.defaultOutcome = "success";
  }

  /**
   * Get the outcome for a phone number
   */
  getOutcome(phoneNumber: string): SandboxOutcome {
    // Normalize the phone number (remove non-digit characters except leading +)
    const normalized = phoneNumber.trim();
    return this.phoneNumberOutcomes.get(normalized) || this.defaultOutcome;
  }

  /**
   * Simulate a mobile money payment (deposit)
   */
  async simulateInitiatePayment(
    provider: string,
    phoneNumber: string,
    amount: string,
  ): Promise<SandboxResult> {
    const startTime = Date.now();
    await new Promise(resolve => setTimeout(resolve, Math.random() * 200 + 50)); // Simulate network delay
    const endTime = Date.now();

    const outcome = this.getOutcome(phoneNumber);

    switch (outcome) {
      case "success":
        return {
          success: true,
          providerResponseTimeMs: endTime - startTime,
          providerReference: `sandbox-ref-${Date.now()}`,
        };
      case "insufficient_funds":
        return {
          success: false,
          providerResponseTimeMs: endTime - startTime,
          error: "Insufficient funds in mobile money account",
        };
      case "timeout":
        return {
          success: false,
          providerResponseTimeMs: endTime - startTime,
          error: "Provider timeout",
        };
      default:
        return {
          success: true,
          providerResponseTimeMs: endTime - startTime,
          providerReference: `sandbox-ref-${Date.now()}`,
        };
    }
  }

  /**
   * Simulate a mobile money payout (withdrawal)
   */
  async simulateSendPayout(
    provider: string,
    phoneNumber: string,
    amount: string,
  ): Promise<SandboxResult> {
    // Same as initiate payment for now
    return this.simulateInitiatePayment(provider, phoneNumber, amount);
  }

  /**
   * Simulate a Stellar payment
   */
  async simulateStellarPayment(
    destination: string,
    amount: string,
  ): Promise<{ hash: string; submittedAt: Date }> {
    await new Promise(resolve => setTimeout(resolve, Math.random() * 200 + 50));
    return {
      hash: `sandbox-tx-hash-${Date.now()}`,
      submittedAt: new Date(),
    };
  }
}

export const sandboxService = new SandboxService();
