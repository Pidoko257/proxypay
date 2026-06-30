import { Router, Request, Response } from "express";
import { verifyAirtelCallbackSignature } from "../middleware/airtelCallbackSignature";
import { ingestRateLimiter } from "../middleware/ingestRateLimit";

const router = Router();

// Rate-limit ingest traffic before any heavier processing.
router.use(ingestRateLimiter);

// Validate Airtel Authorization bearer token before processing.
router.use(verifyAirtelCallbackSignature);

router.post("/callback", async (req: Request, res: Response) => {
  // Future Airtel callback processing can be added here.
  res.status(200).json({ status: "accepted" });
});

export default router;
