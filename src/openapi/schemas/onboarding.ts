/**
 * OpenAPI schemas for /api/onboarding/*
 */

import { z } from 'zod';
import { registry } from '../registry';

// ─── Use case enum ──────────────────────────────────────────────────────────

export const UseCaseEnumSchema = registry.register(
  'OnboardingUseCase',
  z
    .enum(['payments', 'marketplace', 'remittances', 'charity', 'payroll', 'other'])
    .openapi('OnboardingUseCase', {
      description: 'Predefined use case for the developer integration',
      example: 'payments',
    }),
);

// ─── Step 1: Create account request ─────────────────────────────────────────

export const OnboardingAccountRequestSchema = registry.register(
  'OnboardingAccountRequest',
  z
    .object({
      email: z.string().email().openapi({ example: 'dev@example.com' }),
      password: z
        .string()
        .min(12)
        .openapi({ example: 'Str0ng!Pass#12', description: 'Min 12 chars, uppercase, lowercase, number, special character' }),
      phone_number: z.string().min(1).openapi({ example: '+237670000000' }),
      org_name: z.string().min(1).max(255).openapi({ example: 'Acme Labs' }),
    })
    .openapi('OnboardingAccountRequest'),
);

// ─── Step 1: Create account response ────────────────────────────────────────

export const OnboardingAccountResponseSchema = registry.register(
  'OnboardingAccountResponse',
  z
    .object({
      message: z.string().openapi({ example: 'Account created successfully' }),
      data: z.object({
        user: z.object({
          id: z.string().uuid().openapi({ example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' }),
          email: z.string().email().openapi({ example: 'dev@example.com' }),
        }),
        organization: z.object({
          id: z.string().uuid().openapi({ example: 'b2c3d4e5-f6a7-8901-bcde-f12345678901' }),
          name: z.string().openapi({ example: 'Acme Labs' }),
        }),
        token: z.string().openapi({ description: 'JWT token for authenticated requests' }),
      }),
    })
    .openapi('OnboardingAccountResponse'),
);

// ─── Step 2: Update business info request ───────────────────────────────────

export const OnboardingBusinessRequestSchema = registry.register(
  'OnboardingBusinessRequest',
  z
    .object({
      business_name: z.string().min(1).max(255).openapi({ example: 'Acme Labs Ltd' }),
      business_type: z.string().min(1).max(100).openapi({ example: 'startup' }),
      registration_number: z.string().max(100).optional().openapi({ example: 'RC-12345' }),
      tax_id: z.string().max(100).optional().openapi({ example: 'TAX-9999' }),
      address: z.string().optional().openapi({ example: '123 Tech Street' }),
      city: z.string().max(100).optional().openapi({ example: 'Douala' }),
      country: z.string().length(2).optional().openapi({ example: 'CM', description: 'ISO 3166-1 alpha-2' }),
      website: z.string().url().max(500).optional().openapi({ example: 'https://acme.example.com' }),
      industry: z.string().max(100).optional().openapi({ example: 'fintech' }),
    })
    .openapi('OnboardingBusinessRequest'),
);

// ─── Step 2: Update business info response ──────────────────────────────────

export const OnboardingBusinessResponseSchema = registry.register(
  'OnboardingBusinessResponse',
  z
    .object({
      message: z.string().openapi({ example: 'Business information updated successfully' }),
      data: z.object({
        organization: z.record(z.unknown()).openapi({ description: 'Updated organization object' }),
      }),
    })
    .openapi('OnboardingBusinessResponse'),
);

// ─── Step 3: Set use cases request ──────────────────────────────────────────

export const OnboardingUseCaseRequestSchema = registry.register(
  'OnboardingUseCaseRequest',
  z
    .object({
      use_cases: z
        .array(UseCaseEnumSchema)
        .min(1)
        .openapi({ example: ['payments', 'marketplace'], description: 'At least one use case is required' }),
    })
    .openapi('OnboardingUseCaseRequest'),
);

// ─── Step 3: Set use cases response ─────────────────────────────────────────

export const OnboardingUseCaseResponseSchema = registry.register(
  'OnboardingUseCaseResponse',
  z
    .object({
      message: z.string().openapi({ example: 'Use cases updated successfully' }),
      data: z.object({
        use_cases: z.array(UseCaseEnumSchema).openapi({ example: ['payments', 'marketplace'] }),
      }),
    })
    .openapi('OnboardingUseCaseResponse'),
);

// ─── Onboarding status response ─────────────────────────────────────────────

export const OnboardingStatusResponseSchema = registry.register(
  'OnboardingStatusResponse',
  z
    .object({
      data: z.object({
        current_step: z.number().int().min(0).max(4).openapi({ example: 2, description: 'Current onboarding step (0 = not started, 4 = complete)' }),
        completed: z.boolean().openapi({ example: false }),
        steps: z.object({
          account: z.boolean().openapi({ example: true, description: 'Step 1: Account creation' }),
          business: z.boolean().openapi({ example: true, description: 'Step 2: Business information' }),
          use_case: z.boolean().openapi({ example: false, description: 'Step 3: Use case selection' }),
          email_verification: z.boolean().openapi({ example: false, description: 'Step 4: Email verification' }),
        }),
        completed_at: z.string().datetime().nullable().openapi({ example: null }),
      }),
    })
    .openapi('OnboardingStatusResponse'),
);
