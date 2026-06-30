# OpenAPI Spec Auto-Generation

## Summary

Automates the generation, validation, and deployment of the OpenAPI 3.0 specification for the ProxyPay API. The spec is generated from Zod schemas and route definitions during the CI build, eliminating manual maintenance and ensuring the documentation is always accurate and in sync with the implementation.

## Changes

### New Scripts
- **`scripts/generate-openapi-spec.ts`** — Generates the OpenAPI 3.0.3 specification from Zod schemas and path registrations at build time, writing it to `docs/openapi.json`
- **`scripts/upload-openapi-spec.ts`** — Uploads the generated spec to S3 for the Redoc-powered documentation portal

### CI/CD Integration
- **`ci.yml`** — Enhanced with three new steps in the build job:
  1. `generate:spec` — Generate the spec from source
  2. `validate:spec` — Validate against the OpenAPI 3.0 standard
  3. `check:spec` — Fail the build if the generated spec differs from the committed spec, enforcing that developers commit updated spec files with their changes
  4. Uploads the generated spec as a build artifact
- **`openapi-spec.yml`** — New workflow that generates and uploads the spec to S3 on pushes to main and on releases, powering the Redoc documentation portal

### npm Scripts
- `generate:spec` — Generate the OpenAPI spec from Zod schemas
- `validate:spec` — Validate the spec against OpenAPI 3.0 (via swagger-cli)
- `check:spec` — Generate, validate, and diff — fails if committed spec is stale
- `upload:spec` — Upload the spec to S3

### Generated Artifact
- **`docs/openapi.json`** — The committed OpenAPI spec, always kept in sync by the `check:spec` CI gate

## Benefits
- **Always accurate** — Spec is generated from the source of truth (Zod schemas), eliminating drift
- **CI-enforced** — Build fails if the spec is not updated alongside code changes
- **Self-documenting** — Developers see spec changes as part of their PR diff
- **Portal-ready** — Spec is automatically deployed to S3 for Redoc documentation

closes #111
