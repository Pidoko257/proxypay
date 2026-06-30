import { Request, Response, NextFunction } from "express";

/**
 * Content Negotiation Middleware (#97)
 *
 * Enforces proper HTTP content negotiation for all API responses:
 *
 *  - Requests that explicitly accept `application/json` or `* / *` are served
 *    normally with `Content-Type: application/json; charset=utf-8`.
 *  - Requests carrying an `Accept` header that lists unsupported MIME types
 *    and does *not* include `application/json` or `* / *` are rejected with
 *    `406 Not Acceptable`.
 *  - When no `Accept` header is present the request is treated as accepting
 *    JSON (permissive behaviour).
 *
 * The middleware also ensures every successful response carries the correct
 * `Content-Type` header, regardless of whether a route handler sets it.
 */

const JSON_CONTENT_TYPE = "application/json; charset=utf-8";

/**
 * Returns `true` if the `Accept` header value indicates the client is willing
 * to receive `application/json`.
 *
 * Supported patterns:
 *   - `application/json`
 *   - `application/json; q=…`
 *   - `* / *`
 *   - `application/*`
 *   - Comma-separated lists containing any of the above
 */
function acceptsJson(acceptHeader: string): boolean {
  const tokens = acceptHeader.split(",").map((t) => t.trim().toLowerCase());

  for (const token of tokens) {
    // Strip quality factor (e.g. "application/json;q=0.9" → "application/json")
    const mimeType = token.split(";")[0].trim();

    if (
      mimeType === "*/*" ||
      mimeType === "application/*" ||
      mimeType === "application/json"
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Express middleware that:
 *  1. Rejects requests with unsupported Accept headers (406).
 *  2. Always sets `Content-Type: application/json; charset=utf-8` on responses.
 */
export function contentNegotiation(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const acceptHeader = req.headers["accept"];

  // If the client sent an Accept header that does not include JSON, refuse.
  if (acceptHeader && !acceptsJson(acceptHeader)) {
    res.status(406).json({
      error: "Not Acceptable",
      message:
        "This API only supports application/json responses. " +
        "Set your Accept header to 'application/json' or '*/*'.",
      acceptedTypes: ["application/json"],
    });
    return;
  }

  // Ensure all responses carry the canonical JSON Content-Type.
  res.setHeader("Content-Type", JSON_CONTENT_TYPE);

  next();
}
