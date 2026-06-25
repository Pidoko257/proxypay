import request from "supertest";
import express, { Express } from "express";
import { Pool } from "pg";
import { createSep12Router, Sep12CustomerStatus } from "../sep12";
import KYCService, { KYCLevel, KYCStatus } from "../../services/kyc";
import * as s3Upload from "../../services/s3Upload";

jest.mock("../../middleware/rateLimit", () => ({
  sep12RateLimiter: (_req: any, _res: any, next: any) => next(),
}));
jest.mock("../../services/kyc");
jest.mock("../../services/s3Upload");
jest.mock("../../models/users", () => ({
  UserModel: jest.fn().mockImplementation(() => ({
    updateSensitiveData: jest.fn().mockResolvedValue(undefined),
  })),
}));
jest.mock("../../config/s3", () => ({
  getS3Client: jest.fn(),
  s3Config: { bucket: "test-bucket", region: "us-east-1" },
  getS3ObjectUrl: jest.fn((key: string) => `https://test-bucket.s3.amazonaws.com/${key}`),
}));

const mockPresignedUploadUrl = s3Upload.getPresignedUploadUrl as jest.Mock;

describe("SEP-12 KYC API", () => {
  let app: Express;
  let mockDb: jest.Mocked<Pool>;
  let mockKycService: jest.Mocked<KYCService>;

  const emptyQueryResult = { rows: [], command: "", oid: 0, rowCount: 0, fields: [] };
  const rowQueryResult = (rows: any[]) => ({ rows, command: "", oid: 0, rowCount: rows.length, fields: [] });

  beforeEach(() => {
    mockDb = { query: jest.fn() } as any;

    mockKycService = {
      createApplicant: jest.fn(),
      getApplicant: jest.fn(),
      uploadDocument: jest.fn(),
      getVerificationStatus: jest.fn(),
      getTransactionLimits: jest.fn(),
      handleWebhook: jest.fn(),
    } as any;

    (KYCService as jest.MockedClass<typeof KYCService>).mockImplementation(() => mockKycService);

    mockPresignedUploadUrl.mockResolvedValue({
      url: "https://s3.amazonaws.com/presigned-url",
      key: "kyc-documents/2026/06/user-123/photo_id_front.jpg",
      expires_in: 900,
    });

    app = express();
    app.use(express.json());
    app.use("/sep12", createSep12Router(mockDb));
    // Minimal error handler so validation errors surface as 400
    app.use((err: any, _req: any, res: any, _next: any) => {
      res.status(err.statusCode ?? 400).json({ error: err.message ?? "error" });
    });
  });

  afterEach(() => jest.clearAllMocks());

  // =========================================================================
  // GET /customer
  // =========================================================================
  describe("GET /customer", () => {
    it("returns NEEDS_INFO with full field schema for unknown account", async () => {
      mockDb.query.mockResolvedValue(emptyQueryResult);

      const res = await request(app).get("/sep12/customer").query({ account: "GNEW..." });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe(Sep12CustomerStatus.NEEDS_INFO);
      expect(res.body.fields).toBeDefined();
      expect(res.body.fields.first_name).toBeDefined();
      expect(res.body.fields.photo_id_front.type).toBe("binary");
    });

    it("returns organization fields when type=organization", async () => {
      mockDb.query.mockResolvedValue(emptyQueryResult);

      const res = await request(app)
        .get("/sep12/customer")
        .query({ account: "GORG...", type: "organization" });

      expect(res.status).toBe(200);
      expect(res.body.fields.organization_name).toBeDefined();
      expect(res.body.fields.first_name).toBeUndefined();
    });

    it("returns ACCEPTED for FULL-level approved customer", async () => {
      mockDb.query
        .mockResolvedValueOnce(rowQueryResult([{
          id: "user-123",
          kyc_level: KYCLevel.FULL,
          applicant_id: "appl-456",
          verification_status: KYCStatus.APPROVED,
        }]))
        .mockResolvedValueOnce(emptyQueryResult); // kyc_documents query

      mockKycService.getApplicant.mockResolvedValueOnce({
        id: "appl-456",
        first_name: "John",
        last_name: "Doe",
        email: "john@example.com",
        created_at: new Date().toISOString(),
        sandbox: false,
      });

      const res = await request(app).get("/sep12/customer").query({ account: "GACC..." });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe(Sep12CustomerStatus.ACCEPTED);
      expect(res.body.provided_fields?.first_name?.status).toBe("accepted");
    });

    it("returns PROCESSING for pending applicant", async () => {
      mockDb.query
        .mockResolvedValueOnce(rowQueryResult([{
          id: "user-123",
          kyc_level: KYCLevel.NONE,
          applicant_id: "appl-456",
          verification_status: KYCStatus.PENDING,
        }]))
        .mockResolvedValueOnce(emptyQueryResult);

      mockKycService.getApplicant.mockResolvedValueOnce({
        id: "appl-456",
        first_name: "Jane",
        last_name: "Doe",
        email: "jane@example.com",
        created_at: new Date().toISOString(),
        sandbox: false,
      });

      const res = await request(app).get("/sep12/customer").query({ account: "GACC..." });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe(Sep12CustomerStatus.PROCESSING);
    });

    it("returns REJECTED for rejected customer", async () => {
      mockDb.query
        .mockResolvedValueOnce(rowQueryResult([{
          id: "user-123",
          kyc_level: KYCLevel.NONE,
          applicant_id: "appl-456",
          verification_status: KYCStatus.REJECTED,
        }]))
        .mockResolvedValueOnce(emptyQueryResult);

      const res = await request(app).get("/sep12/customer").query({ account: "GACC..." });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe(Sep12CustomerStatus.REJECTED);
      expect(res.body.message).toContain("rejected");
    });

    it("reflects uploaded documents in provided_fields", async () => {
      mockDb.query
        .mockResolvedValueOnce(rowQueryResult([{
          id: "user-123",
          kyc_level: KYCLevel.NONE,
          applicant_id: null,
          verification_status: KYCStatus.PENDING,
        }]))
        .mockResolvedValueOnce(rowQueryResult([{ document_type: "passport", document_side: "front" }]));

      const res = await request(app).get("/sep12/customer").query({ account: "GACC..." });

      expect(res.status).toBe(200);
      expect(res.body.provided_fields?.photo_id_front).toBeDefined();
    });

    it("returns 400 when account is missing", async () => {
      const res = await request(app).get("/sep12/customer");
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("account parameter is required");
    });
  });

  // =========================================================================
  // PUT /customer
  // =========================================================================
  describe("PUT /customer", () => {
    it("creates new customer and returns PROCESSING status", async () => {
      mockDb.query
        .mockResolvedValueOnce(emptyQueryResult)          // user lookup
        .mockResolvedValueOnce(rowQueryResult([{ id: "new-user-123" }])) // INSERT user
        .mockResolvedValueOnce(emptyQueryResult);         // INSERT kyc_applicants

      mockKycService.createApplicant.mockResolvedValueOnce({
        id: "appl-789",
        first_name: "Jane",
        last_name: "Smith",
        email: "jane@example.com",
        created_at: new Date().toISOString(),
        sandbox: false,
      });

      const res = await request(app).put("/sep12/customer").send({
        account: "GNEW...",
        first_name: "Jane",
        last_name: "Smith",
        email_address: "jane@example.com",
      });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe(Sep12CustomerStatus.PROCESSING);
      expect(mockKycService.createApplicant).toHaveBeenCalled();
    });

    it("returns presigned_uploads for binary fields declared as 'upload'", async () => {
      mockDb.query
        .mockResolvedValueOnce(emptyQueryResult)          // user lookup
        .mockResolvedValueOnce(rowQueryResult([{ id: "new-user-123" }])) // INSERT user
        .mockResolvedValueOnce(emptyQueryResult)          // INSERT kyc_applicants
        .mockResolvedValueOnce(emptyQueryResult);         // INSERT kyc_documents

      mockKycService.createApplicant.mockResolvedValueOnce({
        id: "appl-789",
        first_name: "Jane",
        last_name: "Smith",
        created_at: new Date().toISOString(),
        sandbox: false,
      });

      const res = await request(app).put("/sep12/customer").send({
        account: "GNEW...",
        first_name: "Jane",
        last_name: "Smith",
        id_type: "passport",
        photo_id_front: "upload",
      });

      expect(res.status).toBe(200);
      expect(res.body.presigned_uploads?.photo_id_front).toBeDefined();
      expect(res.body.presigned_uploads?.photo_id_front.url).toBe("https://s3.amazonaws.com/presigned-url");
      expect(res.body.presigned_uploads?.photo_id_front.key).toBeDefined();
      expect(res.body.presigned_uploads?.photo_id_front.expires_in).toBe(900);
      expect(mockPresignedUploadUrl).toHaveBeenCalledWith("new-user-123", "photo_id_front");
    });

    it("returns presigned URLs for multiple binary fields", async () => {
      mockPresignedUploadUrl
        .mockResolvedValueOnce({ url: "https://s3.amazonaws.com/url1", key: "key1", expires_in: 900 })
        .mockResolvedValueOnce({ url: "https://s3.amazonaws.com/url2", key: "key2", expires_in: 900 });

      mockDb.query
        .mockResolvedValueOnce(emptyQueryResult)
        .mockResolvedValueOnce(rowQueryResult([{ id: "new-user-123" }]))
        .mockResolvedValueOnce(emptyQueryResult)
        .mockResolvedValueOnce(emptyQueryResult)
        .mockResolvedValueOnce(emptyQueryResult);

      mockKycService.createApplicant.mockResolvedValueOnce({
        id: "appl-789",
        first_name: "Jane",
        last_name: "Smith",
        created_at: new Date().toISOString(),
        sandbox: false,
      });

      const res = await request(app).put("/sep12/customer").send({
        account: "GNEW...",
        first_name: "Jane",
        last_name: "Smith",
        photo_id_front: "upload",
        photo_id_back: "upload",
      });

      expect(res.status).toBe(200);
      expect(mockPresignedUploadUrl).toHaveBeenCalledTimes(2);
      expect(res.body.presigned_uploads?.photo_id_front.url).toBe("https://s3.amazonaws.com/url1");
      expect(res.body.presigned_uploads?.photo_id_back.url).toBe("https://s3.amazonaws.com/url2");
    });

    it("does not return presigned_uploads when no binary fields are declared", async () => {
      mockDb.query
        .mockResolvedValueOnce(emptyQueryResult)
        .mockResolvedValueOnce(rowQueryResult([{ id: "new-user-123" }]))
        .mockResolvedValueOnce(emptyQueryResult);

      mockKycService.createApplicant.mockResolvedValueOnce({
        id: "appl-789",
        first_name: "Jane",
        last_name: "Smith",
        created_at: new Date().toISOString(),
        sandbox: false,
      });

      const res = await request(app).put("/sep12/customer").send({
        account: "GNEW...",
        first_name: "Jane",
        last_name: "Smith",
      });

      expect(res.status).toBe(200);
      expect(res.body.presigned_uploads).toBeUndefined();
    });

    it("updates existing customer without creating a new applicant", async () => {
      mockDb.query
        .mockResolvedValueOnce(rowQueryResult([{ id: "user-123", applicant_id: "appl-456" }]))
        .mockResolvedValueOnce(emptyQueryResult); // updateSensitiveData

      const res = await request(app).put("/sep12/customer").send({
        account: "GACC...",
        mobile_number: "+1234567890",
      });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe(Sep12CustomerStatus.PROCESSING);
      expect(mockKycService.createApplicant).not.toHaveBeenCalled();
    });

    it("returns 400 for invalid email", async () => {
      const res = await request(app).put("/sep12/customer").send({
        account: "GACC...",
        email_address: "not-an-email",
      });
      expect(res.status).toBe(400);
    });

    it("returns 400 when account is missing", async () => {
      const res = await request(app).put("/sep12/customer").send({ first_name: "Jane" });
      expect(res.status).toBe(400);
    });
  });

  // =========================================================================
  // DELETE /customer/:account
  // =========================================================================
  describe("DELETE /customer/:account", () => {
    it("purges user across all tables and returns 204", async () => {
      mockDb.query
        .mockResolvedValueOnce(rowQueryResult([{ id: "user-123" }])) // user lookup
        .mockResolvedValueOnce(emptyQueryResult)  // DELETE kyc_documents
        .mockResolvedValueOnce(emptyQueryResult)  // DELETE kyc_applicants
        .mockResolvedValueOnce(emptyQueryResult)  // UPDATE transactions
        .mockResolvedValueOnce(emptyQueryResult); // UPDATE users (nullify PII)

      const res = await request(app).delete("/sep12/customer/GACC123...");

      expect(res.status).toBe(204);
      // Verify cascading deletes were issued
      const calls = (mockDb.query as jest.Mock).mock.calls.map((c) => c[0] as string);
      expect(calls.some((q) => q.includes("DELETE FROM kyc_documents"))).toBe(true);
      expect(calls.some((q) => q.includes("DELETE FROM kyc_applicants"))).toBe(true);
      expect(calls.some((q) => q.includes("UPDATE transactions"))).toBe(true);
      expect(calls.some((q) => q.includes("UPDATE users"))).toBe(true);
    });

    it("returns 204 when account does not exist (idempotent)", async () => {
      mockDb.query.mockResolvedValueOnce(emptyQueryResult); // user not found

      const res = await request(app).delete("/sep12/customer/GUNKNOWN...");
      expect(res.status).toBe(204);
    });
  });
});
