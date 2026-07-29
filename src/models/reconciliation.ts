import { queryRead, queryWrite } from "../config/database";

export interface ReconciliationJob {
  id: string;
  jobType: string;
  status: "pending" | "in_progress" | "completed" | "failed" | "partial";
  startedAt?: Date;
  completedAt?: Date;
  totalAccounts: number;
  successfulChecks: number;
  discrepanciesFound: number;
  autoCorrections: number;
  manualReviewsNeeded: number;
  durationMs?: number;
  errorsEncountered: number;
  errorMessage?: string;
  summary?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface WalletDiscrepancy {
  id: string;
  reconciliationJobId: string;
  userId?: string;
  vaultId?: string;
  walletAddress?: string;
  accountIdentifier?: string;
  ledgerBalance?: number;
  stellarBalance?: number;
  discrepancyAmount: number;
  discrepancyType: string;
  assetCode?: string;
  issuerAddress?: string;
  status: "pending" | "investigating" | "auto_corrected" | "manual_review" | "resolved";
  resolutionType?: string;
  possibleCauses?: string[];
  investigationNotes?: string;
  resolutionNotes?: string;
  autoCorrectionApplied: boolean;
  correctionTransactionId?: string;
  reviewedBy?: string;
  reviewedAt?: Date;
  manualResolutionAt?: Date;
  severity?: string;
  createdAt: Date;
  updatedAt: Date;
  resolvedAt?: Date;
}

export interface AccountBalanceSnapshot {
  id: string;
  reconciliationJobId: string;
  userId?: string;
  vaultId?: string;
  walletAddress?: string;
  accountType: string;
  ledgerBalance?: number;
  stellarBalance?: number;
  vaultBalance?: number;
  assetCode?: string;
  issuerAddress?: string;
  recentTransactionCount: number;
  lastTransactionAt?: Date;
  balanceConsistency: boolean;
  reconciliationStatus: string;
  createdAt: Date;
}

export interface StellarTransactionVerification {
  id: string;
  stellarTxHash: string;
  sourceAccount: string;
  destinationAccount?: string;
  operationType: string;
  amount?: number;
  proxypayTransactionId?: string;
  userId?: string;
  status: "pending" | "verified" | "failed" | "discrepancy";
  verifiedAt?: Date;
  ledgerNum?: number;
  confirmed: boolean;
  finalConfirmations: number;
  discrepancyFound: boolean;
  discrepancyType?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ReconciliationSettings {
  id: string;
  discrepancyThresholdUsd: number;
  criticalThresholdUsd: number;
  autoCorrectionEnabled: boolean;
  autoCorrectionMaxAmount: number;
  autoCorrectionLedgerOnly: boolean;
  reconciliationIntervalMinutes: number;
  alertEnabled: boolean;
  alertChannels: string[];
  alertRecipients: string[];
  maxAutoInvestigationDays: number;
  enableManualOverride: boolean;
  batchSize: number;
  maxParallelChecks: number;
  createdAt: Date;
  updatedAt: Date;
}

export class ReconciliationJobModel {
  async create(data: {
    jobType: string;
    totalAccounts?: number;
  }): Promise<ReconciliationJob> {
    const result = await queryWrite(
      `INSERT INTO reconciliation_jobs (job_type, total_accounts, status)
       VALUES ($1, $2, 'pending')
       RETURNING *`,
      [data.jobType, data.totalAccounts || 0],
    );
    return this.mapRow(result.rows[0]);
  }

  async findById(jobId: string): Promise<ReconciliationJob | null> {
    const result = await queryRead(
      "SELECT * FROM reconciliation_jobs WHERE id = $1",
      [jobId],
    );
    return result.rows.length > 0 ? this.mapRow(result.rows[0]) : null;
  }

  async updateStatus(
    jobId: string,
    status: ReconciliationJob["status"],
    updates?: Partial<ReconciliationJob>,
  ): Promise<ReconciliationJob> {
    const fields: string[] = ["status = $2"];
    const values: any[] = [jobId, status];
    let paramIdx = 3;

    if (updates?.successfulChecks !== undefined) {
      fields.push(`successful_checks = $${paramIdx++}`);
      values.push(updates.successfulChecks);
    }
    if (updates?.discrepanciesFound !== undefined) {
      fields.push(`discrepancies_found = $${paramIdx++}`);
      values.push(updates.discrepanciesFound);
    }
    if (updates?.autoCorrections !== undefined) {
      fields.push(`auto_corrections = $${paramIdx++}`);
      values.push(updates.autoCorrections);
    }
    if (updates?.manualReviewsNeeded !== undefined) {
      fields.push(`manual_reviews_needed = $${paramIdx++}`);
      values.push(updates.manualReviewsNeeded);
    }
    if (updates?.errorsEncountered !== undefined) {
      fields.push(`errors_encountered = $${paramIdx++}`);
      values.push(updates.errorsEncountered);
    }
    if (updates?.errorMessage !== undefined) {
      fields.push(`error_message = $${paramIdx++}`);
      values.push(updates.errorMessage);
    }
    if (updates?.summary !== undefined) {
      fields.push(`summary = $${paramIdx++}`);
      values.push(updates.summary);
    }

    if (status === "in_progress") {
      fields.push(`started_at = CURRENT_TIMESTAMP`);
    } else if (status === "completed" || status === "failed" || status === "partial") {
      fields.push(`completed_at = CURRENT_TIMESTAMP`);
      fields.push(`duration_ms = EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - started_at)) * 1000`);
    }

    const query = `UPDATE reconciliation_jobs 
                   SET ${fields.join(", ")} 
                   WHERE id = $1 
                   RETURNING *`;

    const result = await queryWrite(query, values);
    return this.mapRow(result.rows[0]);
  }

  async getLatestByType(jobType: string): Promise<ReconciliationJob | null> {
    const result = await queryRead(
      `SELECT * FROM reconciliation_jobs 
       WHERE job_type = $1 
       ORDER BY created_at DESC 
       LIMIT 1`,
      [jobType],
    );
    return result.rows.length > 0 ? this.mapRow(result.rows[0]) : null;
  }

  private mapRow(row: any): ReconciliationJob {
    return {
      id: row.id,
      jobType: row.job_type,
      status: row.status,
      startedAt: row.started_at ? new Date(row.started_at) : undefined,
      completedAt: row.completed_at ? new Date(row.completed_at) : undefined,
      totalAccounts: row.total_accounts || 0,
      successfulChecks: row.successful_checks || 0,
      discrepanciesFound: row.discrepancies_found || 0,
      autoCorrections: row.auto_corrections || 0,
      manualReviewsNeeded: row.manual_reviews_needed || 0,
      durationMs: row.duration_ms,
      errorsEncountered: row.errors_encountered || 0,
      errorMessage: row.error_message,
      summary: row.summary,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }
}

export class WalletDiscrepancyModel {
  async create(data: Omit<WalletDiscrepancy, "id" | "createdAt" | "updatedAt">): Promise<WalletDiscrepancy> {
    const result = await queryWrite(
      `INSERT INTO wallet_discrepancies (
         reconciliation_job_id, user_id, vault_id, wallet_address, account_identifier,
         ledger_balance, stellar_balance, discrepancy_amount, discrepancy_type,
         asset_code, issuer_address, status, severity, possible_causes
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       RETURNING *`,
      [
        data.reconciliationJobId,
        data.userId || null,
        data.vaultId || null,
        data.walletAddress || null,
        data.accountIdentifier || null,
        data.ledgerBalance || null,
        data.stellarBalance || null,
        data.discrepancyAmount,
        data.discrepancyType,
        data.assetCode || null,
        data.issuerAddress || null,
        data.status,
        data.severity || "medium",
        data.possibleCauses || null,
      ],
    );
    return this.mapRow(result.rows[0]);
  }

  async findByJobId(jobId: string, limit: number = 100): Promise<WalletDiscrepancy[]> {
    const result = await queryRead(
      `SELECT * FROM wallet_discrepancies 
       WHERE reconciliation_job_id = $1 
       ORDER BY severity DESC, created_at DESC 
       LIMIT $2`,
      [jobId, limit],
    );
    return result.rows.map((row) => this.mapRow(row));
  }

  async updateStatus(
    discrepancyId: string,
    status: WalletDiscrepancy["status"],
    updates?: Partial<WalletDiscrepancy>,
  ): Promise<WalletDiscrepancy> {
    const fields: string[] = ["status = $2"];
    const values: any[] = [discrepancyId, status];
    let paramIdx = 3;

    if (updates?.resolutionType !== undefined) {
      fields.push(`resolution_type = $${paramIdx++}`);
      values.push(updates.resolutionType);
    }
    if (updates?.investigationNotes !== undefined) {
      fields.push(`investigation_notes = $${paramIdx++}`);
      values.push(updates.investigationNotes);
    }
    if (updates?.resolutionNotes !== undefined) {
      fields.push(`resolution_notes = $${paramIdx++}`);
      values.push(updates.resolutionNotes);
    }
    if (updates?.autoCorrectionApplied !== undefined) {
      fields.push(`auto_correction_applied = $${paramIdx++}`);
      values.push(updates.autoCorrectionApplied);
    }
    if (updates?.correctionTransactionId !== undefined) {
      fields.push(`correction_transaction_id = $${paramIdx++}`);
      values.push(updates.correctionTransactionId);
    }
    if (updates?.reviewedBy !== undefined) {
      fields.push(`reviewed_by = $${paramIdx++}`);
      values.push(updates.reviewedBy);
    }

    if (status === "resolved") {
      fields.push(`resolved_at = CURRENT_TIMESTAMP`);
    }

    const query = `UPDATE wallet_discrepancies 
                   SET ${fields.join(", ")} 
                   WHERE id = $1 
                   RETURNING *`;

    const result = await queryWrite(query, values);
    return this.mapRow(result.rows[0]);
  }

  async getPendingDiscrepancies(limit: number = 100): Promise<WalletDiscrepancy[]> {
    const result = await queryRead(
      `SELECT * FROM wallet_discrepancies 
       WHERE status IN ('pending', 'investigating') 
       ORDER BY severity DESC, created_at ASC 
       LIMIT $1`,
      [limit],
    );
    return result.rows.map((row) => this.mapRow(row));
  }

  private mapRow(row: any): WalletDiscrepancy {
    return {
      id: row.id,
      reconciliationJobId: row.reconciliation_job_id,
      userId: row.user_id,
      vaultId: row.vault_id,
      walletAddress: row.wallet_address,
      accountIdentifier: row.account_identifier,
      ledgerBalance: row.ledger_balance ? parseFloat(row.ledger_balance) : undefined,
      stellarBalance: row.stellar_balance ? parseFloat(row.stellar_balance) : undefined,
      discrepancyAmount: parseFloat(row.discrepancy_amount),
      discrepancyType: row.discrepancy_type,
      assetCode: row.asset_code,
      issuerAddress: row.issuer_address,
      status: row.status,
      resolutionType: row.resolution_type,
      possibleCauses: row.possible_causes,
      investigationNotes: row.investigation_notes,
      resolutionNotes: row.resolution_notes,
      autoCorrectionApplied: row.auto_correction_applied || false,
      correctionTransactionId: row.correction_transaction_id,
      reviewedBy: row.reviewed_by,
      reviewedAt: row.reviewed_at ? new Date(row.reviewed_at) : undefined,
      manualResolutionAt: row.manual_resolution_at ? new Date(row.manual_resolution_at) : undefined,
      severity: row.severity,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
      resolvedAt: row.resolved_at ? new Date(row.resolved_at) : undefined,
    };
  }
}

export class StellarTransactionVerificationModel {
  async createOrUpdate(
    data: Omit<StellarTransactionVerification, "id" | "createdAt" | "updatedAt">,
  ): Promise<StellarTransactionVerification> {
    const result = await queryWrite(
      `INSERT INTO stellar_transaction_verifications (
         stellar_tx_hash, source_account, destination_account, operation_type,
         amount, proxypay_transaction_id, user_id, status
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (stellar_tx_hash) 
       DO UPDATE SET updated_at = CURRENT_TIMESTAMP
       RETURNING *`,
      [
        data.stellarTxHash,
        data.sourceAccount,
        data.destinationAccount || null,
        data.operationType,
        data.amount || null,
        data.proxypayTransactionId || null,
        data.userId || null,
        data.status,
      ],
    );
    return this.mapRow(result.rows[0]);
  }

  async findByHash(txHash: string): Promise<StellarTransactionVerification | null> {
    const result = await queryRead(
      "SELECT * FROM stellar_transaction_verifications WHERE stellar_tx_hash = $1",
      [txHash],
    );
    return result.rows.length > 0 ? this.mapRow(result.rows[0]) : null;
  }

  private mapRow(row: any): StellarTransactionVerification {
    return {
      id: row.id,
      stellarTxHash: row.stellar_tx_hash,
      sourceAccount: row.source_account,
      destinationAccount: row.destination_account,
      operationType: row.operation_type,
      amount: row.amount ? parseFloat(row.amount) : undefined,
      proxypayTransactionId: row.proxypay_transaction_id,
      userId: row.user_id,
      status: row.status,
      verifiedAt: row.verified_at ? new Date(row.verified_at) : undefined,
      ledgerNum: row.ledger_num,
      confirmed: row.confirmed || false,
      finalConfirmations: row.final_confirmations || 0,
      discrepancyFound: row.discrepancy_found || false,
      discrepancyType: row.discrepancy_type,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }
}

export class ReconciliationSettingsModel {
  async getSettings(): Promise<ReconciliationSettings> {
    const result = await queryRead("SELECT * FROM reconciliation_settings LIMIT 1", []);
    if (result.rows.length === 0) {
      // Create default settings if none exist
      return this.createDefaults();
    }
    return this.mapRow(result.rows[0]);
  }

  async updateSettings(updates: Partial<ReconciliationSettings>): Promise<ReconciliationSettings> {
    const fields: string[] = [];
    const values: any[] = [];
    let paramIdx = 1;

    if (updates.discrepancyThresholdUsd !== undefined) {
      fields.push(`discrepancy_threshold_usd = $${paramIdx++}`);
      values.push(updates.discrepancyThresholdUsd);
    }
    if (updates.criticalThresholdUsd !== undefined) {
      fields.push(`critical_threshold_usd = $${paramIdx++}`);
      values.push(updates.criticalThresholdUsd);
    }
    if (updates.autoCorrectionEnabled !== undefined) {
      fields.push(`auto_correct_enabled = $${paramIdx++}`);
      values.push(updates.autoCorrectionEnabled);
    }
    if (updates.alertChannels !== undefined) {
      fields.push(`alert_channels = $${paramIdx++}`);
      values.push(updates.alertChannels);
    }

    const query = `UPDATE reconciliation_settings 
                   SET ${fields.join(", ")} 
                   WHERE id = (SELECT id FROM reconciliation_settings LIMIT 1)
                   RETURNING *`;

    const result = await queryWrite(query, values);
    return this.mapRow(result.rows[0]);
  }

  private async createDefaults(): Promise<ReconciliationSettings> {
    const result = await queryWrite(
      `INSERT INTO reconciliation_settings (
         discrepancy_threshold_usd, critical_threshold_usd,
         auto_correct_enabled, reconciliation_interval_minutes, alert_enabled
       ) VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [1.0, 1000.0, false, 60, true],
    );
    return this.mapRow(result.rows[0]);
  }

  private mapRow(row: any): ReconciliationSettings {
    return {
      id: row.id,
      discrepancyThresholdUsd: parseFloat(row.discrepancy_threshold_usd),
      criticalThresholdUsd: parseFloat(row.critical_threshold_usd),
      autoCorrectionEnabled: row.auto_correct_enabled,
      autoCorrectionMaxAmount: parseFloat(row.auto_correct_max_amount || "0"),
      autoCorrectionLedgerOnly: row.auto_correct_ledger_only,
      reconciliationIntervalMinutes: row.reconciliation_interval_minutes,
      alertEnabled: row.alert_enabled,
      alertChannels: row.alert_channels || [],
      alertRecipients: row.alert_recipients || [],
      maxAutoInvestigationDays: row.max_auto_investigation_days,
      enableManualOverride: row.enable_manual_override,
      batchSize: row.batch_size,
      maxParallelChecks: row.max_parallel_checks,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }
}

export const reconciliationJobModel = new ReconciliationJobModel();
export const walletDiscrepancyModel = new WalletDiscrepancyModel();
export const stellarTransactionVerificationModel = new StellarTransactionVerificationModel();
export const reconciliationSettingsModel = new ReconciliationSettingsModel();
