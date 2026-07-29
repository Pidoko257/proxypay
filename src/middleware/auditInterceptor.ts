import { Request, Response, NextFunction } from 'express';
import { Pool } from 'pg';

export const auditInterceptor = (db: Pool) => {
  return (req: Request, res: Response, next: NextFunction) => {
    // Only track mutation requests; ignore read-only methods
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      return next();
    }

    // Extract admin identification
    const adminId = (req as any).jwtUser?.userId || (req as any).user?.id || 'unknown_admin';
    const action = `${req.method} ${req.originalUrl}`;
    
    // Attempt to parse resource and identifier from the path
    const pathParts = req.originalUrl.split('?')[0].split('/').filter(Boolean);
    const resource = pathParts[1] || 'system';
    const resourceId = req.params?.id || req.body?.id || req.query?.id || null;
    
    // Capture the inbound state (before value)
    const payloadBefore = req.body ? { ...req.body } : null;
    
    // Override res.json to capture the outbound state (the "after" value)
    const originalJson = res.json;
    res.json = function (body) {
      res.json = originalJson; // Restore original function to prevent memory leaks
      
      // Save log asynchronously to avoid blocking the HTTP response
      setImmediate(async () => {
        try {
          const diff = {
            request_payload: payloadBefore,
            response_payload: body,
          };
          
          // Insert into legacy audit_logs
          await db.query(
            `INSERT INTO audit_logs (admin_id, action, resource, resource_id, diff, ip_address, user_agent)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [
              adminId,
              action,
              resource,
              resourceId,
              JSON.stringify(diff),
              req.ip,
              req.get('user-agent') || null,
            ],
          ).catch(() => {});

          // Insert into immutable audit_log table with before/after values for compliance
          await db.query(
            `INSERT INTO audit_log (user_id, action, resource, resource_id, old_value, new_value, ip_address, user_agent)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [
              adminId,
              action,
              resource,
              resourceId,
              payloadBefore ? JSON.stringify(payloadBefore) : null,
              body ? JSON.stringify(body) : null,
              req.ip,
              req.get('user-agent') || null,
            ],
          ).catch((err) => {
            console.error('[Audit Log] Failed to insert into audit_log:', err);
          });
        } catch (error) {
          console.error('[Audit Log] Failed to save admin audit log event:', error);
        }
      });
      
      return res.json(body);
    };

    next();
  };
};