import { Router, Request, Response } from "express";
import { createProviderCallbackVerifier } from "../middleware/providerCallbackSignature";
import { ingestRateLimiter } from "../middleware/ingestRateLimit";
import { callbackIdempotency } from "../middleware/callbackIdempotency";

const router = Router();

// Rate-limit ingest traffic before signature verification and DB writes.
router.use(ingestRateLimiter);

const verifyAirtelCallbackSignature = createProviderCallbackVerifier({
  provider: "airtel",
  secretConfigKey: "providers.airtel.callbackSecret",
  headerConfigKey: "providers.airtel.callbackSignatureHeader",
  defaultHeader: "x-airtel-signature",
  altHeaders: ["x-signature"],
  algorithms: ["sha256"],
  allowPrefixed: true,
  defaultEncoding: "base64",
});

// Signature verification is applied to all incoming Airtel callback requests.
router.use(verifyAirtelCallbackSignature);

// Callback idempotency deduplication to prevent processing duplicate provider events.
router.use(callbackIdempotency({ provider: "airtel" }));

router.post("/callback", async (req: Request, res: Response) => {
  // Future callback processing can be added here.
  // Currently the Airtel callback is authenticated, deduplicated, and acknowledged.
  res.status(200).json({ status: "accepted" });
});

export default router;