# Field-Level Authorization Quick Start

## 1-Minute Overview

Add authorization to your GraphQL fields in 3 ways:

### Option A: Use Directives (Recommended for New Code)

```graphql
type Vault {
  id: ID!
  vaultAddress: String 
    @auth(requires: "VIEW_VAULT_ADDRESS", requireOwnership: true)
  vaultSecret: String 
    @auth(requires: "VIEW_VAULT_SECRETS", requireOwnership: true)
}

type Transaction {
  id: ID!
  phoneNumber: String! 
    @mask(strategy: "PHONE", requires: "VIEW_TRANSACTION_PHONE")
  stellarAddress: String! 
    @mask(strategy: "STELLAR", requires: "VIEW_VAULT_ADDRESS")
}
```

### Option B: Wrap Resolvers

```typescript
import { withFieldAuthorization, withFieldMasking } from './fieldResolverWrapper';
import { FieldPermission } from './fieldAuthorization';

const resolvers = {
  Vault: {
    vaultAddress: withFieldMasking(
      resolver,
      FieldPermission.VIEW_VAULT_ADDRESS,
      "stellar",
      { requireOwnership: true }
    ),
  },
};
```

### Option C: Manual Checks

```typescript
import { hasFieldPermission, extractFieldContext, authorizeFieldAccess } from './fieldAuthorization';

const resolver = async (parent, args, ctx) => {
  const fieldContext = extractFieldContext(ctx, parent);
  authorizeFieldAccess(
    fieldContext,
    FieldPermission.VIEW_VAULT_ADDRESS,
    "vaultAddress",
    true // requireOwnership
  );
  
  return parent.vaultAddress;
};
```

## Available Permissions

```typescript
// Vault access
VIEW_VAULT_ADDRESS       // Access blockchain address
VIEW_VAULT_SECRETS       // Access encryption keys

// Provider access
VIEW_PROVIDER_KEY        // Access API key names
VIEW_PROVIDER_SECRET     // Access API secrets

// Transaction access
VIEW_TRANSACTION_SENSITIVE  // Provider reference numbers
VIEW_TRANSACTION_PHONE      // User phone numbers
VIEW_TRANSACTION_DETAILS    // Basic transaction info

// Dispute access
VIEW_DISPUTE_DETAILS     // Dispute resolutions
VIEW_DISPUTE_NOTES       // Investigation notes
```

## Role Permissions

| Role | Can View |
|------|----------|
| **admin** | Everything |
| **compliance** | Vault addresses, transaction details, dispute info |
| **support** | Transaction phone, dispute info |
| **user** | Their own transaction details |

## Masking Strategies

- **"phone"** → `***-****-7890` (last 4 digits visible)
- **"stellar"** → `GBBD...GHVM` (first 4 & last 4 chars visible)
- **"generic"** → `null` (returns null for unauthorized)

## Examples

### Protect Vault Address

```typescript
// Show masked address to unauthorized users
vaultAddress: withFieldMasking(
  (parent) => parent.vaultAddress,
  FieldPermission.VIEW_VAULT_ADDRESS,
  "stellar"
)
```

### Protect Phone Number

```typescript
// Mask phone unless user has permission
phoneNumber: withFieldMasking(
  (parent) => parent.phoneNumber,
  FieldPermission.VIEW_TRANSACTION_PHONE,
  "phone"
)
```

### Protect Secret Key

```typescript
// Return null if not authorized
vaultSecret: withFieldAuthorization(
  (parent) => parent.vaultSecret,
  FieldPermission.VIEW_VAULT_SECRETS,
  { requireOwnership: true }
)
```

### Batch Check Multiple Fields

```typescript
import { checkFieldAccessBatch } from './fieldResolverWrapper';

const permissions = checkFieldAccessBatch({
  vaultAddress: FieldPermission.VIEW_VAULT_ADDRESS,
  vaultSecret: FieldPermission.VIEW_VAULT_SECRETS,
  transactionPhone: FieldPermission.VIEW_TRANSACTION_PHONE,
}, fieldContext);

// permissions = {
//   vaultAddress: false,
//   vaultSecret: false,
//   transactionPhone: true
// }
```

## Ownership Enforcement

Some fields should only be visible to the resource owner:

```typescript
// Only owner or admin can see their vault secret
withFieldAuthorization(
  resolver,
  FieldPermission.VIEW_VAULT_SECRETS,
  { requireOwnership: true }  // ← Enforces ownership check
)
```

When enabled:
- ✅ Owner can always access their resource
- ✅ Admin can access any resource
- ❌ Other users get null/masked value

## Testing

```bash
# Run authorization tests
npm test -- src/graphql/__tests__/fieldAuthorization.test.ts

# Run resolver wrapper tests  
npm test -- src/graphql/__tests__/fieldResolverWrapper.test.ts
```

## Integration Checklist

- [ ] Update GraphQL context building (already done in context.ts)
- [ ] Add directives to schema or wrap resolvers
- [ ] Test field access as admin/compliance/support/user
- [ ] Verify masking works as expected
- [ ] Check ownership enforcement for sensitive fields
- [ ] Monitor GraphQL errors for authorization denials
- [ ] Document which roles can access which fields

## Common Patterns

### User-Owned Resource (e.g., Vault)

```typescript
// Only owner can see - return null if not owner
withFieldAuthorization(
  resolver,
  FieldPermission.VIEW_VAULT_ADDRESS,
  { requireOwnership: true }
)
```

### Compliance-Only Data (e.g., Phone Numbers)

```typescript
// Mask for non-compliance users
withFieldMasking(
  resolver,
  FieldPermission.VIEW_TRANSACTION_PHONE,
  "phone"
)
```

### Admin-Sensitive Data (e.g., API Keys)

```typescript
// Hidden from all except admin
withFieldAuthorization(
  resolver,
  FieldPermission.VIEW_PROVIDER_SECRET
  // No requireOwnership - role-based only
)
```

## Debugging

Enable verbose logging:

```typescript
// Check if user has permission
const has = hasFieldPermission(fieldContext, FieldPermission.VIEW_VAULT_ADDRESS);
console.log('Has permission:', has);

// Get all field permissions at once
const batch = checkFieldAccessBatch({
  vault: FieldPermission.VIEW_VAULT_ADDRESS,
  provider: FieldPermission.VIEW_PROVIDER_SECRET,
}, fieldContext);
console.log('Batch permissions:', batch);
```

## Full Example

```typescript
// schema.ts
export const typeDefs = gql`
  type Vault {
    id: ID!
    name: String!
    balance: String!
    vaultAddress: String @mask(strategy: "STELLAR", requires: "VIEW_VAULT_ADDRESS")
    vaultSecret: String @auth(requires: "VIEW_VAULT_SECRETS", requireOwnership: true)
  }
`;

// resolvers.ts
import { withFieldMasking, withFieldAuthorization } from './fieldResolverWrapper';
import { FieldPermission } from './fieldAuthorization';

export const resolvers = {
  Vault: {
    vaultAddress: withFieldMasking(
      (parent) => parent.address,
      FieldPermission.VIEW_VAULT_ADDRESS,
      "stellar"
    ),
    vaultSecret: withFieldAuthorization(
      (parent) => parent.secret,
      FieldPermission.VIEW_VAULT_SECRETS,
      { requireOwnership: true }
    ),
  },
};

// server.ts
import { ApolloServer } from 'apollo-server-express';
import { buildGraphqlContext } from './context';

const server = new ApolloServer({
  typeDefs,
  resolvers,
  context: async ({ req }) => buildGraphqlContext(req),  // ← Async for role loading
});
```

## Need More Info?

- See `FIELD_AUTHORIZATION.md` for complete documentation
- Check test files for usage examples
- Review schemaWithAuth.ts for real-world patterns

---

**Ready to add authorization to your fields? Start with Option A (directives) for new code, or Option B (wrappers) for existing resolvers.**
