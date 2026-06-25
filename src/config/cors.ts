/**
 * Re-exports the CORS configuration from express.ts.
 * The authoritative implementation (allowlist parsing, preflight handling,
 * credentials policy) lives in express.ts alongside the full security stack.
 */
export { corsOptions } from "./express";
