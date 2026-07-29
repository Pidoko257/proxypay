import 'express';
import type { Logger } from 'pino';

declare global {
  namespace Express {
    interface User {
      id?: string;
      role?: string;
      ssoUserId?: string;
      providerId?: string;
    }

    interface Request {
      jwtUser?: { userId?: string; role?: string };
      user?: User;
      isNewDevice?: boolean;
      twoFactorVerified?: boolean;
      clientIp?: string;
      geoLocation?: unknown;
      userRole?: string;
      locale?: string;
      /** Correlation ID propagated from upstream or generated fresh per-request. */
      correlationId?: string;
      /** Child logger pre-bound with the request's correlation_id. */
      log?: Logger;
    }
  }
}

export {};
