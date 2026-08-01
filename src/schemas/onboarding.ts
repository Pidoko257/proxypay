import { z } from "zod";

export const UseCaseEnum = z.enum([
  "payments",
  "marketplace",
  "remittances",
  "charity",
  "payroll",
  "other",
]);

export type UseCase = z.infer<typeof UseCaseEnum>;

export const step1Schema = z.object({
  email: z.string().email("Invalid email address"),
  password: z
    .string()
    .min(12, "Password must be at least 12 characters")
    .regex(/[A-Z]/, "Password must contain at least one uppercase letter")
    .regex(/[a-z]/, "Password must contain at least one lowercase letter")
    .regex(/[0-9]/, "Password must contain at least one number")
    .regex(
      /[^A-Za-z0-9]/,
      "Password must contain at least one special character",
    ),
  phone_number: z.string().min(1, "phone_number is required"),
  org_name: z
    .string()
    .min(1, "Organization name is required")
    .max(255, "Organization name must be 255 characters or fewer"),
});

export type Step1Input = z.infer<typeof step1Schema>;

export const step2Schema = z.object({
  business_name: z
    .string()
    .min(1, "Business name is required")
    .max(255, "Business name must be 255 characters or fewer"),
  business_type: z
    .string()
    .min(1, "Business type is required")
    .max(100, "Business type must be 100 characters or fewer"),
  registration_number: z
    .string()
    .max(100, "Registration number must be 100 characters or fewer")
    .optional(),
  tax_id: z
    .string()
    .max(100, "Tax ID must be 100 characters or fewer")
    .optional(),
  address: z.string().optional(),
  city: z
    .string()
    .max(100, "City must be 100 characters or fewer")
    .optional(),
  country: z
    .string()
    .length(2, "Country must be a 2-letter ISO code")
    .optional(),
  website: z
    .string()
    .url("Website must be a valid URL")
    .max(500, "Website must be 500 characters or fewer")
    .optional(),
  industry: z
    .string()
    .max(100, "Industry must be 100 characters or fewer")
    .optional(),
});

export type Step2Input = z.infer<typeof step2Schema>;

export const step3Schema = z.object({
  use_cases: z
    .array(UseCaseEnum)
    .min(1, "At least one use case is required"),
});

export type Step3Input = z.infer<typeof step3Schema>;
