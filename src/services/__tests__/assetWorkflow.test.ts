import {
  assetWorkflowService,
  AssetIssuanceRequestModel,
  AssetWorkflowService,
  isValidStellarAccount,
  isIssuerAllowed,
  isIssuerAllowlistConfigured,
} from "../assetWorkflowService";
import { Keypair } from "stellar-sdk";
import { queryRead, queryWrite } from "../../config/database";
import { AssetIssuanceService } from "../../services/stellar/issuanceService";

jest.mock("../../config/database");
jest.mock("../stellar/issuanceService");

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
      expect(result.errors.some((e) => e.includes("1 and 12"))).toBe(true);
    });

    it("should reject invalid limit", () => {
      const result = assetWorkflowService.validateConfiguration({ assetCode: "USD", name: "USD Coin", limit: "-1" });
      expect(result.isValid).toBe(false);
      expect(result.errors.some((e) => e.includes("positive number"))).toBe(true);
    });
  });

  describe("submitForApproval", () => {
    it("should submit draft request for approval", async () => {
      (queryRead as jest.Mock).mockResolvedValue({
        rows: [
          {
            id: "req-1",
            asset_code: "USD",
            name: "USD Coin",
            limit: "1000000",
            status: "draft",
            requested_by: "user-1",
            metadata: {},
            created_at: new Date(),
            updated_at: new Date(),
          },
        ],
      });
      (queryWrite as jest.Mock).mockResolvedValue({ rows: [] });

      const request = await assetWorkflowService.submitForApproval("req-1");
      expect(request.status).toBe("pending_approval");
    });

    it("should throw if request is not in draft", async () => {
      (queryRead as jest.Mock).mockResolvedValue({
        rows: [
          {
            id: "req-1",
            asset_code: "USD",
            name: "USD Coin",
            limit: "1000000",
            status: "pending_approval",
            requested_by: "user-1",
            metadata: {},
            created_at: new Date(),
            updated_at: new Date(),
          },
        ],
      });

      await expect(assetWorkflowService.submitForApproval("req-1")).rejects.toThrow("Cannot submit request");
    });
  });

  describe("approveRequest", () => {
    it("should approve a pending request", async () => {
      (queryRead as jest.Mock).mockResolvedValue({
        rows: [
          {
            id: "req-1",
            asset_code: "USD",
            name: "USD Coin",
            limit: "1000000",
            status: "pending_approval",
            requested_by: "user-1",
            metadata: {},
            created_at: new Date(),
            updated_at: new Date(),
          },
        ],
      });
      (queryWrite as jest.Mock).mockResolvedValue({ rows: [] });
      (AssetIssuanceService as jest.MockedClass<typeof AssetIssuanceService>).mockImplementation(() => ({
        setupAnchoredAsset: jest.fn().mockResolvedValue({ assetCode: "USD", issuerPublicKey: "G...", distributionPublicKey: "G..." }),
      } as any));

      const request = await assetWorkflowService.approveRequest("req-1", "admin-1", "approve", "Looks good");
      expect(request.status).toBe("approved");
    });
  });
});

/**
 * Asset issuance validation and duplicate detection (#571)
 *
 * Not executed in this change and not wired into CI. Included as executable
 * specification.
 */
describe("Asset issuance validation (#571)", () => {
  // Generated rather than hardcoded: a literal public key in a test is either a
  // real one that will be rotated into a comment someday, or a plausible-looking
  // 56-character string whose checksum is wrong. The second kind is worse than
  // no key at all here, because these tests are specifically about whether a
  // malformed key is rejected, and a fake "valid" key would make them vacuous.
  const VALID_ISSUER = Keypair.random().publicKey();
  const VALID_DISTRIBUTION = Keypair.random().publicKey();
  const OTHER_ISSUER = Keypair.random().publicKey();

  const base = { assetCode: "USDC", name: "USD Coin", limit: "1000000" };

  let service: AssetWorkflowService;
  let savedWhitelist: string | undefined;
  let savedIssuerSecret: string | undefined;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new AssetWorkflowService();
    savedWhitelist = process.env.ASSET_ISSUER_WHITELIST;
    savedIssuerSecret = process.env.STELLAR_ISSUER_SECRET;
    delete process.env.ASSET_ISSUER_WHITELIST;
    delete process.env.STELLAR_ISSUER_SECRET;
  });

  afterEach(() => {
    if (savedWhitelist === undefined) delete process.env.ASSET_ISSUER_WHITELIST;
    else process.env.ASSET_ISSUER_WHITELIST = savedWhitelist;
    if (savedIssuerSecret === undefined) delete process.env.STELLAR_ISSUER_SECRET;
    else process.env.STELLAR_ISSUER_SECRET = savedIssuerSecret;
  });

  describe("asset code", () => {
    it("accepts a 3 character code", () => {
      expect(service.validateConfiguration({ ...base, assetCode: "XLM" }).isValid).toBe(true);
    });

    it("rejects a 2 character code", () => {
      // The floor is ours, not Stellar's: 1-2 character codes are typos far more
      // often than they are assets.
      const result = service.validateConfiguration({ ...base, assetCode: "AB" });
      expect(result.isValid).toBe(false);
      expect(result.errors).toContain("Asset code must be between 3 and 12 characters");
    });

    it("rejects a 13 character code, the Stellar maximum plus one", () => {
      const result = service.validateConfiguration({ ...base, assetCode: "A".repeat(13) });
      expect(result.isValid).toBe(false);
    });

    it("accepts exactly 12 characters", () => {
      expect(service.validateConfiguration({ ...base, assetCode: "A".repeat(12) }).isValid).toBe(true);
    });

    it("rejects a colon, which would let one asset code parse as two", () => {
      const result = service.validateConfiguration({ ...base, assetCode: "USD:ISSUER" });
      expect(result.isValid).toBe(false);
      expect(result.errors).toContain("Asset code must be alphanumeric");
    });

    it("rejects an empty code without throwing", () => {
      expect(service.validateConfiguration({ ...base, assetCode: "" }).isValid).toBe(false);
    });
  });

  describe("Stellar account validation", () => {
    it("accepts a real public key as issuer", () => {
      expect(isValidStellarAccount(VALID_ISSUER)).toBe(true);
    });

    it("rejects a secret key, which must never be accepted as an issuer", () => {
      // The most damaging plausible mistake: a well-formed key of the wrong
      // type. Handing a secret to an "issuer" field leaks it.
      const secret = Keypair.random().secret();
      expect(isValidStellarAccount(secret)).toBe(false);
    });

    it("rejects strings that are not keys at all", () => {
      for (const bad of ["", "   ", "not-a-key", "G", "GABC", "GB7IAH7O45YTUK5RYMREWBIEYV2W47H2EL7N4AU4J5Q5QK4T2QK5JH"]) {
        expect(isValidStellarAccount(bad)).toBe(false);
      }
    });

    it("tolerates surrounding whitespace", () => {
      expect(isValidStellarAccount(`  ${VALID_ISSUER}  `)).toBe(true);
    });

    it("reports a malformed issuer as an error", () => {
      const result = service.validateConfiguration({ ...base, issuer: "not-a-key" });
      expect(result.errors).toContain("Issuer must be a valid Stellar account (G... public key)");
    });

    it("reports a malformed distribution account as an error", () => {
      const result = service.validateConfiguration({ ...base, distributionAccount: "not-a-key" });
      expect(result.errors).toContain(
        "Distribution account must be a valid Stellar account (G... public key)",
      );
    });

    it("skips the issuer check when no issuer is supplied", () => {
      // Optional by design, so existing callers of this method keep working.
      expect(service.validateConfiguration(base).isValid).toBe(true);
    });
  });

  describe("issuer allowlist", () => {
    it("is not configured when the variable is unset", () => {
      expect(isIssuerAllowlistConfigured()).toBe(false);
    });

    it("allows any valid issuer when unconfigured, so existing deployments are not broken", () => {
      expect(isIssuerAllowed(OTHER_ISSUER)).toBe(true);
    });

    it("rejects an issuer missing from a configured allowlist", () => {
      process.env.ASSET_ISSUER_WHITELIST = `${VALID_ISSUER},${VALID_DISTRIBUTION}`;

      expect(isIssuerAllowlistConfigured()).toBe(true);
      expect(isIssuerAllowed(VALID_ISSUER)).toBe(true);
      expect(isIssuerAllowed(OTHER_ISSUER)).toBe(false);
    });

    it("reports an unlisted issuer as an error, not a warning", () => {
      process.env.ASSET_ISSUER_WHITELIST = VALID_ISSUER;

      const result = service.validateConfiguration({ ...base, issuer: OTHER_ISSUER });
      expect(result.errors).toContain("Issuer is not on the configured issuer allowlist");
      expect(result.warnings).not.toContain("Issuer is not on the configured issuer allowlist");
    });

    it("ignores a malformed allowlist entry rather than failing every request", () => {
      process.env.ASSET_ISSUER_WHITELIST = `not-a-key, ${VALID_ISSUER}`;

      expect(isIssuerAllowed(VALID_ISSUER)).toBe(true);
      expect(isIssuerAllowed(OTHER_ISSUER)).toBe(false);
    });

    it("always allows the platform's own issuer, so an operator needs no configuration", () => {
      const platform = Keypair.random();
      process.env.ASSET_ISSUER_WHITELIST = OTHER_ISSUER;
      process.env.STELLAR_ISSUER_SECRET = platform.secret();

      expect(isIssuerAllowed(platform.publicKey())).toBe(true);
      expect(isIssuerAllowed(VALID_ISSUER)).toBe(false);
    });
  });

  describe("duplicate asset codes", () => {
    const row = {
      id: "req-1",
      asset_code: "USDC",
      name: "USD Coin",
      limit: "1000000",
      status: "draft",
      requested_by: "user-1",
      metadata: {},
      created_at: new Date(),
      updated_at: new Date(),
    };

    it("rejects a duplicate found by the pre-check", async () => {
      const model = new AssetIssuanceRequestModel();
      (queryRead as jest.Mock).mockResolvedValue({ rows: [row] });

      await expect(
        model.create({ assetCode: "USDC", name: "USD Coin", limit: "1000000", requestedBy: "user-1" }),
      ).rejects.toThrow("Asset code USDC already exists");

      // The point of the pre-check is to avoid the INSERT entirely.
      expect(queryWrite).not.toHaveBeenCalled();
    });

    it("rejects a duplicate that races past the pre-check, via the unique index", async () => {
      // Two requests arrive together: both SELECT and both see nothing, then
      // both INSERT. Only the database can arbitrate, so only the database is
      // allowed to decide.
      const model = new AssetIssuanceRequestModel();
      (queryRead as jest.Mock).mockResolvedValue({ rows: [] });
      (queryWrite as jest.Mock).mockRejectedValue(
        Object.assign(new Error("duplicate key value violates unique constraint"), { code: "23505" }),
      );

      await expect(
        model.create({ assetCode: "USDC", name: "USD Coin", limit: "1000000", requestedBy: "user-1" }),
      ).rejects.toThrow("Asset code USDC already exists");
    });

    it("lets an unrelated database error through unchanged", async () => {
      // Swallowing every insert error as 'already exists' would hide real faults
      // behind a message that invites the caller to change the asset code.
      const model = new AssetIssuanceRequestModel();
      (queryRead as jest.Mock).mockResolvedValue({ rows: [] });
      const real = new Error("connection terminated unexpectedly");
      (queryWrite as jest.Mock).mockRejectedValue(real);

      await expect(
        model.create({ assetCode: "USDC", name: "USD Coin", limit: "1000000", requestedBy: "user-1" }),
      ).rejects.toThrow("connection terminated unexpectedly");
    });
  });

  describe("createRequest", () => {
    it("persists the issuer in metadata", async () => {
      (queryRead as jest.Mock).mockResolvedValue({ rows: [] });
      (queryWrite as jest.Mock).mockResolvedValue({
        rows: [
          {
            id: "req-1",
            asset_code: "USDC",
            name: "USD Coin",
            limit: "1000000",
            status: "draft",
            requested_by: "user-1",
            metadata: { issuer: VALID_ISSUER },
            created_at: new Date(),
            updated_at: new Date(),
          },
        ],
      });

      await service.createRequest({
        assetCode: "USDC",
        name: "USD Coin",
        limit: "1000000",
        requestedBy: "user-1",
        issuer: VALID_ISSUER,
      });

      const params = (queryWrite as jest.Mock).mock.calls[0][1];
      expect(JSON.parse(params[7])).toEqual({ issuer: VALID_ISSUER });
    });

    it("refuses a non-whitelisted issuer before writing anything", async () => {
      process.env.ASSET_ISSUER_WHITELIST = OTHER_ISSUER;

      await expect(
        service.createRequest({
          assetCode: "USDC",
          name: "USD Coin",
          limit: "1000000",
          requestedBy: "user-1",
          issuer: VALID_ISSUER,
        }),
      ).rejects.toThrow(/not on the configured issuer allowlist/);

      expect(queryWrite).not.toHaveBeenCalled();
    });
  });

  describe("configureTrustline", () => {
    it("rejects a malformed destination account without touching the ledger", async () => {
      (queryRead as jest.Mock).mockResolvedValue({
        rows: [
          {
            id: "req-1",
            asset_code: "USDC",
            name: "USD Coin",
            limit: "1000000",
            status: "approved",
            requested_by: "user-1",
            metadata: {},
            created_at: new Date(),
            updated_at: new Date(),
          },
        ],
      });

      await expect(
        service.configureTrustline("req-1", {
          destinationAccount: "not-a-key",
          limit: "1000",
          autoSetup: true,
        }),
      ).rejects.toThrow(/valid Stellar account/);

      expect(queryWrite).not.toHaveBeenCalled();
    });
  });
});
