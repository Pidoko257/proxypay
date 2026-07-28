import { auditContextMiddleware } from "./auditContext";

/**
 * Compatibility export for routes that used the former response interceptor.
 * Sensitive writes must use the transaction wrapper instead.
 */
export const auditInterceptor = (_db?: unknown) => auditContextMiddleware;
