# Pull Request Description

**Title:** `feat: implement strict GraphQL query complexity limiting`

### 📖 Summary
Implemented strict query complexity limiting on the Apollo server setup using `graphql-query-complexity`. This prevents malicious clients from constructing extremely complex nested queries that can crash the server.

### 🛠️ Changes
- Configured the `graphql-query-complexity` validation rule in Apollo Server.
- Enforced a maximum complexity of 500 points per request.
- Adjusted query complexity tests to match the new limit.

### ✅ Verification
- Verified validation rules in `src/graphql/server.ts`.
- Verified and updated query complexity tests in `src/tests/graphql-depth-complexity.test.ts`.
