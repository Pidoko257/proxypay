import { GraphQLError } from "graphql";
import type { GraphQLContext } from "./context";

/**
 * Field-level authorization utility for protecting sensitive GraphQL fields
 * Provides permission checks for vault addresses, provider keys, and other sensitive data
 */

export interface FieldAuthContext {
  userId?: string;
  userRole?: string;
  resourceOwnerId?: string;
}

/**
 * Field-level permissions that can be checked
 */
export enum FieldPermission {
  // Vault permissions
  VIEW_VAULT_ADDRESS = "view:vault:address",
  VIEW_VAULT_SECRETS = "view:vault:secrets",
  
  // Provider permissions
  VIEW_PROVIDER_KEY = "view:provider:key",
  VIEW_PROVIDER_SECRET = "view:provider:secret",
  
  // Transaction permissions
  VIEW_TRANSACTION_SENSITIVE = "view:transaction:sensitive",
  VIEW_TRANSACTION_PHONE = "view:transaction:phone",
  VIEW_TRANSACTION_DETAILS = "view:transaction:details",
  
  // Dispute permissions
  VIEW_DISPUTE_DETAILS = "view:dispute:details",
  VIEW_DISPUTE_NOTES = "view:dispute:notes",
}

/**
 * Role-based field permissions mapping
 * Defines which roles can access which sensitive fields
 */
const roleFieldPermissions: Record<string, FieldPermission[]> = {
  admin: [
    FieldPermission.VIEW_VAULT_ADDRESS,
    FieldPermission.VIEW_VAULT_SECRETS,
    FieldPermission.VIEW_PROVIDER_KEY,
    FieldPermission.VIEW_PROVIDER_SECRET,
    FieldPermission.VIEW_TRANSACTION_SENSITIVE,
    FieldPermission.VIEW_TRANSACTION_PHONE,
    FieldPermission.VIEW_TRANSACTION_DETAILS,
    FieldPermission.VIEW_DISPUTE_DETAILS,
    FieldPermission.VIEW_DISPUTE_NOTES,
  ],
  compliance: [
    FieldPermission.VIEW_VAULT_ADDRESS,
    FieldPermission.VIEW_TRANSACTION_SENSITIVE,
    FieldPermission.VIEW_TRANSACTION_PHONE,
    FieldPermission.VIEW_TRANSACTION_DETAILS,
    FieldPermission.VIEW_DISPUTE_DETAILS,
    FieldPermission.VIEW_DISPUTE_NOTES,
  ],
  support: [
    FieldPermission.VIEW_TRANSACTION_PHONE,
    FieldPermission.VIEW_TRANSACTION_DETAILS,
    FieldPermission.VIEW_DISPUTE_DETAILS,
    FieldPermission.VIEW_DISPUTE_NOTES,
  ],
  user: [
    FieldPermission.VIEW_TRANSACTION_DETAILS,
  ],
};

/**
 * Check if a user has permission for a specific field based on role and ownership
 * 
 * @param context - Field authorization context (userId, userRole, resourceOwnerId)
 * @param permission - The permission to check
 * @param requireOwnership - If true, user must own the resource
 * @returns true if authorized, false otherwise
 */
export function hasFieldPermission(
  context: FieldAuthContext,
  permission: FieldPermission,
  requireOwnership: boolean = false,
): boolean {
  // No context = not authorized
  if (!context.userRole) {
    return false;
  }

  // Check ownership if required
  if (requireOwnership && context.userId !== context.resourceOwnerId) {
    return false;
  }

  // Get permissions for this role
  const permissions = roleFieldPermissions[context.userRole] || [];
  return permissions.includes(permission);
}

/**
 * Middleware to authorize field access and throw GraphQL error if unauthorized
 * 
 * @param context - Field authorization context
 * @param permission - The permission to check
 * @param fieldName - Name of the field (for error message)
 * @param requireOwnership - If true, user must own the resource
 * @throws GraphQLError if not authorized
 */
export function authorizeFieldAccess(
  context: FieldAuthContext,
  permission: FieldPermission,
  fieldName: string,
  requireOwnership: boolean = false,
): void {
  if (!hasFieldPermission(context, permission, requireOwnership)) {
    const reason = requireOwnership && context.userId !== context.resourceOwnerId
      ? "You do not have access to this resource"
      : `Insufficient permissions to access field "${fieldName}"`;
    
    throw new GraphQLError(reason, {
      extensions: {
        code: "FORBIDDEN",
        fieldName,
        permission,
      },
    });
  }
}

/**
 * Extract field context from GraphQL context and parent object
 * 
 * @param ctx - GraphQL context
 * @param parent - Parent object containing resource data
 * @param resourceOwnerId - ID of the resource owner
 * @returns Field authorization context
 */
export function extractFieldContext(
  ctx: GraphQLContext,
  parent: any,
  resourceOwnerId?: string,
): FieldAuthContext {
  return {
    userId: ctx.auth.subject || undefined,
    userRole: ctx.userRole || undefined,
    resourceOwnerId: resourceOwnerId || parent?.userId,
  };
}

/**
 * Mask/redact sensitive field value if user is not authorized
 * Returns masked version or null based on authorization
 * 
 * @param value - The sensitive value to potentially mask
 * @param context - Field authorization context
 * @param permission - The permission to check
 * @param maskValue - Value to return if not authorized (default: null)
 * @param requireOwnership - If true, user must own the resource
 * @returns Original value if authorized, maskValue otherwise
 */
export function maskSensitiveField<T>(
  value: T,
  context: FieldAuthContext,
  permission: FieldPermission,
  maskValue: any = null,
  requireOwnership: boolean = false,
): T | null {
  if (hasFieldPermission(context, permission, requireOwnership)) {
    return value;
  }
  return maskValue;
}

/**
 * Mask stellar address for unauthorized users
 * Shows first 4 and last 4 characters
 */
export function maskStellarAddress(
  address: string,
  context: FieldAuthContext,
  requireOwnership: boolean = false,
): string | null {
  if (hasFieldPermission(context, FieldPermission.VIEW_VAULT_ADDRESS, requireOwnership)) {
    return address;
  }
  
  if (!address || address.length < 8) {
    return null;
  }
  
  return `${address.substring(0, 4)}...${address.substring(address.length - 4)}`;
}

/**
 * Mask phone number for unauthorized users
 * Shows last 4 digits only
 */
export function maskPhoneNumber(
  phone: string,
  context: FieldAuthContext,
  requireOwnership: boolean = false,
): string | null {
  if (hasFieldPermission(context, FieldPermission.VIEW_TRANSACTION_PHONE, requireOwnership)) {
    return phone;
  }
  
  if (!phone || phone.length < 4) {
    return null;
  }
  
  return `***-****-${phone.substring(phone.length - 4)}`;
}

/**
 * Get context user role from GraphQL context
 * Extracts role from RBAC system if available
 */
export async function getContextUserRole(ctx: GraphQLContext): Promise<string | undefined> {
  // If role already populated, return it
  if (ctx.userRole) {
    return ctx.userRole;
  }
  
  // If no authenticated user, return undefined
  if (!ctx.auth.subject) {
    return undefined;
  }
  
  // For future enhancement: fetch user role from database
  // For now, default to 'user' role for authenticated users
  return "user";
}

/**
 * Check if field requires authorization based on field name
 * Used to determine which fields need field-level auth checks
 */
export function isSensitiveField(fieldName: string): boolean {
  const sensitiveFields = [
    // Vault fields
    "vaultAddress",
    "vaultSecret",
    "providerKey",
    "providerSecret",
    
    // Transaction sensitive fields
    "phoneNumber",
    "stellarAddress",
    "providerReference",
    
    // Dispute sensitive fields
    "reportedBy",
    "investigationNotes",
  ];
  
  return sensitiveFields.includes(fieldName);
}
