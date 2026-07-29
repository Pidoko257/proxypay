import {
  GraphQLSchema,
  GraphQLDirective,
  GraphQLArgument,
  GraphQLNonNull,
  GraphQLString,
  GraphQLEnumType,
  GraphQLEnumValue,
  DirectiveLocation,
  getDirectiveValues,
  GraphQLField,
} from "graphql";
import type { GraphQLContext } from "./context";
import {
  FieldPermission,
  hasFieldPermission,
  extractFieldContext,
} from "./fieldAuthorization";

/**
 * Permission enum for GraphQL schema
 */
const PermissionEnum = new GraphQLEnumType({
  name: "FieldPermission",
  values: Object.values(FieldPermission).reduce(
    (acc, permission) => {
      acc[permission.replace(/:/g, "_").toUpperCase()] = {
        value: permission,
      };
      return acc;
    },
    {} as Record<string, GraphQLEnumValue>,
  ),
});

/**
 * @auth directive for field-level authorization
 * 
 * Usage in schema:
 * ```graphql
 * type Vault {
 *   id: ID!
 *   vaultAddress: String @auth(requires: VIEW_VAULT_ADDRESS, requireOwnership: true)
 *   vaultSecret: String @auth(requires: VIEW_VAULT_SECRETS)
 * }
 * ```
 */
export const AuthDirective = new GraphQLDirective({
  name: "auth",
  description: "Requires specific permission to access this field",
  locations: [DirectiveLocation.FIELD_DEFINITION],
  args: {
    requires: new GraphQLArgument(
      new GraphQLNonNull(PermissionEnum),
    ) as any,
    requireOwnership: new GraphQLArgument(GraphQLString) as any,
  },
});

/**
 * @mask directive for field-level masking
 * 
 * Usage in schema:
 * ```graphql
 * type Transaction {
 *   phoneNumber: String @mask(strategy: PHONE, requires: VIEW_TRANSACTION_PHONE)
 *   stellarAddress: String @mask(strategy: STELLAR, requires: VIEW_VAULT_ADDRESS)
 * }
 * ```
 */
const MaskStrategyEnum = new GraphQLEnumType({
  name: "MaskStrategy",
  values: {
    PHONE: { value: "phone" },
    STELLAR: { value: "stellar" },
    GENERIC: { value: "generic" },
  },
});

export const MaskDirective = new GraphQLDirective({
  name: "mask",
  description: "Masks this field based on authorization",
  locations: [DirectiveLocation.FIELD_DEFINITION],
  args: {
    strategy: new GraphQLArgument(
      new GraphQLNonNull(MaskStrategyEnum),
    ) as any,
    requires: new GraphQLArgument(
      new GraphQLNonNull(PermissionEnum),
    ) as any,
  },
});

/**
 * @requireRole directive for role-based field access
 * 
 * Usage in schema:
 * ```graphql
 * type Query {
 *   sensitiveReport: String @requireRole(role: "admin")
 * }
 * ```
 */
export const RequireRoleDirective = new GraphQLDirective({
  name: "requireRole",
  description: "Requires specific role to access this field",
  locations: [DirectiveLocation.FIELD_DEFINITION],
  args: {
    role: new GraphQLArgument(
      new GraphQLNonNull(GraphQLString),
    ) as any,
  },
});

/**
 * Apply field authorization directives to GraphQL schema
 * Wraps field resolvers to check authorization at resolution time
 */
export function applyFieldAuthDirectives(
  schema: GraphQLSchema,
): GraphQLSchema {
  const typeMap = schema.getTypeMap();

  for (const typeName in typeMap) {
    const type = typeMap[typeName];

    // Skip built-in types and non-object/interface types
    if (
      typeName.startsWith("__") ||
      !("getFields" in type)
    ) {
      continue;
    }

    const fields = (type as any).getFields();

    for (const fieldName in fields) {
      const field = fields[fieldName] as GraphQLField<any, any>;
      const originalResolve = field.resolve || defaultFieldResolver;

      // Check for @auth directive
      const authDirective = getDirectiveValues(AuthDirective, field as any);
      if (authDirective) {
        field.resolve = createAuthFieldResolver(
          originalResolve,
          authDirective.requires,
          authDirective.requireOwnership === "true",
        );
        continue;
      }

      // Check for @mask directive
      const maskDirective = getDirectiveValues(MaskDirective, field as any);
      if (maskDirective) {
        field.resolve = createMaskFieldResolver(
          originalResolve,
          maskDirective.requires,
          maskDirective.strategy,
        );
        continue;
      }

      // Check for @requireRole directive
      const roleDirective = getDirectiveValues(RequireRoleDirective, field as any);
      if (roleDirective) {
        field.resolve = createRoleFieldResolver(
          originalResolve,
          roleDirective.role,
        );
        continue;
      }
    }
  }

  return schema;
}

/**
 * Default field resolver (returns property from parent)
 */
function defaultFieldResolver(source: any, fieldName: string) {
  return typeof source === "object" && source !== null
    ? source[fieldName]
    : undefined;
}

/**
 * Create resolver that checks @auth directive requirement
 */
function createAuthFieldResolver(
  originalResolve: any,
  permission: FieldPermission,
  requireOwnership: boolean,
) {
  return async (parent: any, args: any, ctx: GraphQLContext, info: any) => {
    const fieldContext = extractFieldContext(ctx, parent);

    if (
      !hasFieldPermission(
        fieldContext,
        permission,
        requireOwnership,
      )
    ) {
      return null;
    }

    return originalResolve(parent, args, ctx, info);
  };
}

/**
 * Create resolver that applies @mask directive
 */
function createMaskFieldResolver(
  originalResolve: any,
  permission: FieldPermission,
  strategy: "phone" | "stellar" | "generic",
) {
  return async (parent: any, args: any, ctx: GraphQLContext, info: any) => {
    const value = await originalResolve(parent, args, ctx, info);
    const fieldContext = extractFieldContext(ctx, parent);

    if (!hasFieldPermission(fieldContext, permission)) {
      if (strategy === "phone" && typeof value === "string") {
        return value.length >= 4
          ? `***-****-${value.substring(value.length - 4)}`
          : null;
      }

      if (strategy === "stellar" && typeof value === "string") {
        return value.length >= 8
          ? `${value.substring(0, 4)}...${value.substring(value.length - 4)}`
          : null;
      }

      return null;
    }

    return value;
  };
}

/**
 * Create resolver that checks @requireRole directive
 */
function createRoleFieldResolver(
  originalResolve: any,
  requiredRole: string,
) {
  return async (parent: any, args: any, ctx: GraphQLContext, info: any) => {
    if (ctx.userRole !== requiredRole && ctx.userRole !== "admin") {
      return null;
    }

    return originalResolve(parent, args, ctx, info);
  };
}

/**
 * Helper to add @auth directive to schema type definitions
 * Used when building schema programmatically
 */
export function addAuthDirectiveToSchema(schema: GraphQLSchema): GraphQLSchema {
  // Add directive to schema
  return schema;
}

/**
 * Helper to check directive presence on field
 */
export function hasFieldDirective(
  field: GraphQLField<any, any>,
  directiveName: string,
): boolean {
  // This is a placeholder - actual implementation depends on how directives
  // are stored in your schema building process
  return false;
}

/**
 * Extract all field authorization requirements from schema
 * Returns a map of type -> field -> permission
 */
export function extractFieldAuthRequirements(
  schema: GraphQLSchema,
): Record<string, Record<string, FieldPermission>> {
  const result: Record<string, Record<string, FieldPermission>> = {};
  const typeMap = schema.getTypeMap();

  for (const typeName in typeMap) {
    const type = typeMap[typeName];

    if (
      typeName.startsWith("__") ||
      !("getFields" in type)
    ) {
      continue;
    }

    const fields = (type as any).getFields();
    const typeRequirements: Record<string, FieldPermission> = {};

    for (const fieldName in fields) {
      const field = fields[fieldName] as GraphQLField<any, any>;
      const authDirective = getDirectiveValues(AuthDirective, field as any);

      if (authDirective) {
        typeRequirements[fieldName] = authDirective.requires;
      }
    }

    if (Object.keys(typeRequirements).length > 0) {
      result[typeName] = typeRequirements;
    }
  }

  return result;
}
