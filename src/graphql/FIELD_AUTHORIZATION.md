# Field-Level Authorization for GraphQL

## Overview

This implementation adds **field-level authorization** to the GraphQL schema, restricting access to sensitive fields (vault addresses, provider keys, phone numbers, etc.) based on user roles and resource ownership.

## Architecture

### Components

1. **`fieldAuthorization.ts`** - Core permission checking logic
   - `FieldPermission` enum - defines all sensitive field permissions
   - Role-based permission mapping
   - Masking utilities for sensitive data

2. **`fieldResolverWrapper.ts`** - Higher-order functions for resolver authorization
   - `withFieldAuthorization()` - checks permissions, returns null if denied
   - `withFieldMasking()` - masks sensitive values instead of blocking
   - `withFieldArrayAuthorization()` - filters array items based on access
   - `checkFieldAccessBatch()` - batch permission checking

3. **`fieldAuthDirectives.ts`** - GraphQL directives for declarative auth
   - `@auth` directive - requires specific permission
   - `@mask` directive - masks field value instead of blocking
   - `@requireRole` directive - role-based field access

4. **`schemaWithAuth.ts`** - Extended schema with authorization directives
   - Vault fields (vaultAddress, vaultSecret, vaultTransactions)
   - Transaction fields (providerReference, phoneNumber, stellarAddress)
   - Dispute fields (reportedBy, resolution, notes)

5. **`context.ts`** - Enhanced GraphQL context
   - Extracts user role and permissions from database
   - Provides role information to resolvers and directives

## Permissions

### Field Permissions

```typescript
enum FieldPermission {
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
```

### Role-Based Access

| Role | Permissions |
|------|-------------|
| **admin** | All permissions (full access to all sensitive fields) |
| **compliance** | Vault address, transaction phone/details, dispute details/notes |
| **support** | Transaction phone, dispute details/notes |
| **user** | Transaction details (own resources only) |

## Usage

### Method 1: Directive-Based Authorization (Recommended)

Use `@auth` and `@mask` directives in your schema:

```graphql
type Vault {
  id: ID!
  userId: ID! @auth(requires: "VIEW_VAULT_SECRETS", requireOwnership: true)
  name: String!
  vaultAddress: String @auth(requires: "VIEW_VAULT_ADDRESS", requireOwnership: true)
  vaultSecret: String @auth(requires: "VIEW_VAULT_SECRETS", requireOwnership: true)
}

type Transaction {
  id: ID!
  phoneNumber: String! @mask(strategy: "PHONE", requires: "VIEW_TRANSACTION_PHONE")
  stellarAddress: String! @mask(strategy: "STELLAR", requires: "VIEW_VAULT_ADDRESS")
  providerReference: String! @auth(requires: "VIEW_TRANSACTION_SENSITIVE", requireOwnership: true)
}
```

### Method 2: HOF Wrapper-Based Authorization

Wrap resolvers with `withFieldAuthorization` or `withFieldMasking`:

```typescript
const resolvers = {
  Vault: {
    vaultAddress: withFieldMasking(
      async (parent) => parent.vaultAddress,
      FieldPermission.VIEW_VAULT_ADDRESS,
      "stellar",
      { requireOwnership: true }
    ),
    vaultSecret: withFieldAuthorization(
      async (parent) => parent.vaultSecret,
      FieldPermission.VIEW_VAULT_SECRETS,
      { requireOwnership: true }
    ),
  },
};
```

### Method 3: Manual Authorization Checks

Explicitly check permissions in resolvers:

```typescript
import { hasFieldPermission, extractFieldContext, FieldPermission } from '../fieldAuthorization';

const resolvers = {
  Query: {
    vault: async (_, { id }, ctx) => {
      const vault = await vaultModel.findById(id);
      
      const fieldContext = extractFieldContext(ctx, vault);
      if (!hasFieldPermission(fieldContext, FieldPermission.VIEW_VAULT_ADDRESS, true)) {
        throw new GraphQLError('Insufficient permissions');
      }
      
      return vault;
    },
  },
};
```

## Masking Strategies

### Phone Number Masking
- Authorized users: see full number (e.g., `1234567890`)
- Unauthorized users: see masked version (e.g., `***-****-7890`)

### Stellar Address Masking
- Authorized users: see full address (e.g., `GBBD47UZQ2...GHVM`)
- Unauthorized users: see masked version (e.g., `GBBD...GHVM`)

## Ownership Enforcement

Fields can require ownership verification:

```typescript
// Only users can see their own vault addresses
maskStellarAddress(address, fieldContext, requireOwnership=true)

// Only admins or owners can see their transactions
hasFieldPermission(fieldContext, FieldPermission.VIEW_TRANSACTION_DETAILS, requireOwnership=true)
```

When `requireOwnership=true`:
- Admin users bypass the check (can see any resource)
- Regular users only see their own resources
- Compliance/support roles follow their role permissions

## Testing

Comprehensive test suites are provided:

```bash
# Run field authorization tests
npm test -- src/graphql/__tests__/fieldAuthorization.test.ts

# Run field resolver wrapper tests
npm test -- src/graphql/__tests__/fieldResolverWrapper.test.ts
```

Test coverage includes:
- Role-based permission checking (admin, compliance, support, user)
- Ownership enforcement
- Field masking (phone, stellar, generic)
- Array filtering by permissions
- Batch permission checking
- Error handling

## Integration

### Applying Directives to Schema

```typescript
import { applyFieldAuthDirectives } from './fieldAuthDirectives';
import { makeExecutableSchema } from '@graphql-tools/schema';

const schema = makeExecutableSchema({
  typeDefs,
  resolvers,
});

// Apply field authorization directives
const authorizedSchema = applyFieldAuthDirectives(schema);

// Use in Apollo Server
const server = new ApolloServer({
  schema: authorizedSchema,
  context: async ({ req }) => buildGraphqlContext(req),
  // ...
});
```

### GraphQL Context Enhancement

The context automatically includes user role and permissions:

```typescript
// buildGraphqlContext fetches user role from database
const context: GraphQLContext = {
  auth: { authenticated: true, subject: "user-123" },
  userId: "user-123",
  userRole: "compliance", // Automatically loaded from DB
  userRoleInfo: {
    userId: "user-123",
    roleId: "role-456",
    roleName: "compliance",
    permissions: ["view:vault:address", "view:transaction:phone", ...],
  },
  // ... other context properties
};
```

## Security Considerations

1. **Field-level blocking** - Unauthorized requests receive `null` instead of the value
2. **Ownership verification** - Users can only access their own sensitive data
3. **Role isolation** - Each role has a limited permission set
4. **Masking fallback** - For certain fields, values are masked instead of blocked
5. **Admin bypass** - Admin users can access all fields for oversight

## Performance

- **Lazy loading** - User roles fetched on-demand once per request
- **Efficient checks** - Simple role lookup (O(1) permission array lookups)
- **Batching** - `checkFieldAccessBatch()` for multiple field checks at once
- **Caching** - Role info cached within request context

## Future Enhancements

1. **Dynamic permissions** - Load permissions from Casbin policy
2. **Attribute-based access** (ABAC) - Check attributes beyond role and ownership
3. **Field-level rate limiting** - Different limits for sensitive fields
4. **Audit logging** - Log access attempts to sensitive fields
5. **Granular masking** - Custom masking functions per field

## Examples

### Complete Example: Vault Queries

```graphql
query {
  userVaults {
    id
    name
    balance
    vaultAddress  # Only visible to owner, masked for others
    vaultSecret   # Only visible to owner or admin
    vaultTransactions {
      id
      amount
    }
  }
}
```

Response for regular user (sees their own vault):
```json
{
  "userVaults": [{
    "id": "vault-123",
    "name": "Savings",
    "balance": "1000.00",
    "vaultAddress": "GBBD...GHVM",  // Masked
    "vaultSecret": null,
    "vaultTransactions": [...]
  }]
}
```

Response for admin user:
```json
{
  "userVaults": [{
    "id": "vault-123",
    "name": "Savings",
    "balance": "1000.00",
    "vaultAddress": "GBBD47UZQ2EORUNUBXQMWGT4O2VQB5XRGYB3XQSHPEFQGKNL5BVJGHVM",  // Visible
    "vaultSecret": "sk_live_...",  // Visible
    "vaultTransactions": [...]
  }]
}
```

## Files Created

- `src/graphql/fieldAuthorization.ts` - Core permission logic (257 lines)
- `src/graphql/fieldResolverWrapper.ts` - Resolver wrappers (252 lines)
- `src/graphql/fieldAuthDirectives.ts` - GraphQL directives (319 lines)
- `src/graphql/schemaWithAuth.ts` - Authorized schema (262 lines)
- `src/graphql/__tests__/fieldAuthorization.test.ts` - Authorization tests (424 lines)
- `src/graphql/__tests__/fieldResolverWrapper.test.ts` - Wrapper tests (300 lines)

## Migration Path

1. **Phase 1**: Deploy field authorization utilities (no breaking changes)
2. **Phase 2**: Apply directives to non-critical fields
3. **Phase 3**: Migrate existing resolvers to use wrappers
4. **Phase 4**: Apply directives to all sensitive fields
5. **Phase 5**: Enable in production with monitoring

Each phase can be deployed independently without affecting existing queries.
