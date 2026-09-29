/**
 * #649 – GDPR export applies data classification before anything is written
 * into the archive.
 *
 * `archiver` is replaced with a capturing stub so the test can assert on the
 * exact bytes that would be streamed to the client (and to the S3 retention
 * bucket) without needing a ZIP reader.
 */
import { PassThrough } from "node:stream";

const appended: Array<{ name: string; content: string }> = [];

jest.mock("archiver", () => ({
  __esModule: true,
  default: jest.fn(() => {
    const passthrough = new PassThrough();
    // Swallow the data so the stream reaches "end" and the promise resolves.
    passthrough.resume();
    return Object.assign(passthrough, {
      append: (buffer: Buffer, opts: { name: string }) => {
        appended.push({ name: opts.name, content: buffer.toString("utf8") });
        return passthrough;
      },
      finalize: () => {
        passthrough.end();
        return passthrough;
      },
    });
  }),
}));

jest.mock("../userService", () => ({
  getUserById: jest.fn(),
  deactivateUserAccount: jest.fn(),
  updateUserById: jest.fn(),
}));

jest.mock("../auditlogService", () => ({
  auditService: { fetchAuditLogs: jest.fn(async () => []) },
}));

jest.mock("../../config/s3", () => ({
  getS3Client: jest.fn(),
  s3Config: { bucket: "test-bucket" },
}));

jest.mock("../transactionService", () => ({
  TransactionService: jest.fn().mockImplementation(() => ({
    findByUserId: jest.fn(async () => [
      {
        id: "tx-1",
        referenceNumber: "PR-1",
        amount: "5000.00",
        phoneNumber: "+237677123456",
        stellarAddress:
          "GDFRUYRH6AZC64IAEO5RTYYGYSUCJ65QGZICQEVNNYE2Y25X2NW7NFXP",
        status: "completed",
        idempotencyKey: "idem-secret",
      },
    ]),
  })),
}));

jest.mock("../../config/database", () => ({
  pool: { query: jest.fn(), connect: jest.fn() },
}));

import { GDPRService } from "../gdprService";
import { getUserById } from "../userService";
import { pool } from "../../config/database";
import { REDACTED } from "../../utils/dataClassification";

const mockedGetUserById = getUserById as jest.Mock;
const mockedQuery = pool.query as unknown as jest.Mock;

function entry(name: string) {
  const found = appended.find((f) => f.name === name);
  if (!found) throw new Error(`missing archive entry: ${name}`);
  return JSON.parse(found.content);
}

beforeEach(() => {
  appended.length = 0;
  jest.clearAllMocks();
  mockedGetUserById.mockResolvedValue({
    id: "user-1",
    phone_number: "+237677123456",
    kyc_level: "tier2",
    two_factor_secret: "JBSWY3DPEHPK3PXP",
    backup_codes: ["code-a", "code-b"],
    created_at: "2026-01-01T00:00:00.000Z",
  });
  mockedQuery.mockResolvedValue({ rows: [], rowCount: 0 });
});

describe("GDPRService.exportUserData – field masking", () => {
  it("masks PII and transaction amounts by default", async () => {
    await new GDPRService().exportUserData("user-1");

    const profile = entry("profile.json");
    const txs = entry("transactions.json");

    expect(profile.phone_number).not.toBe("+237677123456");
    expect(txs[0].amount).toBe(REDACTED);
    expect(txs[0].phoneNumber).not.toBe("+237677123456");
    expect(txs[0].stellarAddress).not.toBe(
      "GDFRUYRH6AZC64IAEO5RTYYGYSUCJ65QGZICQEVNNYE2Y25X2NW7NFXP",
    );
  });

  it("keeps non-sensitive fields intact so the export stays useful", async () => {
    await new GDPRService().exportUserData("user-1");

    const profile = entry("profile.json");
    const txs = entry("transactions.json");

    expect(profile.id).toBe("user-1");
    expect(profile.kyc_level).toBe("tier2");
    expect(txs[0].id).toBe("tx-1");
    expect(txs[0].status).toBe("completed");
  });

  it("includes confidential and internal data when explicitly requested", async () => {
    await new GDPRService().exportUserData("user-1", {
      includeConfidential: true,
      includeInternal: true,
    });

    const profile = entry("profile.json");
    const txs = entry("transactions.json");

    expect(profile.phone_number).toBe("+237677123456");
    expect(txs[0].amount).toBe("5000.00");
  });

  it("never exports 2FA secrets or backup codes, even fully opted in", async () => {
    await new GDPRService().exportUserData("user-1", {
      includeConfidential: true,
      includeInternal: true,
    });

    const profile = entry("profile.json");

    expect(profile.two_factor_secret).toBe(REDACTED);
    expect(profile.backup_codes).toEqual([REDACTED, REDACTED]);
  });

  it("ships a data classification manifest listing what was withheld", async () => {
    await new GDPRService().exportUserData("user-1");

    const manifest = entry("data_classification.json");

    expect(manifest.masking.includeConfidential).toBe(false);
    expect(manifest.masking.includeInternal).toBe(false);
    expect(manifest.masking.includeRestricted).toBe(false);
    expect(manifest.maskedFieldCount).toBeGreaterThan(0);

    const paths = manifest.maskedFields.map((f: any) => f.path);
    expect(paths).toContain("profile.phone_number");
    expect(paths).toContain("profile.two_factor_secret");
    expect(paths).toContain("transactions[0].amount");
  });

  it("records the opt-in flags in the manifest", async () => {
    await new GDPRService().exportUserData("user-1", {
      includeConfidential: true,
    });

    const manifest = entry("data_classification.json");
    expect(manifest.masking.includeConfidential).toBe(true);
    expect(manifest.masking.includeInternal).toBe(false);
    // Restricted fields are still reported as masked.
    expect(
      manifest.maskedFields.some(
        (f: any) => f.path === "profile.two_factor_secret",
      ),
    ).toBe(true);
  });

  it("includes every section in the archive", async () => {
    await new GDPRService().exportUserData("user-1");

    expect(appended.map((f) => f.name).sort()).toEqual([
      "audit_logs.json",
      "data_classification.json",
      "disputes.json",
      "kyc.json",
      "profile.json",
      "transactions.json",
      "webhooks.json",
    ]);
  });
});
