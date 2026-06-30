import { Router, Request, Response } from "express";
import { ContactModel } from "../models/contact";
import { authenticateToken } from "../middleware/auth";
import { validate } from "../middleware/validation";
import {
  CreateContactBodySchema,
  UpdateContactBodySchema,
  ContactIdParamsSchema,
} from "../middleware/schemas/contacts";
import { TimeoutPresets, haltOnTimedout } from "../middleware/timeout";
import { ERROR_CODES } from "../constants/errorCodes";
import { createError } from "../middleware/errorHandler";

const PHONE_REGEX = /^\+\d{7,15}$/;
const STELLAR_ADDRESS_REGEX = /^G[A-Z2-7]{55}$/;

function getUserId(req: Request): string | null {
  return req.jwtUser?.userId ?? null;
}

function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  return "code" in error && error.code === "23505";
}

const contactModel = new ContactModel();
export const contactsRoutes = Router();

contactsRoutes.use(authenticateToken);

contactsRoutes.post(
  "/",
  TimeoutPresets.quick,
  haltOnTimedout,
  validate({ body: CreateContactBodySchema }),
  async (req: Request, res: Response) => {
    const userId = getUserId(req);
    if (!userId) {
      throw createError(ERROR_CODES.INVALID_INPUT, "User not authenticated", {
        error: "User not authenticated",
      });
    }

    try {
      const contact = await contactModel.create({
        userId,
        destinationType: req.body.destinationType,
        destinationValue: req.body.destinationValue,
        nickname: req.body.nickname,
      });

      return res.status(201).json(contact);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw createError(
          ERROR_CODES.CONFLICT,
          "Contact already exists for this destination",
          {
            error: "Contact already exists for this destination",
          },
        );
      }

      console.error("Create contact error:", error);
      throw createError(
        ERROR_CODES.INTERNAL_ERROR,
        "Failed to create contact",
        {
          error: "Failed to create contact",
        },
      );
    }
  },
);

contactsRoutes.get(
  "/",
  TimeoutPresets.quick,
  haltOnTimedout,
  async (req: Request, res: Response) => {
    const userId = getUserId(req);
    if (!userId) {
      throw createError(
        ERROR_CODES.INTERNAL_ERROR,
        "Failed to create contact",
        {
          error: "Failed to create contact",
        },
      );
    }

    try {
      const contacts = await contactModel.listByUser(userId);
      return res.json(contacts);
    } catch (error) {
      console.error("List contacts error:", error);
      throw createError(
        ERROR_CODES.INTERNAL_ERROR,
        "Failed to fetch contacts",
        {
          error: "Failed to fetch contacts",
        },
      );
    }
  },
);

contactsRoutes.get(
  "/:id",
  TimeoutPresets.quick,
  haltOnTimedout,
  validate({ params: ContactIdParamsSchema }),
  async (req: Request, res: Response) => {
    const userId = getUserId(req);
    if (!userId) {
      throw createError(ERROR_CODES.FORBIDDEN, "User not authenticated", {
        error: "User not authenticated",
      });
    }

    try {
      const contact = await contactModel.findByIdForUser(req.params.id, userId);
      if (!contact) {
        throw createError(ERROR_CODES.NOT_FOUND, "Contact not found", {
          error: "Contact not found",
        });
      }

      return res.json(contact);
    } catch (error) {
      console.error("Get contact error:", error);
      throw createError(ERROR_CODES.INTERNAL_ERROR, "Failed to fetch contact", {
        error: "Failed to fetch contact",
      });
    }
  },
);

contactsRoutes.patch(
  "/:id",
  TimeoutPresets.quick,
  haltOnTimedout,
  validate({ body: UpdateContactBodySchema, params: ContactIdParamsSchema }),
  async (req: Request, res: Response) => {
    const userId = getUserId(req);
    if (!userId) {
      throw createError(ERROR_CODES.FORBIDDEN, "User not authenticated", {
        error: "User not authenticated",
      });
    }

    try {
      const existing = await contactModel.findByIdForUser(
        req.params.id,
        userId,
      );
      if (!existing) {
        throw createError(ERROR_CODES.NOT_FOUND, "Contact not found", {
          error: "Contact not found",
        });
      }

      const nextDestinationType =
        req.body.destinationType ?? existing.destinationType;
      const nextDestinationValue =
        req.body.destinationValue ?? existing.destinationValue;

      if (
        nextDestinationType === "phone" &&
        !PHONE_REGEX.test(nextDestinationValue)
      ) {
        throw createError(ERROR_CODES.INVALID_INPUT, "Validation error", {
          error: "Validation error",
          details: [
            {
              path: ["destinationValue"],
              message:
                "Must be a valid E.164 phone number (e.g. +237670000000)",
            },
          ],
        });
      }

      if (
        nextDestinationType === "stellar" &&
        !STELLAR_ADDRESS_REGEX.test(nextDestinationValue)
      ) {
        throw createError(ERROR_CODES.INVALID_INPUT, "Validation error", {
          error: "Validation error",
          details: [
            {
              path: ["destinationValue"],
              message:
                "Must be a valid Stellar public key (56 characters, starting with G)",
            },
          ],
        });
      }

      const updated = await contactModel.updateByIdForUser(
        req.params.id,
        userId,
        {
          destinationType: req.body.destinationType,
          destinationValue: req.body.destinationValue,
          nickname: req.body.nickname,
        },
      );

      if (!updated) {
        throw createError(ERROR_CODES.NOT_FOUND, "Contact not found", {
          error: "Contact not found",
        });
      }

      return res.json(updated);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw createError(
          ERROR_CODES.CONFLICT,
          "Contact already exists for this destination",
          {
            error: "Contact already exists for this destination",
          },
        );
      }

      console.error("Update contact error:", error);
      throw createError(
        ERROR_CODES.INTERNAL_ERROR,
        "Failed to update contact",
        {
          error: "Failed to update contact",
        },
      );
    }
  },
);

contactsRoutes.delete(
  "/:id",
  TimeoutPresets.quick,
  haltOnTimedout,
  validate({ params: ContactIdParamsSchema }),
  async (req: Request, res: Response) => {
    const userId = getUserId(req);
    if (!userId) {
      throw createError(ERROR_CODES.UNAUTHORIZED, "User not authenticated", {
        error: "User not authenticated",
      });
    }

    try {
      const deleted = await contactModel.deleteByIdForUser(
        req.params.id,
        userId,
      );
      if (!deleted) {
        throw createError(ERROR_CODES.NOT_FOUND, "Contact not found", {
          error: "Contact not found",
        });
      }

      return res.status(204).send();
    } catch (error) {
      console.error("Delete contact error:", error);
      throw createError(
        ERROR_CODES.INTERNAL_ERROR,
        "Failed to delete contact",
        {
          error: "Failed to delete contact",
        },
      );
    }
  },
);
