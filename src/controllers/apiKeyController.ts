import { NextFunction, Request, Response } from "express";
import { z } from "zod";
import {
  ApiKeyScope,
  ApiKeyScopeName,
  ScopeGroup,
  listAllScopeNames,
} from "../auth/apikeys";
import { ERROR_CODES } from "../constants/errorCodes";
import { createError } from "../middleware/errorHandler";
import { apiKeyService } from "../services/apiKeyService";
import { getAuditContext } from "../middleware/auditContext";

const scopeNames = new Set<string>(listAllScopeNames());

const createApiKeySchema = z.object({
  expires_in_days: z.number().int().min(1).max(365).optional(),
  label: z.string().trim().min(1).max(255).optional(),
  permissions: z
    .number()
    .int()
    .nonnegative()
    .max(ScopeGroup.FULL_ACCESS)
    .optional(),
  scopes: z.array(z.string()).optional(),
});

function parseCreateRequest(body: unknown) {
  const parsed = createApiKeySchema.safeParse(body);
  if (!parsed.success) {
    throw createError(ERROR_CODES.INVALID_INPUT, "Invalid API key request", {
      issues: parsed.error.issues,
    });
  }

  if (parsed.data.scopes?.some((scope) => !scopeNames.has(scope))) {
    throw createError(ERROR_CODES.INVALID_INPUT, "Invalid API key scope", {
      scopes: parsed.data.scopes,
      allowedScopes: Object.keys(ApiKeyScope),
    });
  }

  return parsed.data;
}

function getUserId(req: Request): string {
  const userId = req.jwtUser?.userId;
  if (!userId) {
    throw createError(ERROR_CODES.UNAUTHORIZED, "Authenticated user required");
  }
  return userId;
}

export class ApiKeyController {
  static async create(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const body = parseCreateRequest(req.body ?? {});
      const userId = getUserId(req);
      const result = await apiKeyService.createForUser(
        userId,
        {
          expiresInDays: body.expires_in_days,
          label: body.label,
          permissions: body.permissions,
          scopes: body.scopes as ApiKeyScopeName[] | undefined,
        },
        getAuditContext(req, userId),
      );

      res.status(201).json(result);
    } catch (error) {
      next(error);
    }
  }

  static async revoke(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const userId = getUserId(req);
      await apiKeyService.revokeForUser(
        userId,
        req.params.id,
        getAuditContext(req, userId),
      );
      res.status(204).send();
    } catch (error) {
      next(error);
    }
  }

  static async list(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const keys = await apiKeyService.listForUser(getUserId(req));
      res.json({ api_keys: keys });
    } catch (error) {
      next(error);
    }
  }
}
