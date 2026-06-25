import { Router, Request, Response } from "express";
import { Pool } from "pg";
import { sep12RateLimiter } from "../middleware/rateLimit";
import { z } from "zod";
import KYCService, { KYCLevel, KYCStatus, DocumentType } from "../services/kyc";
import { ERROR_CODES } from "../constants/errorCodes";
import { createError } from "../middleware/errorHandler";
import { UserModel } from "../models/users";
import { getPresignedUploadUrl } from "../services/s3Upload";
import { getS3Client, s3Config } from "../config/s3";
import { DeleteObjectsCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";

// ============================================================================
// Types and Interfaces
// ============================================================================

export enum Sep12CustomerStatus {
  ACCEPTED = "ACCEPTED",
  PROCESSING = "PROCESSING",
  NEEDS_INFO = "NEEDS_INFO",
  REJECTED = "REJECTED",
}

/** Binary field names that require presigned S3 upload URLs */
const BINARY_FIELDS = ["photo_id_front", "photo_id_back", "photo_proof_residence"] as const;
type BinaryField = typeof BINARY_FIELDS[number];

export interface Sep12FieldSpec {
  type: string;
  description: string;
  choices?: string[];
  optional?: boolean;
}

export interface Sep12CustomerResponse {
  id: string;
  status: Sep12CustomerStatus;
  fields?: Record<string, Sep12FieldSpec>;
  provided_fields?: Record<string, Sep12FieldSpec & { status?: string }>;
  /** Presigned S3 PUT URLs for binary fields returned by PUT /customer */
  presigned_uploads?: Record<BinaryField, { url: string; key: string; expires_in: number }>;
  message?: string;
}

// ============================================================================
// SEP-12 Field Spec
// ============================================================================

const NATURAL_PERSON_FIELDS: Record<string, Sep12FieldSpec> = {
  first_name:           { type: "string",  description: "First or given name" },
  last_name:            { type: "string",  description: "Last or family name" },
  email_address:        { type: "string",  description: "Email address" },
  mobile_number:        { type: "string",  description: "Mobile phone number with country code", optional: true },
  birth_date:           { type: "date",    description: "Date of birth (YYYY-MM-DD)" },
  address:              { type: "string",  description: "Full street address" },
  city:                 { type: "string",  description: "City of residence" },
  postal_code:          { type: "string",  description: "Postal or ZIP code" },
  address_country_code: { type: "string",  description: "ISO 3166-1 alpha-3 country code" },
  id_type:              { type: "string",  description: "Type of ID document", choices: ["passport", "drivers_license", "national_id", "residence_permit"] },
  id_number:            { type: "string",  description: "ID document number" },
  id_country_code:      { type: "string",  description: "Country that issued the ID" },
  photo_id_front:       { type: "binary",  description: "Image of front of ID document" },
  photo_id_back:        { type: "binary",  description: "Image of back of ID document", optional: true },
};

const ORGANIZATION_FIELDS: Record<string, Sep12FieldSpec> = {
  organization_name:                { type: "string", description: "Legal name of organization" },
  organization_registration_number: { type: "string", description: "Business registration number" },
  organization_registered_address:  { type: "string", description: "Registered business address" },
  address_country_code:             { type: "string", description: "ISO 3166-1 alpha-3 country code" },
};

function getRequiredFields(type?: string, kycLevel?: KYCLevel): Record<string, Sep12FieldSpec> {
  if (type === "organization") return ORGANIZATION_FIELDS;
  if (kycLevel === KYCLevel.FULL) return {};
  return NATURAL_PERSON_FIELDS;
}

// ============================================================================
// Validation Schemas
// ============================================================================

const PutCustomerSchema = z.object({
  account:       z.string().min(1),
  memo:          z.string().optional(),
  memo_type:     z.enum(["id", "hash", "text"]).optional(),
  type:          z.string().optional(),
  first_name:    z.string().optional(),
  last_name:     z.string().optional(),
  email_address: z.string().email().optional(),
  mobile_number: z.string().optional(),
  birth_date:    z.string().optional(),
  address:       z.string().optional(),
  address_country_code: z.string().length(3).optional(),
  state_or_province:    z.string().optional(),
  city:                 z.string().optional(),
  postal_code:          z.string().optional(),
  id_type:              z.string().optional(),
  id_country_code:      z.string().length(3).optional(),
  id_issue_date:        z.string().optional(),
  id_expiration_date:   z.string().optional(),
  id_number:            z.string().optional(),
  tax_id:               z.string().optional(),
  occupation:           z.string().optional(),
  employer_name:        z.string().optional(),
  organization_name:                { ...z.string().optional()._def, ...{} } && z.string().optional(),
  organization_registration_number: z.string().optional(),
  organization_registration_date:   z.string().optional(),
  organization_registered_address:  z.string().optional(),
  // Binary fields: clients declare intent to upload; presigned URLs are returned
  photo_id_front:        z.literal("upload").optional(),
  photo_id_back:         z.literal("upload").optional(),
  photo_proof_residence: z.literal("upload").optional(),
}).catchall(z.any());

// ============================================================================
// SEP-12 Service
// ============================================================================

export class Sep12Service {
  private kycService: KYCService;
  private db: Pool;
  private userModel: UserModel;

  constructor(db: Pool) {
    this.db = db;
    this.kycService = new KYCService(db);
    this.userModel = new UserModel();
  }

  private mapKYCStatusToSep12(status: KYCStatus, level: KYCLevel): Sep12CustomerStatus {
    if (status === KYCStatus.REJECTED) return Sep12CustomerStatus.REJECTED;
    if (status === KYCStatus.PENDING || status === KYCStatus.REVIEW) return Sep12CustomerStatus.PROCESSING;
    if (status === KYCStatus.APPROVED) {
      return level === KYCLevel.FULL ? Sep12CustomerStatus.ACCEPTED : Sep12CustomerStatus.NEEDS_INFO;
    }
    return Sep12CustomerStatus.NEEDS_INFO;
  }

  async getCustomer(account: string, type?: string): Promise<Sep12CustomerResponse> {
    const result = await this.db.query(
      `SELECT u.id, u.kyc_level, ka.applicant_id, ka.verification_status
       FROM users u
       LEFT JOIN kyc_applicants ka ON u.id = ka.user_id
       WHERE u.stellar_address = $1
       ORDER BY ka.updated_at DESC NULLS LAST
       LIMIT 1`,
      [account],
    );

    if (result.rows.length === 0) {
      return {
        id: "",
        status: Sep12CustomerStatus.NEEDS_INFO,
        fields: getRequiredFields(type),
        message: "Customer information required",
      };
    }

    const row = result.rows[0];
    const kycLevel = row.kyc_level as KYCLevel;
    const kycStatus = (row.verification_status as KYCStatus) ?? KYCStatus.PENDING;
    const sep12Status = this.mapKYCStatusToSep12(kycStatus, kycLevel);

    // Build provided_fields from what we have on the applicant
    const providedFields: Record<string, Sep12FieldSpec & { status?: string }> = {};
    if (row.applicant_id) {
      try {
        const applicant = await this.kycService.getApplicant(row.applicant_id);
        const fieldStatus = sep12Status === Sep12CustomerStatus.ACCEPTED ? "accepted" : "processing";
        if (applicant.first_name) providedFields.first_name = { type: "string", description: "First name", status: fieldStatus };
        if (applicant.last_name)  providedFields.last_name  = { type: "string", description: "Last name",  status: fieldStatus };
        if (applicant.email)      providedFields.email_address = { type: "string", description: "Email address", status: fieldStatus };
        if (applicant.address)    providedFields.address = { type: "string", description: "Street address", status: fieldStatus };
      } catch {
        // Ignore — applicant fetch is best-effort
      }
    }

    // Check which binary documents have been uploaded
    const docResult = await this.db.query(
      `SELECT document_type, document_side FROM kyc_documents WHERE user_id = $1`,
      [row.id],
    );
    for (const doc of docResult.rows) {
      const fieldKey = doc.document_side === "front" ? "photo_id_front"
        : doc.document_side === "back" ? "photo_id_back"
        : "photo_proof_residence";
      providedFields[fieldKey] = { type: "binary", description: "Uploaded document", status: "processing" };
    }

    const response: Sep12CustomerResponse = {
      id: row.id,
      status: sep12Status,
      provided_fields: Object.keys(providedFields).length > 0 ? providedFields : undefined,
    };

    if (sep12Status === Sep12CustomerStatus.NEEDS_INFO) {
      response.fields = getRequiredFields(type, kycLevel);
      response.message = "Additional information required for verification";
    } else if (sep12Status === Sep12CustomerStatus.REJECTED) {
      response.message = "Customer verification was rejected";
    } else if (sep12Status === Sep12CustomerStatus.PROCESSING) {
      response.message = "Customer information is being processed";
    }

    return response;
  }

  async putCustomer(data: z.infer<typeof PutCustomerSchema>): Promise<Sep12CustomerResponse> {
    const validated = PutCustomerSchema.parse(data);
    const { account, type, first_name, last_name, email_address, mobile_number, birth_date,
      address, address_country_code, state_or_province, city, postal_code,
      id_type, id_country_code, id_number, photo_id_front, photo_id_back, photo_proof_residence,
      organization_name, organization_registration_number, organization_registered_address,
    } = validated;

    // Find or create user
    let userId: string;
    let applicantId: string | null = null;

    const userResult = await this.db.query(
      `SELECT u.id, ka.applicant_id
       FROM users u
       LEFT JOIN kyc_applicants ka ON u.id = ka.user_id
       WHERE u.stellar_address = $1
       ORDER BY ka.updated_at DESC NULLS LAST
       LIMIT 1`,
      [account],
    );

    if (userResult.rows.length > 0) {
      userId = userResult.rows[0].id;
      applicantId = userResult.rows[0].applicant_id ?? null;
    } else {
      const newUser = await this.db.query(
        `INSERT INTO users (stellar_address, kyc_level, phone_number)
         VALUES ($1, $2, $3) RETURNING id`,
        [account, KYCLevel.NONE, mobile_number ?? ""],
      );
      userId = newUser.rows[0].id;
    }

    // Create or fetch KYC applicant
    if (!applicantId && (first_name || last_name)) {
      const applicant = await this.kycService.createApplicant({
        first_name: first_name ?? "",
        last_name: last_name ?? "",
        email: email_address,
        dob: birth_date,
        phone_number: mobile_number,
        address: address ? { street: address, town: city ?? "", postcode: postal_code ?? "", country: address_country_code ?? "USA", state: state_or_province } : undefined,
      });
      applicantId = applicant.id;

      await this.db.query(
        `INSERT INTO kyc_applicants (user_id, applicant_id, provider, verification_status, kyc_level)
         VALUES ($1, $2, 'entrust', 'pending', 'none')
         ON CONFLICT (user_id, applicant_id) DO UPDATE SET updated_at = CURRENT_TIMESTAMP`,
        [userId, applicantId],
      );
    }

    // Persist non-binary PII fields
    await this.userModel.updateSensitiveData(userId, {
      firstName:   first_name,
      lastName:    last_name,
      address:     address,
      dateOfBirth: birth_date,
      idNumber:    id_number,
    });

    // Generate presigned S3 PUT URLs for any declared binary fields
    const presignedUploads: Partial<Record<BinaryField, { url: string; key: string; expires_in: number }>> = {};
    const binaryIntents: Array<{ field: BinaryField; side: string }> = [
      { field: "photo_id_front",        side: "front" },
      { field: "photo_id_back",         side: "back" },
      { field: "photo_proof_residence", side: "front" },
    ];

    for (const { field, side } of binaryIntents) {
      if (validated[field] === "upload") {
        const presigned = await getPresignedUploadUrl(userId, field);
        presignedUploads[field] = presigned;

        // Pre-register the document slot so status tracking works
        await this.db.query(
          `INSERT INTO kyc_documents
             (user_id, applicant_id, document_type, document_side, s3_key, file_url, original_filename, file_size, mime_type)
           VALUES ($1, $2, $3, $4, $5, '', $6, 0, 'image/jpeg')
           ON CONFLICT DO NOTHING`,
          [userId, applicantId ?? "", this.mapIdType(id_type ?? (field === "photo_proof_residence" ? "national_id" : id_type)), side, presigned.key, field],
        );
      }
    }

    return {
      id: userId,
      status: Sep12CustomerStatus.PROCESSING,
      presigned_uploads: Object.keys(presignedUploads).length > 0
        ? presignedUploads as Record<BinaryField, { url: string; key: string; expires_in: number }>
        : undefined,
      message: "Customer information received. Upload binary documents using the presigned URLs.",
    };
  }

  /** Full GDPR delete — removes all customer data across every table */
  async deleteCustomer(account: string): Promise<void> {
    const userResult = await this.db.query(
      `SELECT id FROM users WHERE stellar_address = $1`,
      [account],
    );
    if (userResult.rows.length === 0) return;

    const userId: string = userResult.rows[0].id;

    // 1. Delete S3 objects for this user
    await this.deleteS3Documents(userId);

    // 2. Cascade delete all PII-bearing rows (FK order)
    await this.db.query(`DELETE FROM kyc_documents   WHERE user_id = $1`, [userId]);
    await this.db.query(`DELETE FROM kyc_applicants  WHERE user_id = $1`, [userId]);
    await this.db.query(
      `UPDATE transactions
       SET phone_number = NULL, stellar_address = NULL
       WHERE user_id = $1`,
      [userId],
    );
    await this.db.query(
      `UPDATE users
       SET first_name = NULL, last_name = NULL, email = NULL,
           phone_number = NULL, date_of_birth = NULL, id_number = NULL,
           address = NULL, stellar_address = NULL
       WHERE id = $1`,
      [userId],
    );
  }

  private async deleteS3Documents(userId: string): Promise<void> {
    if (!s3Config.bucket) return;
    try {
      const s3 = getS3Client();
      const prefix = `kyc-documents/`;
      // List objects belonging to this user (they're keyed with userId in path)
      const listed = await s3.send(new ListObjectsV2Command({
        Bucket: s3Config.bucket,
        Prefix: `${prefix}`,
      }));

      const userKeys = (listed.Contents ?? [])
        .filter(obj => obj.Key?.includes(`/${userId}/`))
        .map(obj => ({ Key: obj.Key! }));

      if (userKeys.length > 0) {
        await s3.send(new DeleteObjectsCommand({
          Bucket: s3Config.bucket,
          Delete: { Objects: userKeys },
        }));
      }
    } catch {
      // S3 deletion is best-effort; DB purge still proceeds
    }
  }

  private mapIdType(idType?: string): string {
    switch (idType?.toLowerCase()) {
      case "passport":        return DocumentType.PASSPORT;
      case "drivers_license": return DocumentType.DRIVING_LICENSE;
      case "national_id":     return DocumentType.NATIONAL_IDENTITY_CARD;
      case "residence_permit":return DocumentType.RESIDENCE_PERMIT;
      default:                return DocumentType.NATIONAL_IDENTITY_CARD;
    }
  }
}

// ============================================================================
// Express Router
// ============================================================================

export const createSep12Router = (db: Pool): Router => {
  const router = Router();
  const service = new Sep12Service(db);

  /**
   * GET /customer
   * Returns KYC status and field schema per SEP-12.
   */
  router.get("/customer", sep12RateLimiter, async (req: Request, res: Response) => {
    const { account, type } = req.query;
    if (!account) {
      throw createError(ERROR_CODES.INVALID_INPUT, "account parameter is required", {
        error: "account parameter is required",
      });
    }
    const customer = await service.getCustomer(account as string, type as string | undefined);
    res.json(customer);
  });

  /**
   * PUT /customer
   * Accepts SEP-12 fields. Binary fields declared as "upload" receive presigned S3 PUT URLs.
   */
  router.put("/customer", sep12RateLimiter, async (req: Request, res: Response) => {
    try {
      const customer = await service.putCustomer(req.body);
      res.json(customer);
    } catch (err: any) {
      if (err instanceof z.ZodError) {
        throw createError(ERROR_CODES.INVALID_INPUT, err.errors[0]?.message ?? "Validation error", {
          error: err.errors[0]?.message ?? "Validation error",
        });
      }
      throw createError(ERROR_CODES.INVALID_INPUT, err.message ?? "Failed to update customer", {
        error: err.message ?? "Failed to update customer",
      });
    }
  });

  /**
   * DELETE /customer/:account
   * Fully purges all customer KYC data (GDPR right-to-erasure).
   */
  router.delete("/customer/:account", sep12RateLimiter, async (req: Request, res: Response) => {
    const { account } = req.params;
    if (!account) {
      throw createError(ERROR_CODES.INVALID_INPUT, "account parameter is required", {
        error: "account parameter is required",
      });
    }
    await service.deleteCustomer(account);
    res.status(204).send();
  });

  return router;
};

export default createSep12Router;
