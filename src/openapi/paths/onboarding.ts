/**
 * OpenAPI path registrations for /api/onboarding/*
 */

import { registry } from '../registry';
import {
  OnboardingAccountRequestSchema,
  OnboardingAccountResponseSchema,
  OnboardingBusinessRequestSchema,
  OnboardingBusinessResponseSchema,
  OnboardingUseCaseRequestSchema,
  OnboardingUseCaseResponseSchema,
  OnboardingStatusResponseSchema,
} from '../schemas/onboarding';
import { ErrorResponseSchema } from '../schemas/common';

const TAG = 'Onboarding';
const SECURITY = [{ bearerAuth: [] }];

// ── POST /api/onboarding/account ────────────────────────────────────────────

registry.registerPath({
  method: 'post',
  path: '/api/onboarding/account',
  tags: [TAG],
  summary: 'Create developer account and organization (Step 1)',
  description:
    'First step of the multi-step developer registration flow. ' +
    'Creates a new user account and organization, then returns a JWT for ' +
    'subsequent authenticated steps.',
  request: {
    body: {
      content: { 'application/json': { schema: OnboardingAccountRequestSchema } },
      required: true,
    },
  },
  responses: {
    201: {
      description: 'Account created successfully',
      content: { 'application/json': { schema: OnboardingAccountResponseSchema } },
    },
    400: { description: 'Validation error', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Internal server error', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

// ── PATCH /api/onboarding/business ──────────────────────────────────────────

registry.registerPath({
  method: 'patch',
  path: '/api/onboarding/business',
  tags: [TAG],
  summary: 'Update business information (Step 2)',
  description:
    'Second step of the developer onboarding flow. ' +
    'Updates the organization with business details such as name, type, ' +
    'registration number, and address. Requires a valid JWT from Step 1.',
  security: SECURITY,
  request: {
    body: {
      content: { 'application/json': { schema: OnboardingBusinessRequestSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      description: 'Business information updated successfully',
      content: { 'application/json': { schema: OnboardingBusinessResponseSchema } },
    },
    400: { description: 'Validation error or step 1 not completed', content: { 'application/json': { schema: ErrorResponseSchema } } },
    401: { description: 'Unauthorized — missing or invalid JWT', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Internal server error', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

// ── PATCH /api/onboarding/use-case ──────────────────────────────────────────

registry.registerPath({
  method: 'patch',
  path: '/api/onboarding/use-case',
  tags: [TAG],
  summary: 'Set use cases (Step 3)',
  description:
    'Third step of the developer onboarding flow. ' +
    'Selects one or more predefined use cases for the integration. ' +
    'Requires Step 2 to be completed. Valid values: payments, marketplace, ' +
    'remittances, charity, payroll, other.',
  security: SECURITY,
  request: {
    body: {
      content: { 'application/json': { schema: OnboardingUseCaseRequestSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      description: 'Use cases updated successfully',
      content: { 'application/json': { schema: OnboardingUseCaseResponseSchema } },
    },
    400: { description: 'Validation error or previous step not completed', content: { 'application/json': { schema: ErrorResponseSchema } } },
    401: { description: 'Unauthorized — missing or invalid JWT', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Internal server error', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

// ── GET /api/onboarding/status ──────────────────────────────────────────────

registry.registerPath({
  method: 'get',
  path: '/api/onboarding/status',
  tags: [TAG],
  summary: 'Get onboarding progress status',
  description:
    'Returns the current onboarding step and per-step completion flags. ' +
    'Step 0 means onboarding has not started. Step 4 with completed=true ' +
    'means all steps are done.',
  security: SECURITY,
  responses: {
    200: {
      description: 'Current onboarding status',
      content: { 'application/json': { schema: OnboardingStatusResponseSchema } },
    },
    401: { description: 'Unauthorized — missing or invalid JWT', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Internal server error', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});
