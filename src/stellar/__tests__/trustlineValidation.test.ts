import * as StellarSdk from "stellar-sdk";
import {
  validateRecipientTrustline,
  MissingTrustlineError,
} from "../trustlineValidation";

// ── Mocks ─────────────────────────────────────────────────────────────────────

jest.mock("../../config/stellar", () => ({
  getStellarServer: jest.fn(),
  getNetworkPassphrase: jest.fn().mockReturnValue("Test SDF Network ; September 2015"),
}));

jest.mock("../../services/layeredCache", () => ({
  layeredCache: {
    get: jest.fn(),
    set: jest.fn(),
  },
}));

jest.mock("../muxed", () => ({
  resolveToBaseAddress: jest.fn((addr: string) => addr),
}));

import { getStellarServer } from "../../config/stellar";
import { layeredCache } from "../../services/layeredCache";

const mockGetStellarServer = getStellarServer as jest.Mock;
const mockCacheGet = layeredCache.get as jest.Mock;
const mockCacheSet = layeredCache.set as jest.Mock;

const mockLoadAccount = jest.fn();
const mockSubmitTransaction = jest.fn();

const mockServer = {
  loadAccount: mockLoadAccount,
  submitTransaction: mockSubmitTransaction,
};

// ── Fixtures ──────────────────────────────────────────────────────────────────

const ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const USDC = new StellarSdk.Asset("USDC", ISSUER);
const XLM  = StellarSdk.Asset.native();

const recipientKeypair = StellarSdk.Keypair.random();
const recipientAddress = recipientKeypair.publicKey();

function makeAccount(trustedAssets: StellarSdk.Asset[] = []) {
  return {
    id: recipientAddress,
    account_id: recipientAddress,
    sequence: "100",
    // TransactionBuilder.build() requires these three Account methods
    sequenceNumber: () => "100",
    accountId: () => recipientAddress,
    incrementSequenceNumber: jest.fn(),
    balances: [
      { asset_type: "native", balance: "10.0000000" },
      ...trustedAssets.map((a) => ({
        asset_type: a.getCode().length <= 4 ? "credit_alphanum4" : "credit_alphanum12",
        asset_code: a.getCode(),
        asset_issuer: a.getIssuer(),
        balance: "0.0000000",
        limit: "922337203685.4775807",
      })),
    ],
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetStellarServer.mockReturnValue(mockServer);
  mockCacheGet.mockResolvedValue(null);   // cache miss by default
  mockCacheSet.mockResolvedValue(undefined);
  mockSubmitTransaction.mockResolvedValue({ hash: "abc", ledger: 1 });
});

// ── Native XLM (no trustline required) ───────────────────────────────────────

describe("validateRecipientTrustline – native XLM", () => {
  it("resolves immediately without querying Horizon or the cache", async () => {
    await expect(validateRecipientTrustline(recipientAddress, XLM)).resolves.toBeUndefined();
    expect(mockCacheGet).not.toHaveBeenCalled();
    expect(mockLoadAccount).not.toHaveBeenCalled();
  });
});

// ── Cache hit: trustline present ──────────────────────────────────────────────

describe("validateRecipientTrustline – cache hit (trusted)", () => {
  it("returns without calling Horizon when the cache says the trustline exists", async () => {
    mockCacheGet.mockResolvedValue(true);

    await expect(validateRecipientTrustline(recipientAddress, USDC)).resolves.toBeUndefined();

    expect(mockLoadAccount).not.toHaveBeenCalled();
    expect(mockCacheSet).not.toHaveBeenCalled();
  });
});

// ── Cache hit: trustline missing ──────────────────────────────────────────────

describe("validateRecipientTrustline – cache hit (missing)", () => {
  it("throws MissingTrustlineError with XDR when cache says trustline is absent", async () => {
    mockCacheGet.mockResolvedValue(false);
    // loadAccount is called to build the fresh XDR
    mockLoadAccount.mockResolvedValue(makeAccount());

    await expect(
      validateRecipientTrustline(recipientAddress, USDC),
    ).rejects.toThrow(MissingTrustlineError);

    expect(mockLoadAccount).toHaveBeenCalledTimes(1);
    expect(mockCacheSet).not.toHaveBeenCalled(); // no re-caching on hit path
  });

  it("includes assetCode, assetIssuer, and changeTrustXdr in the error", async () => {
    mockCacheGet.mockResolvedValue(false);
    mockLoadAccount.mockResolvedValue(makeAccount());

    let error: MissingTrustlineError | undefined;
    try {
      await validateRecipientTrustline(recipientAddress, USDC);
    } catch (err) {
      error = err as MissingTrustlineError;
    }

    expect(error).toBeInstanceOf(MissingTrustlineError);
    expect(error!.assetCode).toBe("USDC");
    expect(error!.assetIssuer).toBe(ISSUER);
    expect(error!.changeTrustXdr).toBeTruthy();
    expect(typeof error!.changeTrustXdr).toBe("string");
  });
});

// ── Cache miss: trustline present ────────────────────────────────────────────

describe("validateRecipientTrustline – cache miss (trusted)", () => {
  it("queries Horizon, caches true, and resolves when the trustline exists", async () => {
    mockCacheGet.mockResolvedValue(null);
    mockLoadAccount.mockResolvedValue(makeAccount([USDC]));

    await expect(validateRecipientTrustline(recipientAddress, USDC)).resolves.toBeUndefined();

    expect(mockLoadAccount).toHaveBeenCalledTimes(1);
    expect(mockCacheSet).toHaveBeenCalledWith(
      expect.stringContaining("trustline:validation:"),
      true,
      60,
    );
  });
});

// ── Cache miss: trustline missing ─────────────────────────────────────────────

describe("validateRecipientTrustline – cache miss (missing)", () => {
  it("queries Horizon, caches false, and throws MissingTrustlineError", async () => {
    mockCacheGet.mockResolvedValue(null);
    mockLoadAccount.mockResolvedValue(makeAccount()); // no USDC trustline

    await expect(
      validateRecipientTrustline(recipientAddress, USDC),
    ).rejects.toThrow(MissingTrustlineError);

    expect(mockCacheSet).toHaveBeenCalledWith(
      expect.stringContaining("trustline:validation:"),
      false,
      60,
    );
  });

  it("error code is ERR_MISSING_TRUSTLINE", async () => {
    mockCacheGet.mockResolvedValue(null);
    mockLoadAccount.mockResolvedValue(makeAccount());

    let error: MissingTrustlineError | undefined;
    try {
      await validateRecipientTrustline(recipientAddress, USDC);
    } catch (err) {
      error = err as MissingTrustlineError;
    }

    expect(error!.code).toBe("ERR_MISSING_TRUSTLINE");
  });

  it("error carries meta with changeTrustXdr, assetCode and assetIssuer", async () => {
    mockCacheGet.mockResolvedValue(null);
    mockLoadAccount.mockResolvedValue(makeAccount());

    let error: MissingTrustlineError | undefined;
    try {
      await validateRecipientTrustline(recipientAddress, USDC);
    } catch (err) {
      error = err as MissingTrustlineError;
    }

    expect(error!.meta).toMatchObject({
      assetCode: "USDC",
      assetIssuer: ISSUER,
      changeTrustXdr: expect.any(String),
    });
  });

  it("XDR decodes to a ChangeTrust operation for the correct asset", async () => {
    mockCacheGet.mockResolvedValue(null);
    mockLoadAccount.mockResolvedValue(makeAccount());

    let error: MissingTrustlineError | undefined;
    try {
      await validateRecipientTrustline(recipientAddress, USDC);
    } catch (err) {
      error = err as MissingTrustlineError;
    }

    const envelope = StellarSdk.TransactionBuilder.fromXDR(
      error!.changeTrustXdr,
      "Test SDF Network ; September 2015",
    );
    const tx = envelope as StellarSdk.Transaction;
    expect(tx.operations).toHaveLength(1);
    expect(tx.operations[0].type).toBe("changeTrust");
    const op = tx.operations[0] as StellarSdk.Operation.ChangeTrust;
    expect((op.line as StellarSdk.Asset).getCode()).toBe("USDC");
    expect((op.line as StellarSdk.Asset).getIssuer()).toBe(ISSUER);
  });

  it("does not call Horizon again to build the XDR when loadAccount succeeded", async () => {
    mockCacheGet.mockResolvedValue(null);
    mockLoadAccount.mockResolvedValue(makeAccount());

    await expect(
      validateRecipientTrustline(recipientAddress, USDC),
    ).rejects.toThrow(MissingTrustlineError);

    // loadAccount called exactly once (for the trustline check + XDR reuse)
    expect(mockLoadAccount).toHaveBeenCalledTimes(1);
  });
});

// ── Account not found on Stellar ──────────────────────────────────────────────

describe("validateRecipientTrustline – account does not exist (404)", () => {
  it("treats 404 as missing trustline, caches false, and throws MissingTrustlineError", async () => {
    mockCacheGet.mockResolvedValue(null);
    // First loadAccount (trustline check) → 404
    // Second loadAccount (XDR build) → 404 → falls back to dummy sequence
    mockLoadAccount
      .mockRejectedValueOnce({ response: { status: 404 } }) // check
      .mockRejectedValueOnce({ response: { status: 404 } }); // XDR build

    await expect(
      validateRecipientTrustline(recipientAddress, USDC),
    ).rejects.toThrow(MissingTrustlineError);

    expect(mockCacheSet).toHaveBeenCalledWith(
      expect.stringContaining("trustline:validation:"),
      false,
      60,
    );
  });

  it("still provides a changeTrustXdr template when the account does not exist", async () => {
    mockCacheGet.mockResolvedValue(null);
    mockLoadAccount.mockRejectedValue({ response: { status: 404 } });

    let error: MissingTrustlineError | undefined;
    try {
      await validateRecipientTrustline(recipientAddress, USDC);
    } catch (err) {
      error = err as MissingTrustlineError;
    }

    expect(error).toBeInstanceOf(MissingTrustlineError);
    expect(typeof error!.changeTrustXdr).toBe("string");
    expect(error!.changeTrustXdr.length).toBeGreaterThan(0);
  });
});

// ── Unexpected Horizon errors ─────────────────────────────────────────────────

describe("validateRecipientTrustline – unexpected Horizon error", () => {
  it("re-throws non-404 Horizon errors without caching", async () => {
    mockCacheGet.mockResolvedValue(null);
    mockLoadAccount.mockRejectedValue(new Error("Horizon 500 Internal Server Error"));

    await expect(
      validateRecipientTrustline(recipientAddress, USDC),
    ).rejects.toThrow("Horizon 500 Internal Server Error");

    expect(mockCacheSet).not.toHaveBeenCalled();
  });
});

// ── Cache key structure ───────────────────────────────────────────────────────

describe("validateRecipientTrustline – cache key", () => {
  it("uses a key that contains the recipient address, asset code, and issuer", async () => {
    mockCacheGet.mockResolvedValue(null);
    mockLoadAccount.mockResolvedValue(makeAccount([USDC]));

    await validateRecipientTrustline(recipientAddress, USDC);

    const [[cacheKey]] = mockCacheSet.mock.calls;
    expect(cacheKey).toContain(recipientAddress);
    expect(cacheKey).toContain("USDC");
    expect(cacheKey).toContain(ISSUER);
  });

  it("caches the result for exactly 60 seconds", async () => {
    mockCacheGet.mockResolvedValue(null);
    mockLoadAccount.mockResolvedValue(makeAccount([USDC]));

    await validateRecipientTrustline(recipientAddress, USDC);

    const [, , ttl] = mockCacheSet.mock.calls[0];
    expect(ttl).toBe(60);
  });
});

// ── MissingTrustlineError class ───────────────────────────────────────────────

describe("MissingTrustlineError", () => {
  const params = {
    recipientAddress,
    assetCode: "USDC",
    assetIssuer: ISSUER,
    changeTrustXdr: "AAAAAQAAAAA...",
  };

  it("is an instance of Error and MissingTrustlineError", () => {
    const err = new MissingTrustlineError(params);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(MissingTrustlineError);
  });

  it("has name MissingTrustlineError", () => {
    const err = new MissingTrustlineError(params);
    expect(err.name).toBe("MissingTrustlineError");
  });

  it("has HTTP status 400", () => {
    const err = new MissingTrustlineError(params);
    expect(err.statusCode).toBe(400);
  });

  it("exposes assetCode, assetIssuer, recipientAddress, changeTrustXdr", () => {
    const err = new MissingTrustlineError(params);
    expect(err.assetCode).toBe("USDC");
    expect(err.assetIssuer).toBe(ISSUER);
    expect(err.recipientAddress).toBe(recipientAddress);
    expect(err.changeTrustXdr).toBe("AAAAAQAAAAA...");
  });

  it("populates meta with changeTrustXdr (always visible in API response)", () => {
    const err = new MissingTrustlineError(params);
    expect(err.meta).toEqual({
      assetCode: "USDC",
      assetIssuer: ISSUER,
      changeTrustXdr: "AAAAAQAAAAA...",
    });
  });
});
