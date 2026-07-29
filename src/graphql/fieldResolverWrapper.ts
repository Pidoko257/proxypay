import type { GraphQLContext } from "./context";
import {
  extractFieldContext,
  maskSensitiveField,
  maskStellarAddress,
  maskPhoneNumber,
  FieldPermission,
  isSensitiveField,
  hasFieldPermission,
} from "./fieldAuthorization";

/**
 * Higher-order function to wrap field resolvers with authorization checks
 * 
 * @param resolver - The original resolver function
 * @param permission - The required permission to access this field
 * @param options - Configuration for the authorization behavior
 * @returns Wrapped resolver with authorization check
 */
export function withFieldAuthorization<T = any>(
  resolver: (
    parent: any,
    args: any,
    ctx: GraphQLContext,
    info?: any,
  ) => T | Promise<T>,
  permission: FieldPermission,
  options?: {
    requireOwnership?: boolean;
    maskFn?: (
      value: T,
      context: any,
      permission: FieldPermission,
    ) => T | null;
  },
) {
  return async (
    parent: any,
    args: any,
    ctx: GraphQLContext,
    info?: any,
  ): Promise<T | null> => {
    // Extract field authorization context
    const fieldContext = extractFieldContext(ctx, parent);

    // Check if user has permission
    const authorized = hasFieldPermission(
      fieldContext,
      permission,
      options?.requireOwnership ?? false,
    );

    if (!authorized) {
      // If a custom mask function is provided, use it
      if (options?.maskFn) {
        const value = await resolver(parent, args, ctx, info);
        return options.maskFn(value as T, fieldContext, permission);
      }
      // Otherwise return null for unauthorized access
      return null;
    }

    // User is authorized, call the original resolver
    return resolver(parent, args, ctx, info);
  };
}

/**
 * Wrapper for string-based sensitive fields (like phone numbers and addresses)
 * Applies masking instead of returning null
 */
export function withFieldMasking(
  resolver: (
    parent: any,
    args: any,
    ctx: GraphQLContext,
    info?: any,
  ) => string | Promise<string>,
  permission: FieldPermission,
  maskingStrategy: "stellar" | "phone" | "generic",
  options?: {
    requireOwnership?: boolean;
  },
) {
  return async (
    parent: any,
    args: any,
    ctx: GraphQLContext,
    info?: any,
  ): Promise<string | null> => {
    const value = await resolver(parent, args, ctx, info);
    const fieldContext = extractFieldContext(ctx, parent);

    // Apply appropriate masking strategy
    if (maskingStrategy === "stellar") {
      return maskStellarAddress(
        value,
        fieldContext,
        options?.requireOwnership ?? false,
      );
    }

    if (maskingStrategy === "phone") {
      return maskPhoneNumber(
        value,
        fieldContext,
        options?.requireOwnership ?? false,
      );
    }

    // Generic masking: if not authorized, return null
    return maskSensitiveField(
      value,
      fieldContext,
      permission,
      null,
      options?.requireOwnership ?? false,
    );
  };
}

/**
 * Wrapper for array fields containing sensitive data
 * Filters array elements based on authorization
 */
export function withFieldArrayAuthorization<T extends { userId?: string }>(
  resolver: (
    parent: any,
    args: any,
    ctx: GraphQLContext,
    info?: any,
  ) => T[] | Promise<T[]>,
  permission: FieldPermission,
  options?: {
    requireOwnership?: boolean;
  },
) {
  return async (
    parent: any,
    args: any,
    ctx: GraphQLContext,
    info?: any,
  ): Promise<T[]> => {
    const items = await resolver(parent, args, ctx, info);
    const fieldContext = extractFieldContext(ctx, parent);

    // Filter array items based on authorization
    return items.filter((item) => {
      const itemContext = {
        ...fieldContext,
        resourceOwnerId: item.userId,
      };
      
      return hasFieldPermission(
        itemContext,
        permission,
        options?.requireOwnership ?? false,
      );
    });
  };
}

/**
 * Wrapper for nested object fields
 * Recursively sanitizes nested sensitive fields
 */
export function withNestedFieldAuthorization<T extends Record<string, any>>(
  resolver: (
    parent: any,
    args: any,
    ctx: GraphQLContext,
    info?: any,
  ) => T | Promise<T>,
  sensitiveFieldPermissions: Record<string, FieldPermission>,
  options?: {
    requireOwnership?: boolean;
  },
) {
  return async (
    parent: any,
    args: any,
    ctx: GraphQLContext,
    info?: any,
  ): Promise<T | null> => {
    const result = await resolver(parent, args, ctx, info);
    const fieldContext = extractFieldContext(ctx, parent);

    // Create a copy of the result with sensitive fields redacted
    const sanitized = { ...result };

    for (const [fieldName, permission] of Object.entries(
      sensitiveFieldPermissions,
    )) {
      if (fieldName in sanitized) {
        const authorized = hasFieldPermission(
          fieldContext,
          permission,
          options?.requireOwnership ?? false,
        );

        if (!authorized) {
          sanitized[fieldName] = null;
        }
      }
    }

    return sanitized;
  };
}

/**
 * Utility to create a field authorization context for batch processing
 * Used when resolving multiple fields at once
 */
export function createFieldAuthorizationContext(
  ctx: GraphQLContext,
  parent: any,
  resourceOwnerId?: string,
) {
  return {
    userId: ctx.auth.subject,
    userRole: ctx.userRole,
    resourceOwnerId: resourceOwnerId || parent?.userId,
    ctx,
    parent,
  };
}

/**
 * Batch check multiple fields for authorization
 * Returns object with boolean values indicating access to each field
 */
export function checkFieldAccessBatch(
  fieldPermissions: Record<string, FieldPermission>,
  context: any,
): Record<string, boolean> {
  const result: Record<string, boolean> = {};

  for (const [fieldName, permission] of Object.entries(fieldPermissions)) {
    result[fieldName] = hasFieldPermission(
      {
        userId: context.userId,
        userRole: context.userRole,
        resourceOwnerId: context.resourceOwnerId,
      },
      permission,
      false,
    );
  }

  return result;
}
