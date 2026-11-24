/**
 * Shared pagination middleware.
 *
 * Every list endpoint should run its query params through
 * `parsePaginationQuery` (or `parseRequestPagination` for handlers that
 * build their own responses) so that:
 *
 *   - `limit` is clamped to the shared maximum page size,
 *   - `after` / `before` / `cursor` are validated opaque cursors,
 *   - malformed cursors are rejected with `400` instead of being silently
 *     ignored or passed through to SQL.
 */

import { NextFunction, Request, Response } from "express";
import { ERROR_CODES } from "../constants/errorCodes";
import {
  DecodedPaginationParams,
  PaginationError,
  ParsePaginationOptions,
  decodePaginationCursors,
  parsePaginationParams,
} from "../utils/pagination";
import { createError } from "./errorHandler";

/**
 * Parse and validate the pagination query params of a request.
 *
 * Returns the validated params (cursors already decoded) or `null` after
 * writing a `400` response for invalid input. Intended for handlers that
 * own their response shape instead of using `parsePaginationQuery`.
 */
export function parseRequestPagination(
  req: Request,
  res: Response,
  options: ParsePaginationOptions = {},
): DecodedPaginationParams | null {
  try {
    const params = parsePaginationParams(
      req.query as Record<string, unknown>,
      options,
    );
    return decodePaginationCursors(params);
  } catch (error) {
    if (error instanceof PaginationError) {
      res.status(400).json({
        error: error.message,
        message_en: error.message,
      });
      return null;
    }
    throw error;
  }
}

/**
 * Express middleware that parses pagination query params into
 * `req.pagination`, mapping `PaginationError` to a `400` response.
 *
 * ```ts
 * router.get("/items", parsePaginationQuery(), async (req, res) => {
 *   const { limit, offset, after } = req.pagination!;
 * });
 * ```
 */
export function parsePaginationQuery(
  options: ParsePaginationOptions = {},
) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    try {
      req.pagination = decodePaginationCursors(
        parsePaginationParams(req.query as Record<string, unknown>, options),
      );
      next();
    } catch (error) {
      if (error instanceof PaginationError) {
        next(
          createError(ERROR_CODES.INVALID_INPUT, error.message, {
            error: error.message,
          }),
        );
        return;
      }
      next(error);
    }
  };
}
