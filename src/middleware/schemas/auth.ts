/**
 * Auth domain validation schemas.
 * Used with the validate() middleware factory.
 */
import { z } from "zod";

export const RegisterBodySchema = z.object({
  phone_number: z.string().min(1, "phone_number is required"),
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
});

export const LoginBodySchema = z.object({
  phone_number: z.string().min(1, "phone_number is required"),
  password: z.string().min(1, "password is required"),
});

export const RefreshTokenBodySchema = z.object({
  refreshToken: z.string().min(1, "refreshToken is required"),
});

export const TokenVerifyBodySchema = z.object({
  token: z.string().min(1, "token is required"),
});

export type RegisterBody = z.infer<typeof RegisterBodySchema>;
export type LoginBody = z.infer<typeof LoginBodySchema>;
export type RefreshTokenBody = z.infer<typeof RefreshTokenBodySchema>;
export type TokenVerifyBody = z.infer<typeof TokenVerifyBodySchema>;
