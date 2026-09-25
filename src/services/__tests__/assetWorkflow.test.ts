import { assetWorkflowService, AssetIssuanceRequestModel } from "../assetWorkflowService";
import {
  AssetConfigurationError,
  AssetCreationRateLimiter,
  AssetCreationRateLimitError,
} from "../assetWorkflowValidation";
import { queryRead, queryWrite } from "../../config/database";
import { AssetIssuanceService } from "../stellar/issuanceService";
import { Keypair } from "stellar-sdk";

jest.mock("../../config/database");
jest.mock("../stellar/issuanceService");

/**
 * Minimal stateful stand-in for the asset_issuance_requests table.
 *
 * The previous version of this file stubbed `queryRead` with one frozen row, so
 * every status assertion silently described the stub instead of the service and
 * the file could not even be collected (wrong import paths).
 */
function useStatefulDb(initial: Record<string, any>) {
  const row: Record<string, any> = { ...initial };
  (queryRead as jest.Mock).mockImplementation(async () => ({ rows: [{ ...row }] }));
  (queryWrite as jest.Mock).mockImplementation(async (sql: string, params: any[]) => {
    if (/UPDATE asset_issuance_requests SET status/.test(sql)) {
      row.status = params[0];
      if (params[1]) row.approved_by = params[1];
      if (params[2]) row.approval_notes = params[2];
    }
    if (/UPDATE asset_issuance_requests SET trustline_config/.test(sql)) {
      row.trustline_config = params[0];
    }
    return { rows: [] };
  });
  return row;
}

const baseRow = (status: string) => ({
  id: "req-1",
  asset_code: "USD",
  name: "USD Coin",
  limit: "1000000",
  status,
  requested_by: "user-1",
  approved_by: null,
  approval_notes: null,
  metadata: {},
  trustline_config: null,
  created_at: new Date(),
  updated_at: new Date(),
});

describe("AssetWorkflowService", () => {
  let model: AssetIssuanceRequestModel;

  beforeEach(() => {
    jest.clearAllMocks();
    model = new AssetIssuanceRequestModel();
  });

  describe("AssetIssuanceRequestModel", () => {
    it("should create a request", async () => {
      (queryRead as jest.Mock).mockResolvedValue({ rows: [] });
      (queryWrite as jest.Mock).mockResolvedValue({
        rows: [
          {
            id: "req-1",
            asset_code: "USD",
            name: "USD Coin",
            description: "Test",
            limit: "1000000",
            status: "draft",
            requested_by: "user-1",
            metadata: {},
            created_at: new Date(),
            updated_at: new Date(),
          },
        ],
      });

      const request = await model.create({
        assetCode: "USD",
        name: "USD Coin",
        description: "Test",
        limit: "1000000",
        requestedBy: "user-1",
      });

      expect(request.assetCode).toBe("USD");
      expect(request.status).toBe("draft");
    });

    it("should throw if asset code already exists", async () => {
      (queryRead as jest.Mock).mockResolvedValue({
        rows: [{ id: "req-existing", asset_code: "USD" }],
      });

      await expect(
        model.create({
          assetCode: "USD",
          name: "USD Coin",
          limit: "1000000",
          requestedBy: "user-1",
        }),
      ).rejects.toThrow("already exists");
    });
  });

  describe("validateConfiguration", () => {
    it("should validate correct configuration", () => {
      const result = assetWorkflowService.validateConfiguration({ assetCode: "USD", name: "USD Coin", limit: "1000000" });
      expect(result.isValid).toBe(true);
    });

    it("should reject invalid asset code", () => {
      const result = assetWorkflowService.validateConfiguration({ assetCode: "", name: "USD Coin", limit: "1000000" });
      expect(result.isValid).toBe(false);
      expect(result.errors.join(" ")).toMatch(/3-12|between 3 and 12/);
    });

    it("should reject invalid limit", () => {
      const result = assetWorkflowService.validateConfiguration({ assetCode: "USD", name: "USD Coin", limit: "-1" });
      expect(result.isValid).toBe(false);
      expect(result.errors.some((e) => e.includes("positive number"))).toBe(true);
    });
  });

  describe("submitForApproval", () => {
    it("moves a draft request to pending_approval", async () => {
      const row = useStatefulDb(baseRow("draft"));

      const request = await assetWorkflowService.submitForApproval("req-1");

      expect(row.status).toBe("pending_approval");
      expect(request.status).toBe("pending_approval");
    });

    it("should throw if request is not in draft", async () => {
      useStatefulDb(baseRow("pending_approval"));

      await expect(assetWorkflowService.submitForApproval("req-1")).rejects.toThrow("Cannot submit request");
    });
  });

  describe("approveRequest", () => {
    it("approves, issues and ends in completed", async () => {
      const row = useStatefulDb(baseRow("pending_approval"));
      (AssetIssuanceService as jest.MockedClass<typeof AssetIssuanceService>).mockImplementation(() => ({
        setupAnchoredAsset: jest.fn().mockResolvedValue({ assetCode: "USD", issuerPublicKey: "G...", distributionPublicKey: "G..." }),
      } as any));

      const request = await assetWorkflowService.approveRequest("req-1", "admin-1", "approve", "Looks good");

      expect(row.status).toBe("completed");
      expect(request.status).toBe("completed");
      expect(row.approved_by).toBe("admin-1");
      expect(row.approval_notes).toBe("Looks good");
    });

    it("marks the request failed when issuance throws", async () => {
      const row = useStatefulDb(baseRow("pending_approval"));
      jest
        .spyOn((assetWorkflowService as any).issuanceService, "setupAnchoredAsset")
        .mockRejectedValue(new Error("horizon unavailable"));

      await expect(
        assetWorkflowService.approveRequest("req-1", "admin-1", "approve"),
      ).rejects.toThrow("horizon unavailable");
      expect(row.status).toBe("failed");
    });

    it("rejects a pending request without issuing anything", async () => {
      const row = useStatefulDb(baseRow("pending_approval"));
      const issueSpy = jest.spyOn((assetWorkflowService as any).issuanceService, "setupAnchoredAsset");

      const request = await assetWorkflowService.approveRequest("req-1", "admin-1", "reject", "wrong code");

      expect(row.status).toBe("rejected");
      expect(request.status).toBe("rejected");
      expect(issueSpy).not.toHaveBeenCalled();
    });
  });

  describe("createRequest validation (issue #571)", () => {
    const issuer = Keypair.random().publicKey();
    const distribution = Keypair.random().publicKey();

    const stubInsert = (assetCode = "USD") => {
      (queryWrite as jest.Mock).mockResolvedValue({
        rows: [
          {
            id: "req-new",
            asset_code: assetCode,
            name: "USD Coin",
            description: null,
            limit: "1000000",
            status: "draft",
            requested_by: "user-1",
            metadata: {},
            created_at: new Date(),
            updated_at: new Date(),
          },
        ],
      });
    };

    beforeEach(() => {
      assetWorkflowService.setCreationRateLimiter(
        new AssetCreationRateLimiter({ maxRequests: 100, windowMs: 60_000 }),
      );
    });

    it("rejects an invalid asset code before touching the database", async () => {
      (queryRead as jest.Mock).mockResolvedValue({ rows: [] });

      await expect(
        assetWorkflowService.createRequest({
          assetCode: "US",
          name: "Too short",
          limit: "1000",
          requestedBy: "user-1",
        }),
      ).rejects.toBeInstanceOf(AssetConfigurationError);

      expect(queryWrite).not.toHaveBeenCalled();
    });

    it("rejects an invalid issuer account", async () => {
      (queryRead as jest.Mock).mockResolvedValue({ rows: [] });

      await expect(
        assetWorkflowService.createRequest({
          assetCode: "USD",
          name: "USD Coin",
          limit: "1000",
          requestedBy: "user-1",
          issuerPublicKey: "GNOTAREALKEY",
        }),
      ).rejects.toThrow(/issuer account is not a valid Stellar public key/i);
    });

    it("rejects an invalid distribution account and a self-issued trustline", async () => {
      (queryRead as jest.Mock).mockResolvedValue({ rows: [] });

      await expect(
        assetWorkflowService.createRequest({
          assetCode: "USD",
          name: "USD Coin",
          limit: "1000",
          requestedBy: "user-1",
          trustlineConfig: { destinationAccount: "nope", limit: "1000", autoSetup: false },
        }),
      ).rejects.toThrow(/distribution account is not a valid Stellar public key/i);

      await expect(
        assetWorkflowService.createRequest({
          assetCode: "USD",
          name: "USD Coin",
          limit: "1000",
          requestedBy: "user-1",
          issuerPublicKey: issuer,
          trustlineConfig: { destinationAccount: issuer, limit: "1000", autoSetup: false },
        }),
      ).rejects.toThrow(/must differ from the issuer/i);
    });

    it("rejects an exact duplicate asset code", async () => {
      (queryRead as jest.Mock).mockImplementation((sql: string) =>
        Promise.resolve(
          String(sql).includes("asset_code")
            ? { rows: [{ id: "req-existing", asset_code: "USD" }] }
            : { rows: [] },
        ),
      );

      await expect(
        assetWorkflowService.createRequest({
          assetCode: "USD",
          name: "USD Coin",
          limit: "1000",
          requestedBy: "user-1",
        }),
      ).rejects.toThrow(/already exists/);
      expect(queryWrite).not.toHaveBeenCalled();
    });

    it("rejects a case-insensitive duplicate the exact lookup misses", async () => {
      (queryRead as jest.Mock).mockImplementation((sql: string) =>
        Promise.resolve(
          String(sql).includes("WHERE asset_code")
            ? { rows: [] }
            : { rows: [{ id: "req-existing", asset_code: "USDCOIN" }] },
        ),
      );

      await expect(
        assetWorkflowService.createRequest({
          assetCode: "usdcoin",
          name: "Same asset, different casing",
          limit: "1000",
          requestedBy: "user-1",
        }),
      ).rejects.toThrow(/case-insensitive/);
    });

    it("rate limits asset creation per requester", async () => {
      assetWorkflowService.setCreationRateLimiter(
        new AssetCreationRateLimiter({ maxRequests: 1, windowMs: 60_000 }),
      );
      (queryRead as jest.Mock).mockResolvedValue({ rows: [] });
      stubInsert();

      await assetWorkflowService.createRequest({
        assetCode: "USD",
        name: "USD Coin",
        limit: "1000",
        requestedBy: "user-1",
      });

      const error = await assetWorkflowService
        .createRequest({
          assetCode: "EUR",
          name: "Euro Coin",
          limit: "1000",
          requestedBy: "user-1",
        })
        .catch((e) => e);

      expect(error).toBeInstanceOf(AssetCreationRateLimitError);
      expect((error as AssetCreationRateLimitError).retryAfterMs).toBeGreaterThan(0);

      // A different requester still gets through.
      await expect(
        assetWorkflowService.createRequest({
          assetCode: "EUR",
          name: "Euro Coin",
          limit: "1000",
          requestedBy: "user-2",
        }),
      ).resolves.toBeDefined();
    });

    it("stores the issuer account in metadata so it is not silently dropped", async () => {
      (queryRead as jest.Mock).mockResolvedValue({ rows: [] });
      stubInsert();

      await assetWorkflowService.createRequest({
        assetCode: "USD",
        name: "USD Coin",
        limit: "1000",
        requestedBy: "user-1",
        issuerPublicKey: issuer,
      });

      const insertCall = (queryWrite as jest.Mock).mock.calls[0];
      expect(insertCall[1]).toContain(JSON.stringify({ issuerPublicKey: issuer }));
    });
  });

  describe("configureTrustline validation (issue #571)", () => {
    const request = {
      id: "req-1",
      asset_code: "USD",
      name: "USD Coin",
      limit: "1000000",
      status: "approved",
      requested_by: "user-1",
      metadata: {},
      created_at: new Date(),
      updated_at: new Date(),
    };

    it("refuses a malformed destination account without writing", async () => {
      (queryRead as jest.Mock).mockResolvedValue({ rows: [request] });

      await expect(
        assetWorkflowService.configureTrustline("req-1", {
          destinationAccount: "GDESTINATION",
          limit: "1000",
          autoSetup: true,
        }),
      ).rejects.toThrow(/trustline: distribution account is not a valid Stellar public key/i);

      expect(queryWrite).not.toHaveBeenCalled();
    });

    it("accepts a valid destination account", async () => {
      (queryRead as jest.Mock).mockResolvedValue({ rows: [request] });
      (queryWrite as jest.Mock).mockResolvedValue({ rows: [] });

      await expect(
        assetWorkflowService.configureTrustline("req-1", {
          destinationAccount: Keypair.random().publicKey(),
          limit: "1000",
          autoSetup: false,
        }),
      ).resolves.toBeDefined();
    });
  });
});
