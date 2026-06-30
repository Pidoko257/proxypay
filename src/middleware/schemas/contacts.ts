/**
 * Contacts domain validation schemas.
 * Used with the validate() middleware factory.
 */
import { z } from "zod";

const PHONE_REGEX = /^\+\d{7,15}$/;
const STELLAR_ADDRESS_REGEX = /^G[A-Z2-7]{55}$/;

export const CreateContactBodySchema = z
  .object({
    destinationType: z.enum(["phone", "stellar"], {
      errorMap: () => ({ message: "destinationType must be 'phone' or 'stellar'" }),
    }),
    destinationValue: z.string().trim().min(1, "destinationValue is required"),
    nickname: z
      .string()
      .trim()
      .min(1, "nickname is required")
      .max(100, "nickname must be 100 characters or fewer"),
  })
  .superRefine((value, ctx) => {
    if (
      value.destinationType === "phone" &&
      !PHONE_REGEX.test(value.destinationValue)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["destinationValue"],
        message: "Must be a valid E.164 phone number (e.g. +237670000000)",
      });
    }

    if (
      value.destinationType === "stellar" &&
      !STELLAR_ADDRESS_REGEX.test(value.destinationValue)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["destinationValue"],
        message:
          "Must be a valid Stellar public key (56 characters, starting with G)",
      });
    }
  });

export const UpdateContactBodySchema = z
  .object({
    destinationType: z.enum(["phone", "stellar"]).optional(),
    destinationValue: z.string().trim().min(1).optional(),
    nickname: z.string().trim().min(1).max(100).optional(),
  })
  .superRefine((value, ctx) => {
    if (
      value.destinationType !== undefined &&
      value.destinationValue !== undefined
    ) {
      if (
        value.destinationType === "phone" &&
        !PHONE_REGEX.test(value.destinationValue)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["destinationValue"],
          message: "Must be a valid E.164 phone number (e.g. +237670000000)",
        });
      }

      if (
        value.destinationType === "stellar" &&
        !STELLAR_ADDRESS_REGEX.test(value.destinationValue)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["destinationValue"],
          message:
            "Must be a valid Stellar public key (56 characters, starting with G)",
        });
      }
    }

    if (Object.keys(value).length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [],
        message: "At least one field must be provided",
      });
    }
  });

export const ContactIdParamsSchema = z.object({
  id: z.string().min(1, "Contact id is required"),
});

export type CreateContactBody = z.infer<typeof CreateContactBodySchema>;
export type UpdateContactBody = z.infer<typeof UpdateContactBodySchema>;
