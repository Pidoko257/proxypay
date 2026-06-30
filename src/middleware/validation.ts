import { Request, Response, NextFunction } from "express";
import { z, ZodSchema, ZodObject, ZodRawShape } from "zod";

/**
 * Structured validation error item returned in 422 responses.
 */
export interface ValidationErrorItem {
  field: string;
  message: string;
}

/**
 * Shape of a combined schema passed to validate().
 * Each key is optional — only supplied keys are validated.
 */
export interface ValidateSchemaShape {
  body?: ZodSchema;
  query?: ZodSchema;
  params?: ZodSchema;
}

/**
 * Formats a ZodError issue path as a dot-separated string, with an optional
 * prefix (e.g. "body", "query", "params") prepended when more than one
 * source is validated at the same time.
 */
function formatPath(prefix: string, path: (string | number)[]): string {
  const parts = path.map(String).filter(Boolean);
  return prefix && parts.length > 0
    ? `${prefix}.${parts.join(".")}`
    : prefix || parts.join(".") || "unknown";
}

/**
 * Converts a ZodError into the canonical [{field, message}] format.
 */
function zodErrorToItems(
  error: z.ZodError,
  prefix: string,
): ValidationErrorItem[] {
  return error.issues.map((issue) => ({
    field: formatPath(prefix, issue.path),
    message: issue.message,
  }));
}

/**
 * Core 422 helper — sends the structured error response and ends the request.
 */
function send422(res: Response, errors: ValidationErrorItem[]): void {
  res.status(422).json({ errors });
}

// ─────────────────────────────────────────────────────────────────────────────
// Primary API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * validate(schema) — centralized validation middleware factory.
 *
 * Accepts either:
 *   • A plain ZodSchema  → validates req.body only (backwards-compatible)
 *   • A { body?, query?, params? } shape object → validates each supplied target
 *
 * On success: calls next() and mutates req.body / req.query / req.params with
 * the parsed (coerced) values so downstream handlers get clean, typed data.
 *
 * On failure: responds with HTTP 422 and an array of { field, message } objects.
 *
 * @example — body only (backwards-compatible)
 *   router.post('/login', validate(LoginSchema), handler)
 *
 * @example — body + query + params
 *   router.get(
 *     '/:id/transactions',
 *     validate({ params: IdParamSchema, query: PaginationSchema }),
 *     handler,
 *   )
 */
export function validate(
  schema: ZodSchema | ValidateSchemaShape,
): (req: Request, res: Response, next: NextFunction) => void {
  // Detect whether the caller passed a plain ZodSchema or a shape object.
  const isPlainSchema =
    schema instanceof z.ZodType || typeof (schema as any).parse === "function";

  return (req: Request, res: Response, next: NextFunction): void => {
    const errors: ValidationErrorItem[] = [];

    if (isPlainSchema) {
      // ── Backwards-compatible: treat as body schema ────────────────────────
      const result = (schema as ZodSchema).safeParse(req.body);
      if (!result.success) {
        send422(res, zodErrorToItems(result.error, "body"));
        return;
      }
      req.body = result.data;
    } else {
      // ── Shape object: validate each supplied target ───────────────────────
      const shape = schema as ValidateSchemaShape;

      if (shape.body) {
        const result = shape.body.safeParse(req.body);
        if (result.success) {
          req.body = result.data;
        } else {
          errors.push(...zodErrorToItems(result.error, "body"));
        }
      }

      if (shape.query) {
        const result = shape.query.safeParse(req.query);
        if (result.success) {
          // req.query is read-only by default; we use Object.assign to update it
          Object.assign(req.query, result.data);
        } else {
          errors.push(...zodErrorToItems(result.error, "query"));
        }
      }

      if (shape.params) {
        const result = shape.params.safeParse(req.params);
        if (result.success) {
          Object.assign(req.params, result.data);
        } else {
          errors.push(...zodErrorToItems(result.error, "params"));
        }
      }

      if (errors.length > 0) {
        send422(res, errors);
        return;
      }
    }

    next();
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Legacy named helpers (kept for backwards-compatibility during migration)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @deprecated Use validate({ body: schema }) or validate(schema) instead.
 */
export function validateRequest(schema: ZodSchema) {
  return validate(schema);
}

/**
 * @deprecated Use validate({ query: schema }) instead.
 */
export function validateQuery(schema: ZodSchema) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.query);
    if (!result.success) {
      send422(res, zodErrorToItems(result.error, "query"));
      return;
    }
    Object.assign(req.query, result.data);
    next();
  };
}

/**
 * @deprecated Use validate({ params: schema }) instead.
 */
export function validateParams(schema: ZodSchema) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.params);
    if (!result.success) {
      send422(res, zodErrorToItems(result.error, "params"));
      return;
    }
    Object.assign(req.params, result.data);
    next();
  };
}
