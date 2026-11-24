import axios, { AxiosInstance } from 'axios';
import { Pool } from 'pg';
import { z } from 'zod';
import { AccountingService } from './accounting';
import logger from '../utils/logger';

// KYC Provider: Entrust Identity Verification (formerly Onfido)
// Documentation: https://documentation.identity.entrust.com/api/latest/

// Types for KYC integration
export enum KYCLevel {
  NONE = 'none',
  BASIC = 'basic', 
  FULL = 'full'
}

export enum KYCStatus {
  PENDING = 'pending',
  APPROVED = 'approved',
  REJECTED = 'rejected',
  REVIEW = 'review'
}

export enum DocumentType {
  PASSPORT = 'passport',
  DRIVING_LICENSE = 'driving_license',
  NATIONAL_IDENTITY_CARD = 'national_identity_card',
  RESIDENCE_PERMIT = 'residence_permit'
}

export interface KYCApplicant {
  id: string;
  first_name: string;
  last_name: string;
  email?: string;
  dob?: string;
  phone_number?: string;
  address?: {
    flat_number?: string;
    building_number?: string;
    building_name?: string;
    street: string;
    sub_street?: string;
    town: string;
    state?: string;
    postcode: string;
    country: string;
    line1?: string;
    line2?: string;
    line3?: string;
  };
  created_at: string;
  sandbox: boolean;
}

export interface KYCCheck {
  id: string;
  applicant_id: string;
  result: string;
  status: string;
  created_at: string;
  href: string;
}

export interface KYCReport {
  id: string;
  check_id: string;
  name: string;
  status: KYCStatus;
  result: string;
  breakdown?: KYCBreakdown[];
  created_at: string;
  href: string;
}

export interface KYCBreakdown {
  result: string;
  name: string;
  properties?: Record<string, any>;
}

export interface WorkflowRun {
  id: string;
  applicant_id: string;
  workflow_id: string;
  status: string;
  created_at: string;
  completed_at?: string;
  href: string;
}

export interface WebhookEvent {
  payload: {
    action: string;
    object: {
      id: string;
      type: string;
      completed_at?: string;
      status: string;
    };
    webhook_id: string;
  };
}

// SEP-12 idempotency + audit types
export interface Sep12CustomerUpdate {
  /** Stable identifier for the customer (SEP-12 `id`). */
  customerId: string;
  /** Stable identifier for this submission, used to deduplicate provider retries. */
  requestId: string;
  /** SEP-12 customer fields being submitted. */
  fields: Record<string, string>;
  /** Optional verification status reported by the provider. */
  status?: KYCStatus;
}

export interface Sep12DocumentUpdate {
  customerId: string;
  /** Stable identifier for this document submission. */
  documentId: string;
  /** Stable identifier for this submission, used to deduplicate provider retries. */
  requestId: string;
  type: DocumentType;
  side?: 'front' | 'back';
  filename: string;
  data: string;
}

export interface Sep12HistoryEntry {
  customerId: string;
  version: number;
  requestId: string;
  kind: 'customer' | 'document' | 'status';
  status?: KYCStatus;
  fields?: Record<string, string>;
  documentId?: string;
  createdAt: string;
}

// Zod schemas for validation
const CreateApplicantSchema = z.object({
  first_name: z.string().min(1),
  last_name: z.string().min(1),
  email: z.string().email().optional(),
  dob: z.string().optional(),
  phone_number: z.string().optional(),
  address: z.object({
    flat_number: z.string().optional(),
    building_number: z.string().optional(),
    building_name: z.string().optional(),
    street: z.string(),
    sub_street: z.string().optional(),
    town: z.string(),
    state: z.string().optional(),
    postcode: z.string(),
    country: z.string().length(3),
    line1: z.string().optional(),
    line2: z.string().optional(),
    line3: z.string().optional(),
  }).optional(),
});

const UploadDocumentSchema = z.object({
  applicant_id: z.string(),
  type: z.nativeEnum(DocumentType),
  side: z.enum(['front', 'back']).optional(),
  filename: z.string(),
  data: z.string(), // Base64 encoded file data
});

const Sep12CustomerUpdateSchema = z.object({
  customerId: z.string().min(1),
  requestId: z.string().min(1),
  fields: z.record(z.string()),
  status: z.nativeEnum(KYCStatus).optional(),
});

const Sep12DocumentUpdateSchema = z.object({
  customerId: z.string().min(1),
  documentId: z.string().min(1),
  requestId: z.string().min(1),
  type: z.nativeEnum(DocumentType),
  side: z.enum(['front', 'back']).optional(),
  filename: z.string().min(1),
  data: z.string().min(1),
});

export class KYCService {
  private api?: AxiosInstance;
  private db: Pool;
  private readonly baseURL: string;
  private apiKey: string;

  constructor(db: Pool) {
    this.db = db;
    this.baseURL = process.env.KYC_API_URL || 'https://api.eu.onfido.com/v3.6';
    this.apiKey = process.env.KYC_API_KEY || '';

    this.api = axios.create({
      baseURL: this.baseURL,
      headers: {
        ...(this.apiKey ? { 'Authorization': `Token token=${this.apiKey}` } : {}),
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    });

    // Add request/response interceptors for logging and deferred API key validation
    this.api.interceptors.request.use((config) => {
      const apiKey = this.requireApiKey();
      if (config.headers) {
        config.headers['Authorization'] = `Token token=${apiKey}`;
      }
      logger.info({ method: config.method?.toUpperCase(), url: config.url }, `KYC API Request: ${config.method?.toUpperCase()} ${config.url}`);
      return config;
    });

    this.api.interceptors.response.use(
      (response) => {
        logger.info({ status: response.status, url: response.config.url }, `KYC API Response: ${response.status} ${response.config.url}`);
        return response;
      },
      (error) => {
        logger.error(
          { status: error.response?.status, url: error.config?.url, data: error.response?.data },
          `KYC API Error: ${error.response?.status} ${error.config?.url}`,
        );
        return Promise.reject(error);
      }
    );

    return this.api;
  }

  /**
   * Resolve and validate the KYC API key on the first actual KYC call rather than at module load time.
   */
  private requireApiKey(): string {
    const key = this.apiKey || process.env.KYC_API_KEY || (process.env.NODE_ENV === 'test' ? 'test_key' : '');
    if (!key) {
      throw new Error('KYC_API_KEY environment variable is required');
    }
    this.apiKey = key;
    return key;
  }

  /**
   * Create a new KYC applicant
   */
  async createApplicant(applicantData: z.infer<typeof CreateApplicantSchema>): Promise<KYCApplicant> {
    this.requireApiKey();
    try {
      const validatedData = CreateApplicantSchema.parse(applicantData);

      // Deduplication check: return existing record if same name + DOB already exists
      const existing = await this.findDuplicateApplicant(
        validatedData.first_name,
        validatedData.last_name,
        validatedData.dob,
      );
      if (existing) {
        logger.info(
          { applicantId: existing.id, firstName: validatedData.first_name, lastName: validatedData.last_name },
          `[KYCService] Duplicate applicant detected for ${validatedData.first_name} ${validatedData.last_name} (dob: ${validatedData.dob ?? 'n/a'}) — returning existing record ${existing.id}`,
        );
        return existing;
      }

      const response = await this.api.post('/applicants', validatedData);
      const applicant = response.data as KYCApplicant;

      // Store applicant reference in database
      await this.storeApplicantReference(applicant);

      return applicant;
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw new Error(`Invalid applicant data: ${error.message}`);
      }
      throw new Error(`Failed to create KYC applicant: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Retrieve an existing applicant
   */
  async getApplicant(applicantId: string): Promise<KYCApplicant> {
    this.requireApiKey();
    try {
      const response = await this.getApi().get(`/applicants/${applicantId}`);
      return response.data as KYCApplicant;
    } catch (error) {
      throw new Error(`Failed to retrieve applicant: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Upload a document for verification
   */
  async uploadDocument(documentData: z.infer<typeof UploadDocumentSchema>): Promise<any> {
    this.requireApiKey();
    try {
      const validatedData = UploadDocumentSchema.parse(documentData);
      
      // For now, we'll create a simple document upload request
      // In a real implementation, you'd need to handle multipart/form-data uploads
      const documentPayload = {
        applicant_id: validatedData.applicant_id,
        type: validatedData.type,
        side: validatedData.side,
        filename: validatedData.filename,
        // Note: In production, you'd upload the actual file data
        // For now, we'll just send the metadata
      };

      const response = await this.getApi().post('/documents', documentPayload);
      return response.data;
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw new Error(`Invalid document data: ${error.message}`);
      }
      throw new Error(`Failed to upload document: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Create a workflow run for comprehensive verification
   */
  async createWorkflowRun(applicantId: string, workflowId?: string): Promise<WorkflowRun> {
    this.requireApiKey();
    try {
      const workflowData = {
        applicant_id: applicantId,
        workflow_id: workflowId || process.env.KYC_DEFAULT_WORKFLOW_ID,
      };

      const response = await this.getApi().post('/workflow_runs', workflowData);
      return response.data as WorkflowRun;
    } catch (error) {
      throw new Error(`Failed to create workflow run: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Generate SDK token for client-side SDK integration
   */
  async generateSDKToken(applicantId: string, applicationId: string): Promise<string> {
    this.requireApiKey();
    try {
      const response = await this.getApi().post('/sdk_token', {
        applicant_id: applicantId,
        application_id: applicationId,
      });

      return response.data.token;
    } catch (error) {
      throw new Error(`Failed to generate SDK token: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Get verification status for an applicant
   */
  async getVerificationStatus(applicantId: string): Promise<{
    status: KYCStatus;
    level: KYCLevel;
    checks: KYCCheck[];
    reports: KYCReport[];
  }> {
    this.requireApiKey();
    try {
      const checksResponse = await this.api.get(`/checks?applicant_id=${applicantId}`);
      const checks = checksResponse.data.checks as KYCCheck[];

      const reportsResponse = await this.api.get(`/reports?applicant_id=${applicantId}`);
      const reports = reportsResponse.data.reports as KYCReport[];

      const status = this.determineOverallStatus(checks, reports);
      const level = this.determineKYCLevel(checks, reports);

      return {
        status,
        level,
        checks,
        reports,
      };
    } catch (error) {
      throw new Error(`Failed to get verification status: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Handle webhook events from KYC provider
   */
  async handleWebhook(event: WebhookEvent): Promise<void> {
    try {
      const { payload } = event;

      switch (payload.action) {
        case 'workflow_run.completed':
          await this.handleWorkflowRunCompleted(payload.object);
          break;
        case 'check.completed':
          await this.handleCheckCompleted(payload.object);
          break;
        default:
          logger.info({ action: payload.action }, `Unhandled webhook event: ${payload.action}`);
      }
    } catch (error) {
      logger.error({ err: error }, `Failed to handle webhook: ${error instanceof Error ? error.message : 'Unknown error'}`);
      throw error;
    }
  }

  /**
   * Update user KYC level in database
   */
  async updateUserKYCLevel(userId: string, kycLevel: KYCLevel): Promise<void> {
    try {
      const query = `
        UPDATE users 
        SET kyc_level = $1, updated_at = CURRENT_TIMESTAMP 
        WHERE id = $2
      `;

      await this.db.query(query, [kycLevel, userId]);

      logger.info({ userId, kycLevel }, `Updated KYC level for user ${userId} to ${kycLevel}`);
      try {
        if (kycLevel !== KYCLevel.NONE) {
          const accountingSvc = new AccountingService();
          await accountingSvc.syncContactForUser(userId);
        }
      } catch (err) {
        logger.error(
          { err, userId },
          `Failed to sync accounting contact after KYC update for user ${userId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } catch (error) {
      logger.error({ err: error, userId, kycLevel }, `Failed to update user KYC level: ${error instanceof Error ? error.message : 'Unknown error'}`);
      throw error;
    }
  }

  /**
   * Get transaction limits for KYC level
   */
  getTransactionLimits(kycLevel: KYCLevel): {
    dailyLimit: number;
    perTransactionLimit: {
      min: number;
      max: number;
    };
  } {
    const limits = {
      [KYCLevel.NONE]: {
        dailyLimit: parseInt(process.env.LIMIT_UNVERIFIED || '0'),
        perTransactionLimit: {
          min: parseInt(process.env.MIN_TRANSACTION_AMOUNT || '100'),
          max: parseInt(process.env.MAX_TRANSACTION_AMOUNT || '1000000'),
        },
      },
      [KYCLevel.BASIC]: {
        dailyLimit: parseInt(process.env.LIMIT_BASIC || '100000'),
        perTransactionLimit: {
          min: parseInt(process.env.MIN_TRANSACTION_AMOUNT || '100'),
          max: parseInt(process.env.MAX_TRANSACTION_AMOUNT || '1000000'),
        },
      },
      [KYCLevel.FULL]: {
        dailyLimit: parseInt(process.env.LIMIT_FULL || '10000000'),
        perTransactionLimit: {
          min: parseInt(process.env.MIN_TRANSACTION_AMOUNT || '100'),
          max: parseInt(process.env.MAX_TRANSACTION_AMOUNT || '1000000'),
        },
      },
    };

    return limits[kycLevel] || limits[KYCLevel.NONE];
  }

  /**
   * Apply a SEP-12 customer update idempotently.
   *
   * Provider retries carry the same `requestId`; repeated submissions are
   * deduplicated so they do not create duplicate review work. Each accepted
   * change is appended to a versioned history so previous state is preserved.
   */
  async applySep12CustomerUpdate(update: Sep12CustomerUpdate): Promise<Sep12HistoryEntry> {
    const validated = Sep12CustomerUpdateSchema.parse(update);

    const existing = await this.findSep12HistoryByRequest(validated.customerId, validated.requestId);
    if (existing) {
      logger.info(
        { customerId: validated.customerId, requestId: validated.requestId, version: existing.version },
        `[KYCService] Duplicate SEP-12 customer update for ${validated.customerId} (request ${validated.requestId}) — returning existing version ${existing.version}`,
      );
      return existing;
    }

    const version = await this.nextSep12Version(validated.customerId);
    const entry: Sep12HistoryEntry = {
      customerId: validated.customerId,
      version,
      requestId: validated.requestId,
      kind: 'customer',
      status: validated.status,
      fields: validated.fields,
      createdAt: new Date().toISOString(),
    };

    await this.appendSep12History(entry);
    return entry;
  }

  /**
   * Apply a SEP-12 document submission idempotently.
   *
   * Documents are keyed by `documentId` so provider retries of the same
   * document do not create duplicate review work.
   */
  async applySep12DocumentUpdate(update: Sep12DocumentUpdate): Promise<Sep12HistoryEntry> {
    const validated = Sep12DocumentUpdateSchema.parse(update);

    const existing = await this.findSep12HistoryByRequest(validated.customerId, validated.requestId);
    if (existing) {
      logger.info(
        { customerId: validated.customerId, requestId: validated.requestId, version: existing.version },
        `[KYCService] Duplicate SEP-12 document update for ${validated.customerId} (request ${validated.requestId}) — returning existing version ${existing.version}`,
      );
      return existing;
    }

    const existingDoc = await this.findSep12HistoryByDocument(validated.customerId, validated.documentId);
    if (existingDoc) {
      logger.info(
        { customerId: validated.customerId, documentId: validated.documentId, version: existingDoc.version },
        `[KYCService] Duplicate SEP-12 document ${validated.documentId} for ${validated.customerId} — returning existing version ${existingDoc.version}`,
      );
      return existingDoc;
    }

    const version = await this.nextSep12Version(validated.customerId);
    const entry: Sep12HistoryEntry = {
      customerId: validated.customerId,
      version,
      requestId: validated.requestId,
      kind: 'document',
      documentId: validated.documentId,
      createdAt: new Date().toISOString(),
    };

    await this.appendSep12History(entry);
    return entry;
  }

  /**
   * Record a verification status change for a customer, preserving history.
   */
  async recordSep12StatusChange(
    customerId: string,
    requestId: string,
    status: KYCStatus,
  ): Promise<Sep12HistoryEntry> {
    const existing = await this.findSep12HistoryByRequest(customerId, requestId);
    if (existing) {
      return existing;
    }

    const version = await this.nextSep12Version(customerId);
    const entry: Sep12HistoryEntry = {
      customerId,
      version,
      requestId,
      kind: 'status',
      status,
      createdAt: new Date().toISOString(),
    };

    await this.appendSep12History(entry);
    return entry;
  }

  /**
   * Retrieve the versioned history of SEP-12 changes for a customer.
   */
  async getSep12History(customerId: string): Promise<Sep12HistoryEntry[]> {
    const result = await this.db.query(
      `SELECT customer_id, version, request_id, kind, status, fields, document_id, created_at
         FROM sep12_kyc_history
        WHERE customer_id = $1
        ORDER BY version ASC`,
      [customerId],
    );

    return result.rows.map((row) => ({
      customerId: row.customer_id,
      version: row.version,
      requestId: row.request_id,
      kind: row.kind,
      status: row.status ?? undefined,
      fields: row.fields ?? undefined,
      documentId: row.document_id ?? undefined,
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    }));
  }

  private async findSep12HistoryByRequest(
    customerId: string,
    requestId: string,
  ): Promise<Sep12HistoryEntry | null> {
    const result = await this.db.query(
      `SELECT customer_id, version, request_id, kind, status, fields, document_id, created_at
         FROM sep12_kyc_history
        WHERE customer_id = $1 AND request_id = $2
        LIMIT 1`,
      [customerId, requestId],
    );
    return result.rows.length ? this.mapSep12HistoryRow(result.rows[0]) : null;
  }

  private async findSep12HistoryByDocument(
    customerId: string,
    documentId: string,
  ): Promise<Sep12HistoryEntry | null> {
    const result = await this.db.query(
      `SELECT customer_id, version, request_id, kind, status, fields, document_id, created_at
         FROM sep12_kyc_history
        WHERE customer_id = $1 AND document_id = $2
        LIMIT 1`,
      [customerId, documentId],
    );
    return result.rows.length ? this.mapSep12HistoryRow(result.rows[0]) : null;
  }

  private async nextSep12Version(customerId: string): Promise<number> {
    const result = await this.db.query(
      `SELECT COALESCE(MAX(version), 0) + 1 AS next_version
         FROM sep12_kyc_history
        WHERE customer_id = $1`,
      [customerId],
    );
    return Number(result.rows[0]?.next_version ?? 1);
  }

  private async appendSep12History(entry: Sep12HistoryEntry): Promise<void> {
    await this.db.query(
      `INSERT INTO sep12_kyc_history
         (customer_id, version, request_id, kind, status, fields, document_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (customer_id, request_id) DO NOTHING`,
      [
        entry.customerId,
        entry.version,
        entry.requestId,
        entry.kind,
        entry.status ?? null,
        entry.fields ? JSON.stringify(entry.fields) : null,
        entry.documentId ?? null,
        entry.createdAt,
      ],
    );
  }

  private mapSep12HistoryRow(row: any): Sep12HistoryEntry {
    return {
      customerId: row.customer_id,
      version: row.version,
      requestId: row.request_id,
      kind: row.kind,
      status: row.status ?? undefined,
      fields: row.fields ?? undefined,
      documentId: row.document_id ?? undefined,
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    };
  }

  private async findDuplicateApplicant(
    firstName: string,
    lastName: string,
    dob?: string,
  ): Promise<KYCApplicant | null> {
    try {
      const result = await this.db.query(
        `SELECT applicant_id, first_name, last_name, dob, created_at, applicant_data
           FROM kyc_applicants
          WHERE lower(first_name) = lower($1)
            AND lower(last_name) = lower($2)
            AND ($3::text IS NULL OR dob = $3)
          LIMIT 1`,
        [firstName, lastName, dob ?? null],
      );

      if (!result.rows.length) {
        return null;
      }

      const row = result.rows[0];
      if (row.applicant_data) {
        return row.applicant_data as KYCApplicant;
      }
      return {
        id: row.applicant_id,
        first_name: row.first_name,
        last_name: row.last_name,
        dob: row.dob ?? undefined,
        created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
        sandbox: process.env.NODE_ENV !== 'production',
      };
    } catch (error) {
      logger.error(
        { err: error },
        `[KYCService] findDuplicateApplicant error: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
      return null;
    }
  }

  private async storeApplicantReference(applicant: KYCApplicant): Promise<void> {
    try {
      await this.db.query(
        `INSERT INTO kyc_applicants (applicant_id, first_name, last_name, dob, created_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (applicant_id) DO NOTHING`,
        [
          applicant.id,
          applicant.first_name,
          applicant.last_name,
          applicant.dob ?? null,
          applicant.created_at,
        ],
      );
    } catch (error) {
      logger.error(
        { err: error, applicantId: applicant.id },
        `Failed to store applicant reference: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  private determineOverallStatus(checks: KYCCheck[], reports: KYCReport[]): KYCStatus {
    if (checks.length === 0 && reports.length === 0) {
      return KYCStatus.PENDING;
    }

    const hasRejected = reports.some(report => report.status === KYCStatus.REJECTED);
    if (hasRejected) return KYCStatus.REJECTED;

    const hasReview = reports.some(report => report.status === KYCStatus.REVIEW);
    if (hasReview) return KYCStatus.REVIEW;

    const allApproved = reports.every(report => report.status === KYCStatus.APPROVED);
    if (allApproved) return KYCStatus.APPROVED;

    return KYCStatus.PENDING;
  }

  private determineKYCLevel(checks: KYCCheck[], reports: KYCReport[]): KYCLevel {
    const documentReports = reports.filter(report =>
      report.name.includes('document') || report.name.includes('identity')
    );

    if (documentReports.length === 0) {
      return KYCLevel.NONE;
    }

    const hasBasicDocuments = documentReports.some(report =>
      report.status === KYCStatus.APPROVED
    );

    if (!hasBasicDocuments) {
      return KYCLevel.NONE;
    }

    const hasAdvancedVerification = reports.some(report =>
      report.name.includes('facial') ||
      report.name.includes('address') ||
      report.name.includes('enhanced')
    );

    return hasAdvancedVerification ? KYCLevel.FULL : KYCLevel.BASIC;
  }

  private async handleWorkflowRunCompleted(workflowRun: any): Promise<void> {
    try {
      const applicantId = workflowRun.id;
      const verificationStatus = await this.getVerificationStatus(applicantId);

      const userQuery = `
        SELECT u.id FROM users u
        JOIN kyc_applicants ka ON u.id = ka.user_id
        WHERE ka.applicant_id = $1
      `;

      const result = await this.db.query(userQuery, [applicantId]);

      if (result.rows.length > 0) {
        const userId = result.rows[0].id;
        await this.updateUserKYCLevel(userId, verificationStatus.level);
      }
    } catch (error) {
      logger.error(
        { err: error },
        `Failed to handle workflow run completion: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  private async handleCheckCompleted(check: any): Promise<void> {
    try {
      const applicantId = check.applicant_id;
      const verificationStatus = await this.getVerificationStatus(applicantId);

      const userQuery = `
        SELECT u.id FROM users u
        JOIN kyc_applicants ka ON u.id = ka.user_id
        WHERE ka.applicant_id = $1
      `;

      const result = await this.db.query(userQuery, [applicantId]);

      if (result.rows.length > 0) {
        const userId = result.rows[0].id;
        await this.updateUserKYCLevel(userId, verificationStatus.level);
      }
    } catch (error) {
      logger.error(
        { err: error },
        `Failed to handle check completion: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }
}

export default KYCService;
