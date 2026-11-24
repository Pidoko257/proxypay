import {
  SplitPaymentModel,
  SplitPaymentRule,
  SplitPaymentLedgerEntry,
  SplitPaymentRecipient,
  CreateRecipientInput,
} from "../models/splitPayment";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SplitSummaryLine {
  recipientType: string;
  recipientId: string;
  recipientLabel: string | null;
  splitType: string;
  splitValue: number;
  allocatedAmount: number;
  currency: string;
  status: string;
}

export interface SplitSummary {
  transactionId: string;
  ruleId: string | null;
  totalAmount: number;
  currency: string;
  allocatedTotal: number;
  remainder: number;
  lines: SplitSummaryLine[];
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class SplitPaymentService {
  private model: SplitPaymentModel;

  constructor(model?: SplitPaymentModel) {
    this.model = model ?? new SplitPaymentModel();
  }

  // -------------------------------------------------------------------------
  // Validation
  // -------------------------------------------------------------------------

  /**
   * Validate a list of recipients before persisting.
   *
   * Rules enforced:
   *  - At least one recipient is required.
   *  - No negative split_value.
   *  - split_value for 'percentage' type must be > 0 and ≤ 100.
   *  - split_value for 'fixed' type must be > 0.
   *  - If ALL recipients use 'percentage', they must sum to exactly 100.
   *  - recipient_type must be one of 'user', 'merchant', 'phone'.
   *  - recipient_id must be non-empty.
   */
  validateRecipients(recipients: CreateRecipientInput[]): ValidationResult {
    const errors: string[] = [];

    if (!recipients || recipients.length === 0) {
      return { valid: false, errors: ["At least one recipient is required."] };
    }

    const allowedRecipientTypes = ["user", "merchant", "phone"] as const;
    const allowedSplitTypes = ["percentage", "fixed"] as const;

    let percentageTotal = 0;
    let allPercentage = true;

    for (let i = 0; i < recipients.length; i++) {
      const r = recipients[i];
      const prefix = `Recipient[${i}]`;

      // recipient_type
      if (!allowedRecipientTypes.includes(r.recipientType as typeof allowedRecipientTypes[number])) {
        errors.push(`${prefix}: recipientType must be one of: ${allowedRecipientTypes.join(", ")}.`);
      }

      // recipient_id
      if (!r.recipientId || r.recipientId.trim() === "") {
        errors.push(`${prefix}: recipientId must not be empty.`);
      }

      // split_type
      if (!allowedSplitTypes.includes(r.splitType as typeof allowedSplitTypes[number])) {
        errors.push(`${prefix}: splitType must be one of: ${allowedSplitTypes.join(", ")}.`);
      }

      // split_value
      if (typeof r.splitValue !== "number" || isNaN(r.splitValue)) {
        errors.push(`${prefix}: splitValue must be a number.`);
        continue; // Skip further value checks if NaN
      }

      if (r.splitValue <= 0) {
        errors.push(`${prefix}: splitValue must be greater than 0.`);
      }

      if (r.splitType === "percentage") {
        if (r.splitValue > 100) {
          errors.push(`${prefix}: percentage splitValue must be between 0 and 100.`);
        }
        percentageTotal += r.splitValue;
      } else {
        allPercentage = false;
      }
    }

    // If every recipient is percentage-based, they must total 100
    if (allPercentage && recipients.length > 0) {
      const rounded = Math.round(percentageTotal * 1e8) / 1e8;
      if (rounded !== 100) {
        errors.push(
          `When all recipients use 'percentage' splitType, the values must sum to 100 (got ${rounded}).`,
        );
      }
    }

    return { valid: errors.length === 0, errors };
  }

  // -------------------------------------------------------------------------
  // Rules
  // -------------------------------------------------------------------------

  /** Create a new split rule after validating recipients. */
  async createRule(
    name: string,
    description: string | null,
    recipients: CreateRecipientInput[],
    createdBy: string | null,
  ): Promise<SplitPaymentRule> {
    if (!name || name.trim() === "") {
      throw new Error("Rule name is required.");
    }

    const validation = this.validateRecipients(recipients);
    if (!validation.valid) {
      throw new Error(`Invalid recipients: ${validation.errors.join(" | ")}`);
    }

    return this.model.createRule(name.trim(), description ?? null, recipients, createdBy ?? null);
  }

  // -------------------------------------------------------------------------
  // Apply rule to a transaction
  // -------------------------------------------------------------------------

  /**
   * Calculate split allocations from a rule and total amount, then persist
   * ledger entries.
   *
   * For 'percentage' recipients the allocated_amount is proportional.
   * For 'fixed' recipients the allocated_amount is the literal split_value.
   * Remainders from floating-point rounding are added to the last recipient.
   */
  async applyRule(
    transactionId: string,
    ruleId: string,
    totalAmount: number,
    currency: string,
  ): Promise<SplitPaymentLedgerEntry[]> {
    if (totalAmount <= 0) {
      throw new Error("totalAmount must be greater than 0.");
    }

    const rule = await this.model.findRuleById(ruleId);
    if (!rule) {
      throw new Error(`Split rule with id '${ruleId}' not found.`);
    }
    if (!rule.isActive) {
      throw new Error(`Split rule '${ruleId}' is inactive and cannot be applied.`);
    }
    if (!rule.recipients || rule.recipients.length === 0) {
      throw new Error(`Split rule '${ruleId}' has no recipients defined.`);
    }

    // Sort by priority so we can assign remainder to the last entry
    const sorted: SplitPaymentRecipient[] = [...rule.recipients].sort(
      (a, b) => a.priority - b.priority,
    );

    const allocations = this._calculateAllocations(sorted, totalAmount);

    const entryInputs = allocations.map((alloc, idx) => ({
      recipientType: sorted[idx].recipientType,
      recipientId: sorted[idx].recipientId,
      recipientLabel: sorted[idx].recipientLabel ?? undefined,
      splitType: sorted[idx].splitType,
      allocatedAmount: alloc,
      currency,
    }));

    return this.model.createLedgerEntries(transactionId, ruleId, entryInputs);
  }

  /**
   * Apply the split rule and mark all ledger entries as 'processing',
   * simulating queue dispatch for actual disbursements.
   */
  async processTransaction(
    transactionId: string,
    ruleId: string,
    totalAmount: number,
    currency: string,
  ): Promise<SplitPaymentLedgerEntry[]> {
    const entries = await this.applyRule(transactionId, ruleId, totalAmount, currency);

    // Advance each entry to 'processing' to signal queue dispatch
    const updated: SplitPaymentLedgerEntry[] = [];
    for (const entry of entries) {
      const upd = await this.model.updateLedgerEntryStatus(entry.id, "processing");
      if (upd) updated.push(upd);
    }

    return updated;
  }

  // -------------------------------------------------------------------------
  // Query
  // -------------------------------------------------------------------------

  /** Return the raw ledger entries for a transaction. */
  async getTransactionSplits(transactionId: string): Promise<SplitPaymentLedgerEntry[]> {
    return this.model.getLedgerForTransaction(transactionId);
  }

  /**
   * Return a formatted summary of how a transaction was split.
   * Includes totals, per-line details, and remainder calculation.
   */
  async getSplitSummary(transactionId: string): Promise<SplitSummary> {
    const entries = await this.model.getLedgerForTransaction(transactionId);

    const allocatedTotal = entries.reduce((sum, e) => sum + e.allocatedAmount, 0);
    const currency = entries[0]?.currency ?? "XAF";

    // We can't know the original totalAmount from ledger alone without a join,
    // so we report allocatedTotal as the total and remainder as 0 in this context.
    // Callers who know the total can compute remainder themselves.
    const lines: SplitSummaryLine[] = entries.map((e) => ({
      recipientType: e.recipientType,
      recipientId: e.recipientId,
      recipientLabel: e.recipientLabel,
      splitType: e.splitType,
      splitValue: e.allocatedAmount, // raw amount allocated
      allocatedAmount: e.allocatedAmount,
      currency: e.currency,
      status: e.status,
    }));

    return {
      transactionId,
      ruleId: entries[0]?.ruleId ?? null,
      totalAmount: allocatedTotal,
      currency,
      allocatedTotal,
      remainder: 0,
      lines,
    };
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Calculate the allocated amounts for a sorted list of recipients.
   *
   * Mixed percentage / fixed splits:
   *  1. Subtract all fixed amounts first.
   *  2. Distribute the remainder proportionally among percentage recipients.
   *  3. Assign any floating-point dust to the last recipient.
   */
  private _calculateAllocations(
    recipients: SplitPaymentRecipient[],
    totalAmount: number,
  ): number[] {
    const allocations: number[] = new Array(recipients.length).fill(0);

    // 1. Fixed recipients
    let fixedSum = 0;
    for (let i = 0; i < recipients.length; i++) {
      if (recipients[i].splitType === "fixed") {
        allocations[i] = recipients[i].splitValue;
        fixedSum += recipients[i].splitValue;
      }
    }

    if (fixedSum > totalAmount) {
      throw new Error(
        `Fixed split amounts (${fixedSum}) exceed the total transaction amount (${totalAmount}).`,
      );
    }

    const remainingForPercentage = totalAmount - fixedSum;

    // 2. Percentage recipients — distribute proportionally over the remaining amount
    const percentageRecipients = recipients
      .map((r, idx) => ({ r, idx }))
      .filter(({ r }) => r.splitType === "percentage");

    if (percentageRecipients.length > 0) {
      const totalPct = percentageRecipients.reduce((s, { r }) => s + r.splitValue, 0);

      let percentageAllocated = 0;
      for (let k = 0; k < percentageRecipients.length - 1; k++) {
        const { r, idx } = percentageRecipients[k];
        const amount = Math.round(((r.splitValue / totalPct) * remainingForPercentage) * 1e8) / 1e8;
        allocations[idx] = amount;
        percentageAllocated += amount;
      }

      // Last percentage recipient gets the remainder to eliminate dust
      const { idx: lastIdx } = percentageRecipients[percentageRecipients.length - 1];
      allocations[lastIdx] = Math.round((remainingForPercentage - percentageAllocated) * 1e8) / 1e8;
    }

    return allocations;
  }
}
