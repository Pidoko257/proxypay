import { Router, Request, Response } from "express";
import { createProviderCallbackVerifier } from "../middleware/providerCallbackSignature";
import { ingestRateLimiter } from "../middleware/ingestRateLimit";
import { callbackIdempotency } from "../middleware/callbackIdempotency";

const router = Router();

// Rate-limit ingest traffic before signature verification and DB writes.
router.use(ingestRateLimiter);

const verifyOrangeCallbackSignature = createProviderCallbackVerifier({
  provider: "orange",
  secretConfigKey: "providers.orange.callbackSecret",
  headerConfigKey: "providers.orange.callbackSignatureHeader",
  defaultHeader: "x-orange-signature",
  algorithms: ["sha256"],
  allowPrefixed: true,
  defaultEncoding: "hex",
});

// Signature verification is applied to all incoming Orange callback requests.
router.use(verifyOrangeCallbackSignature);

// Callback idempotency deduplication to prevent processing duplicate provider events.
router.use(callbackIdempotency({ provider: "orange" }));

router.post("/callback", async (req: Request, res: Response) => {
  // Future callback processing can be added here.
  // Currently the Orange callback is authenticated, deduplicated, and acknowledged.
  res.status(200).json({ status: "accepted" });
});

export default router;