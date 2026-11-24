/**
 * #647 – Clawback destination account validation
 *
 * The Horizon server is mocked so the destination checks (account still exists,
 * trustline still present) can be exercised without a live Stellar network.
 */
import * as StellarSdk from "stellar-sdk";
import {
  StellarService,
  ClawbackDestinationError,
} from "../stellarService";

const ISSUER =
  "GDFRUYRH6AZC64IAEO5RTYYGYSUCJ65QGZICQEVNNYE2Y25X2NW7NFXP";
const OTHER_ISSUER =
  "GBRZ53APR7OHX3GBB4QOY3AJ75CJT3FQVHSCZ2U6VM4LZPMIOREP6BNF";
const DESTINATION =
  "GB3AYMEUIWCI4STX3SI4ZZE2ENJUJIQSIBXIZ66GPT4JNAYN6DYYKXS5";
const ASSET = new StellarSdk.Asset("USDC", ISSUER);

const loadAccount = jest.fn();
const submitTransaction = jest.fn();

// The shared metrics registry is not exercised here, and loading it alongside
// the rest of the Stellar dependency graph trips a duplicate-registration
// error that is unrelated to clawback validation.
jest.mock("../../../utils/metrics", () => ({
  transactionTotal: { inc: jest.fn() },
  transactionErrorsTotal: { inc: jest.fn() },
}));

jest.mock("../../../config/stellar", () => ({
  getStellarServer: () => ({
    loadAccount: (...args: unknown[]) => loadAccount(...args),
    submitTransaction: (...args: unknown[]) => submitTransaction(...args),
  }),
  getNetworkPassphrase: () => "Test SDF Network ; September 2015",
}));

jest.mock("../../../stellar/muxed", () => ({
  resolveToBaseAddress: (address: string) => address,
  isMuxedAddress: () => false,
}));

jest.mock("../../sanctionService", () => ({
  sanctionService: {
    checkParties: jest.fn(),
    checkPartiesByAddress: jest.fn(),
  },
  SanctionScreeningError: class SanctionScreeningError extends Error {},
}));

function accountWithBalances(balances: unknown[]) {
  return { account_id: DESTINATION, balances, sequence: "1" } as any;
}

function horizon404() {
  const err: any = new Error("Request failed with status code 404");
  err.status = 404;
  err.response = { status: 404 };
  return err;
}

function service(): StellarService {
  process.env.STELLAR_ASSET_CODE = "USDC";
  process.env.STELLAR_ASSET_ISSUER = ISSUER;
  process.env.STELLAR_ISSUER_SECRET =
    "SDUHELR2QJTQH24GZKNCT5NBWJ2FCGMPRGKED5Y4REUZK4XCM73JMM4V";
  return new StellarService();
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("StellarService.validateClawbackDestination", () => {
  it("returns the trustline balance when the account and trustline exist", async () => {
    loadAccount.mockResolvedValue(
      accountWithBalances([
        { asset_type: "native", balance: "10.0000000" },
        {
          asset_type: "credit_alphanum4",
          asset_code: "USDC",
          asset_issuer: ISSUER,
          balance: "250.5000000",
        },
      ]),
    );

    const result = await service().validateClawbackDestination(
      DESTINATION,
      ASSET,
    );

    expect(result).toEqual({
      accountId: DESTINATION,
      assetCode: "USDC",
      balance: "250.5000000",
    });
    expect(loadAccount).toHaveBeenCalledWith(DESTINATION);
  });

  it("throws ACCOUNT_NOT_FOUND when the account no longer exists", async () => {
    loadAccount.mockRejectedValue(horizon404());

    const promise = service().validateClawbackDestination(DESTINATION, ASSET);

    await expect(promise).rejects.toThrow(ClawbackDestinationError);
    await expect(promise).rejects.toMatchObject({
      failure: "ACCOUNT_NOT_FOUND",
    });
  });

  it("throws TRUSTLINE_NOT_FOUND when the trustline was removed", async () => {
    loadAccount.mockResolvedValue(
      accountWithBalances([{ asset_type: "native", balance: "10.0000000" }]),
    );

    await expect(
      service().validateClawbackDestination(DESTINATION, ASSET),
    ).rejects.toMatchObject({ failure: "TRUSTLINE_NOT_FOUND" });
  });

  it("does not accept a trustline issued by a different issuer", async () => {
    loadAccount.mockResolvedValue(
      accountWithBalances([
        {
          asset_type: "credit_alphanum4",
          asset_code: "USDC",
          asset_issuer: OTHER_ISSUER,
          balance: "5.0000000",
        },
      ]),
    );

    await expect(
      service().validateClawbackDestination(DESTINATION, ASSET),
    ).rejects.toMatchObject({ failure: "TRUSTLINE_NOT_FOUND" });
  });

  it("rethrows non-404 Horizon errors unchanged", async () => {
    const boom: any = new Error("connection refused");
    boom.status = 500;
    loadAccount.mockRejectedValue(boom);

    await expect(
      service().validateClawbackDestination(DESTINATION, ASSET),
    ).rejects.toThrow("connection refused");
  });

  it("reads the native balance when the asset is native", async () => {
    loadAccount.mockResolvedValue(
      accountWithBalances([{ asset_type: "native", balance: "3.1400000" }]),
    );

    const result = await service().validateClawbackDestination(
      DESTINATION,
      StellarSdk.Asset.native(),
    );

    expect(result).toEqual({
      accountId: DESTINATION,
      assetCode: "XLM",
      balance: "3.1400000",
    });
  });
});

describe("StellarService.executeClawback – destination validation gate", () => {
  it("rejects a clawback to a deleted account and never submits", async () => {
    loadAccount.mockRejectedValue(horizon404());
    submitTransaction.mockResolvedValue({ hash: "should-not-happen" });

    await expect(
      service().executeClawback(DESTINATION, "100"),
    ).rejects.toMatchObject({ failure: "ACCOUNT_NOT_FOUND" });

    expect(submitTransaction).not.toHaveBeenCalled();
  });

  it("rejects a clawback when the destination trustline was removed", async () => {
    loadAccount.mockResolvedValue(
      accountWithBalances([{ asset_type: "native", balance: "1.0000000" }]),
    );

    await expect(
      service().executeClawback(DESTINATION, "100"),
    ).rejects.toMatchObject({ failure: "TRUSTLINE_NOT_FOUND" });

    expect(submitTransaction).not.toHaveBeenCalled();
  });
});
