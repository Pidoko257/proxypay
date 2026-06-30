import * as StellarSdk from "stellar-sdk";
import { getStellarServer, getNetworkPassphrase } from "../config/stellar";
import { layeredCache } from "../services/layeredCache";
import { resolveToBaseAddress } from "./muxed";
import { BusinessLogicError } from "../utils/errors";
import { ERROR_CODES } from "../constants/errorCodes";

// ── Constants ─────────────────────────────────────────────────────────────────

const TRUSTLINE_CACHE_TTL_SEC = 60;
const MAX_TRUSTLINE_LIMIT = "922337203685.4775807";

// ── Error class ───────────────────────────────────────────────────────────────

/**
 * Thrown when a recipient account is missing a required Stellar trustline.
 *
 * The `changeTrustXdr` field contains an unsigned ChangeTrust transaction XDR
 * that the recipient can import into any Stellar wallet, sign, and submit to
 * establish the trustline.  It is surfaced in the `meta` field of the API
 * response so clients always have it — even in production.
 */
export class MissingTrustlineError extends BusinessLogicError {
  readonly assetCode: string;
  readonly assetIssuer: string;
  readonly recipientAddress: string;
  readonly changeTrustXdr: string;

  constructor(params: {
    recipientAddress: string;
    assetCode: string;
    assetIssuer: string;
    changeTrustXdr: string;
  }) {
    super(
      `Recipient ${params.recipientAddress} has no trustline for ${params.assetCode}:${params.assetIssuer}`,
      ERROR_CODES.ERR_MISSING_TRUSTLINE,
      {
        assetCode: params.assetCode,
        assetIssuer: params.assetIssuer,
        recipientAddress: params.recipientAddress,
      },
    );
    this.name = "MissingTrustlineError";
    this.assetCode = params.assetCode;
    this.assetIssuer = params.assetIssuer;
    this.recipientAddress = params.recipientAddress;
    this.changeTrustXdr = params.changeTrustXdr;

    // meta is always included in the API response (never stripped in production)
    this.meta = {
      assetCode: params.assetCode,
      assetIssuer: params.assetIssuer,
      changeTrustXdr: params.changeTrustXdr,
    };
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function trustlineCacheKey(
  baseAddress: string,
  assetCode: string,
  assetIssuer: string,
): string {
  return `trustline:validation:${baseAddress}:${assetCode}:${assetIssuer}`;
}

/**
 * Builds an UNSIGNED ChangeTrust transaction XDR that the recipient can sign
 * to establish a trustline for `asset`.
 *
 * When the account already exists on Horizon its current sequence number is
 * used so the XDR is immediately submittable.  For accounts that are not yet
 * funded we fall back to sequence "0" so a usable template is still returned
 * (the recipient must fund the account first; the sequence will need refreshing).
 */
function buildChangeTrustXdrFromAccount(
  account: StellarSdk.Horizon.AccountResponse | StellarSdk.Account,
  asset: StellarSdk.Asset,
): string {
  const tx = new StellarSdk.TransactionBuilder(account as any, {
    fee: StellarSdk.BASE_FEE,
    networkPassphrase: getNetworkPassphrase(),
  })
    .addOperation(
      StellarSdk.Operation.changeTrust({
        asset,
        limit: MAX_TRUSTLINE_LIMIT,
      }),
    )
    .setTimeout(0) // no expiry — recipient signs when ready
    .build();

  return tx.toEnvelope().toXDR("base64");
}

async function loadAccountForXdr(
  baseAddress: string,
  asset: StellarSdk.Asset,
): Promise<string> {
  const server = getStellarServer();
  let account: StellarSdk.Horizon.AccountResponse | StellarSdk.Account;

  try {
    account = await server.loadAccount(baseAddress);
  } catch (err: unknown) {
    const e = err as { response?: { status?: number } };
    if (e.response?.status === 404) {
      // Account not yet funded — build template with dummy sequence
      account = new StellarSdk.Account(baseAddress, "0");
    } else {
      throw err;
    }
  }

  return buildChangeTrustXdrFromAccount(account, asset);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Validates that `destinationAccount` holds a trustline for `asset` before a
 * payment is sent.  Skips the check entirely for native XLM.
 *
 * The validation result is cached in Redis for 60 seconds to avoid redundant
 * Horizon round-trips on hot payment paths.
 *
 * @throws {MissingTrustlineError} when the trustline is absent, including an
 *   unsigned ChangeTrust XDR so the recipient can fix this immediately.
 * @throws re-throws unexpected Horizon errors as-is.
 */
export async function validateRecipientTrustline(
  destinationAccount: string,
  asset: StellarSdk.Asset,
): Promise<void> {
  if (asset.isNative()) return;

  const baseAddress = resolveToBaseAddress(destinationAccount);
  const assetCode = asset.getCode();
  const assetIssuer = asset.getIssuer();
  const cacheKey = trustlineCacheKey(baseAddress, assetCode, assetIssuer);

  // ── Cache hit ─────────────────────────────────────────────────────────────
  const cached = await layeredCache.get<boolean>(cacheKey);

  if (cached === true) return;

  if (cached === false) {
    // Trustline confirmed missing within the TTL window.
    // Build a fresh XDR with the current sequence number and throw.
    const changeTrustXdr = await loadAccountForXdr(baseAddress, asset);
    throw new MissingTrustlineError({
      recipientAddress: destinationAccount,
      assetCode,
      assetIssuer,
      changeTrustXdr,
    });
  }

  // ── Cache miss: query Horizon ─────────────────────────────────────────────
  const server = getStellarServer();
  let loadedAccount: StellarSdk.Horizon.AccountResponse | null = null;
  let hasTrustline: boolean;

  try {
    loadedAccount = await server.loadAccount(baseAddress);
    hasTrustline = loadedAccount.balances.some(
      (b) =>
        b.asset_type !== "native" &&
        b.asset_type !== "liquidity_pool_shares" &&
        "asset_code" in b &&
        b.asset_code === assetCode &&
        "asset_issuer" in b &&
        b.asset_issuer === assetIssuer,
    );
  } catch (err: unknown) {
    const e = err as { response?: { status?: number } };
    if (e.response?.status === 404) {
      // Account doesn't exist on-chain → cannot have a trustline
      hasTrustline = false;
    } else {
      throw err;
    }
  }

  // Cache the boolean result for TRUSTLINE_CACHE_TTL_SEC seconds
  await layeredCache.set(cacheKey, hasTrustline, TRUSTLINE_CACHE_TTL_SEC);

  if (!hasTrustline) {
    // Reuse the already-loaded account if possible to avoid a second Horizon call
    const changeTrustXdr = loadedAccount
      ? buildChangeTrustXdrFromAccount(loadedAccount, asset)
      : await loadAccountForXdr(baseAddress, asset);

    throw new MissingTrustlineError({
      recipientAddress: destinationAccount,
      assetCode,
      assetIssuer,
      changeTrustXdr,
    });
  }
}
