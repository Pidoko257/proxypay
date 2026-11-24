import { Request, Response, NextFunction } from "express";
import { pool } from "../config/database";
import { newEnforcer, Enforcer } from "casbin";
import path from "path";

export interface RBACRequest extends Request {
  user?: {
    id: string;
    role: string;
    permissions: string[];
  };
}

import fs from "fs";

let enforcer: Enforcer;
let isWatching = false;
let watcher: fs.FSWatcher | null = null;

/**
 * Initialize Casbin Enforcer
 */
export async function initCasbin(): Promise<Enforcer> {
  if (!enforcer) {
    const modelPath = path.resolve(__dirname, "../config/casbin_model.conf");
    const policyPath = path.resolve(__dirname, "../config/casbin_policy.csv");
    enforcer = await newEnforcer(modelPath, policyPath);

    // Implement hot-loading
    if (!isWatching) {
      watcher = fs.watch(policyPath, async (eventType) => {
        if (eventType === 'change') {
          if (process.env.NODE_ENV !== 'test') {
            console.log('Casbin policy file changed, reloading policies...');
          }
          await enforcer.loadPolicy();
        }
      });
      isWatching = true;
    }
  }
  return enforcer;
}

/**
 * Close watchers for clean shutdown (primarily for testing)
 */
export function closeCasbinWatcher() {
  if (watcher) {
    watcher.close();
    watcher = null;
    isWatching = false;
  }
}

/**
 * Endpoint to artificially reload policies at runtime without restarting the server
 */
export async function reloadCasbinPolicies() {
  if (enforcer) {
    await enforcer.loadPolicy();
  }
}

/**
 * Get user role information from database
 */
async function getUserRole(
  userId: string,
): Promise<{ role_name: string; role_id: string } | null> {
  const query = `
    SELECT r.name as role_name, r.id as role_id
    FROM users u
    JOIN roles r ON u.role_id = r.id
    WHERE u.id = $1
  `;

  const result = await pool.query(query, [userId]);
  return result.rows.length > 0 ? result.rows[0] : null;
}

/**
 * Middleware to explicitly check an object and action
 */
export function authorizeObj(resourceType: string, action: string, requireOwnership: boolean = false) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.jwtUser) {
        return res.status(401).json({
          error: "Unauthorized",
          message: "Authentication required",
        });
      }

      const userRole = await getUserRole(req.jwtUser.userId);
      if (!userRole) {
        return res.status(403).json({
          error: "Forbidden",
          message: "User role not found",
        });
      }

      req.userRole = userRole.role_name;

      const e = await initCasbin();

      const sub = {
        id: req.jwtUser.userId,
        role: userRole.role_name
      };

      // In a middleware, we don't have the specific object ID's owner yet unless passed in URL or body.
      // But for ABAC ownership checks before fetching the object, we just pass checkOwner flag.
      // Later, specific routes can call `authorizeDynamic` if they fetch the object inside the route.
      const obj = {
        type: resourceType,
        checkOwner: requireOwnership,
        ownerUserId: requireOwnership ? req.jwtUser.userId : undefined // this assumes the user requests their OWN resource explicitly, but really it should be deferred if possible.
      };

      const allowed = await e.enforce(sub, obj, action);

      if (!allowed) {
        return res.status(403).json({
          error: "Forbidden",
          message: `Insufficient permissions. Required: ${action} on ${resourceType}`,
        });
      }

      next();
    } catch (error) {
      console.error("RBAC permission check error:", error);
      return res.status(500).json({
        error: "Internal server error",
        message: "Failed to check permissions",
      });
    }
  };
}

/**
 * Map a legacy permission string like "dispute:create" or "read:own"
 * to a real (object, action) pair that Casbin recognizes.
 *
 * Legacy forms:
 *   "<object>:<action>"  -> { type: object, action }
 *   "<object>:own"      -> { type: object, action: "read" } (ownership-scoped read)
 *   "<object>:all"      -> { type: object, action: "read" } (unscoped read)
 *   "<action>"          -> { type: "*", action }
 */
function parseLegacyPermission(permission: string): { objType: string; act: string } {
  if (!permission.includes(":")) {
    return { objType: "*", act: permission };
  }

  const parts = permission.split(":");
  const objType = parts[0];
  const rawAct = parts[1];

  // "read:own" / "read:all" are ownership scopes, not Casbin actions.
  // Map them to the underlying read action on the object.
  if (rawAct === "own" || rawAct === "all") {
    return { objType, act: "read" };
  }

  return { objType, act: rawAct };
}

/**
 * Backwards compatible method: checks permissions.
 * Many legacy routes just pass 'dispute:create', 'admin:system', 'read:own'.
 * We map these old strings to Casbin checks.
 */
export function requirePermission(permission: string) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.jwtUser) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      const userRole = await getUserRole(req.jwtUser.userId);
      if (!userRole) return res.status(403).json({ error: "Forbidden" });

      req.userRole = userRole.role_name;
      const e = await initCasbin();

      const sub = { id: req.jwtUser.userId, role: userRole.role_name };

      const { objType, act } = parseLegacyPermission(permission);

      const allowed = await e.enforce(sub, { type: objType }, act);

      // Casbin is the single source of truth. Admin-level access must be
      // expressed as a Casbin policy entry, not inferred from the role name.
      if (!allowed) {
        return res.status(403).json({
          error: "Forbidden",
          message: `Insufficient permissions. Required: ${permission}`,
        });
      }

      next();
    } catch (error) {
      return res.status(500).json({ error: "Internal server error" });
    }
  };
}

export function requireAnyPermission(permissions: string[]) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.jwtUser) return res.status(401).json({ error: "Unauthorized" });
      const userRole = await getUserRole(req.jwtUser.userId);
      if (!userRole) return res.status(403).json({ error: "Forbidden" });

      req.userRole = userRole.role_name;
      const e = await initCasbin();
      const sub = { id: req.jwtUser.userId, role: userRole.role_name };

      if (userRole.role_name === 'admin' || userRole.role_name === 'admin:system') {
        return next();
      }

      let hasPermission = false;
      for (const p of permissions) {
        let objType = "*";
        let act = p;
        if (p.includes(":")) {
          const parts = p.split(":");
          objType = parts[0];
          act = parts[1];
        }
        if (await e.enforce(sub, { type: objType }, act)) {
          hasPermission = true;
          break;
        }
      }

      if (!hasPermission) {
        return res.status(403).json({ error: "Forbidden", message: "Insufficient permissions." });
      }

      next();
    } catch (error) {
      return res.status(500).json({ error: "Internal error" });
    }
  };
}

export function requireRole(role: string) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.jwtUser) return res.status(401).json({ error: "Unauthorized" });
      const userRole = await getUserRole(req.jwtUser.userId);
      if (!userRole) return res.status(403).json({ error: "Forbidden" });

      req.userRole = userRole.role_name;

      if (userRole.role_name !== role && userRole.role_name !== "admin") {
        return res.status(403).json({ error: "Forbidden", message: `Required: ${role}` });
      }
      next();
    } catch (error) {
      return res.status(500).json({ error: "Internal server error" });
    }
  };
}

export function requireOwnDataAccess(action: "read" | "write" | "delete") {
  return authorizeObj("transaction", action, true);
}

export const requireAdmin = requireRole("admin");
export const requireReadAccess = authorizeObj("transaction", "read", false);
export const requireWriteAccess = authorizeObj("transaction", "write", false);

export async function attachUserContext(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.jwtUser) return next();
    const userR

/* … truncated 2050 chars — edit only what you need near the top … */
