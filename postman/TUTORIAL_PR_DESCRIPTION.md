# Add Interactive API Tutorial for New Developers

## Summary

Adds a step-by-step Postman collection that walks new developers through the complete ProxyPay developer flow in under 30 minutes: **register → KYC → deposit → withdraw**.

## What's included

### New files in `postman/`

| File | Description |
|------|-------------|
| `developer_tutorial.postman_collection.json` | Main tutorial collection with 4 ordered steps + bonus section |
| `developer_tutorial.postman_environment.json` | Pre-configured environment with all tutorial variables |

## Tutorial structure

### Step 1 — Register & Authenticate (~5 min)
- `1.1` Login with phone number → JWT token auto-saved to environment
- `1.2` Verify token is valid
- `1.3` Get current user profile → `userId` + `stellarAddress` auto-saved

### Step 2 — KYC Verification (~8 min)
- `2.1` Create KYC applicant → `applicantId` auto-saved
- `2.2` Upload identity document (base64)
- `2.3` Start verification workflow → `workflowRunId` auto-saved
- `2.4` Poll KYC status until `basic` level confirmed

### Step 3 — Deposit (~5 min)
- `3.1` Deposit 500 XAF via MTN mobile money → `transactionId` auto-saved
- `3.2` Poll transaction status until `completed`

### Step 4 — Withdraw (~5 min)
- `4.1` Withdraw 200 XAF to mobile money → `withdrawTransactionId` auto-saved
- `4.2` Confirm withdrawal completed

### Bonus — Transaction History
- List all transactions with pagination

## How the tutorial meets acceptance criteria

- **Runnable**: Every request uses `{{variables}}` populated by the previous step's Tests script — zero manual copy-pasting required
- **Commented**: Every request has a `description` field explaining what it does, why, and what to expect; inline comments in request bodies explain each field
- **< 30 minutes**: 9 core requests across a linear flow; estimated 20 minutes including reading time
- **Environment variables auto-flow**: Login → token, profile → userId/stellarAddress, KYC → applicantId, transactions → transactionId — no friction between steps
- **Global test guards**: A collection-level test blocks on any 5xx error; per-step tests validate status codes and log helpful console messages

## Testing

1. Start the local server: `npm run dev`
2. Import `developer_tutorial.postman_collection.json` into Postman
3. Import `developer_tutorial.postman_environment.json` and select it as the active environment
4. Run the collection in order using the Postman Runner or manually step by step
5. All Tests should pass in the sandbox environment

closes #272
