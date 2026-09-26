/**
 * WebSocket connection auth helpers for GraphQL subscriptions (graphql-ws).
 *
 * JWT is passed via connectionParams.authToken (or Authorization Bearer).
 * Helpers never throw — callers return `false` from onConnect to close only
 * the offending connection without crashing the shared WebSocket server.
 */

import { verifyToken, type JWTPayload } from "../auth/jwt";

export type WsConnectionParams = {
  authToken?: unknown;
  Authorization?: unknown;
  authorization?: unknown;
  [key: string]: unknown;
};

export type WsAuthResult =
  | { ok: true; claims: JWTPayload | null }
  | { ok: false; reason: string };

function extractToken(params: WsConnectionParams | undefined): string | null {
  if (!params) return null;

  const raw =
    params.authToken ??
    params.Authorization ??
    params.authorization ??
    null;

  if (raw == null) return null;
  const value = String(raw).trim();
  if (!value) return null;

  return value.replace(/^Bearer\s+/i, "");
}

export function shouldRequireWsAuth(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    env.NODE_ENV === "production" ||
    !!env.GRAPHQL_API_KEY ||
    env.GRAPHQL_WS_REQUIRE_AUTH === "true"
  );
}

/**
 * Authenticate a graphql-ws connection from connectionParams.
 * Never throws — invalid tokens become `{ ok: false }`.
 */
export function authenticateWsConnection(
  connectionParams: WsConnectionParams | undefined,
  env: NodeJS.ProcessEnv = process.env,
): WsAuthResult {
  try {
    const token = extractToken(connectionParams);
    const requireAuth = shouldRequireWsAuth(env);

    if (!token) {
      if (requireAuth) {
        return { ok: false, reason: "missing authToken" };
      }
      return { ok: true, claims: null };
    }

    try {
      const claims = verifyToken(token);
      return { ok: true, claims };
    } catch (err) {
      return {
        ok: false,
        reason: err instanceof Error ? err.message : "invalid token",
      };
    }
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : "auth failed",
    };
  }
}
