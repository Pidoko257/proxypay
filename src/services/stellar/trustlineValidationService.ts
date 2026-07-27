import * as StellarSdk from "stellar-sdk";
import { getStellarServer, getNetworkPassphrase } from "../../config/stellar";
import { redisClient } from "../../config/redis";
import { ERROR_CODES } from "../../constants/errorCodes";
import { AppError } from "../../middleware/errorHandler";

const CACHE_TTL_SECONDS = 60;

// ── Error ─────────────────────────────────────────────────────────────────────

/**
 * Thrown when a recipient account lacks a trustline for the payment asset.
 * Carries the asset details and a pre-built ChangeTrust XDR the recipient
 * can sign to add the trustline.
 */
export class MissingTrustlineError extends Error implements AppError {
  readonly code = ERROR_CODES.ERR_MISSING_TRUSTLINE;
  readonly statusCode = 400;
  readonly details: {
    assetCode: string;
    assetIssuer: string;
    recipient: string;
    changeTrustXdr: string;
  };

  constructor(
    recipient: string,
    asset: StellarSdk.Asset,
    changeTrustXdr: string,
  ) {
    super(
      `Recipient ${recipient} has no trustline for ${asset.getCode()}:${asset.getIssuer()}`,
    );
    this.name = "MissingTrustlineError";
    this.details = {
      assetCode: asset.getCode(),
      assetIssuer: asset.getIssuer(),
      recipient,
      changeTrustXdr,
    };
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function cacheKey(recipient: string, asset: StellarSdk.Asset): string {
  return `trustline:${recipient}:${asset.getCode()}:${asset.getIssuer()}`;
}

/**
 * Builds an unsigned ChangeTrust transaction XDR so the recipient can sign
 * and submit it to establish the trustline.
 *
 * The transaction uses a placeholder sequence number (0) because we don't
 * load the recipient's account here — the recipient's wallet must set the
 * correct sequence before signing.
 */
function buildChangeTrustXdr(
  recipient: string,
  asset: StellarSdk.Asset,
): string {
  // Build with a minimal stub account so we don't hit Horizon just for the XDR
  const stubAccount = new StellarSdk.Account(recipient, "0");
  const tx = new StellarSdk.TransactionBuilder(stubAccount, {
    fee: StellarSdk.BASE_FEE,
    networkPassphrase: getNetworkPassphrase(),
  })
    .addOperation(StellarSdk.Operation.changeTrust({ asset }))
    .setTimeout(0)
    .build();

  return tx.toXDR();
}

// ── Main validator ────────────────────────────────────────────────────────────

/**
 * Validates that `recipient` has a trustline for `asset` before a payment is
 * submitted. Returns immediately for native XLM.
 *
 * Results are cached in Redis for {@link CACHE_TTL_SECONDS} seconds so
 * repeated calls for the same (recipient, asset) pair skip the Horizon round-trip.
 *
 * @throws {MissingTrustlineError} when the trustline is absent
 */
export async function validateTrustlineBeforePayment(
  recipient: string,
  asset: StellarSdk.Asset,
): Promise<void> {
  if (asset.isNative()) return;

  const key = cacheKey(recipient, asset);

  // --- Cache read ---
  let cached: string | null = null;
  try {
    if (redisClient.isOpen) {
      cached = await redisClient.get(key);
    }
  } catch (err) {
    // Non-fatal: proceed to Horizon on cache failure
    console.warn(
      "trustlineValidation: Redis read failed, falling back to Horizon",
      err,
    );
  }

  let hasTrust: boolean;

  if (cached !== null) {
    hasTrust = cached === "1";
  } else {
    // --- Horizon check ---
    const server = getStellarServer();
    try {
      const account = await server.loadAccount(recipient);
      const wantCode = asset.getCode();
      const wantIssuer = asset.getIssuer();

      hasTrust = account.balances.some(
        (b) =>
          b.asset_type !== "native" &&
          b.asset_type !== "liquidity_pool_shares" &&
          "asset_code" in b &&
          b.asset_code === wantCode &&
          "asset_issuer" in b &&
          b.asset_issuer === wantIssuer,
      );
    } catch (err: unknown) {
      // Account not found on-chain → definitely no trustline
      const e = err as { response?: { status?: number } };
      if (e?.response?.status === 404) {
        hasTrust = false;
      } else {
        throw err;
      }
    }

    // --- Cache write ---
    try {
      if (redisClient.isOpen) {
        await redisClient.set(key, hasTrust ? "1" : "0", {
          EX: CACHE_TTL_SECONDS,
        });
      }
    } catch (err) {
      console.warn("trustlineValidation: Redis write failed", err);
    }
  }

  if (!hasTrust) {
    const changeTrustXdr = buildChangeTrustXdr(recipient, asset);
    throw new MissingTrustlineError(recipient, asset, changeTrustXdr);
  }
}
