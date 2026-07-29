import {
  hasFieldPermission,
  authorizeFieldAccess,
  extractFieldContext,
  maskStellarAddress,
  maskPhoneNumber,
  maskSensitiveField,
  FieldPermission,
  isSensitiveField,
  type FieldAuthContext,
} from "../fieldAuthorization";
import { GraphQLError } from "graphql";

describe("Field Authorization Utility", () => {
  describe("hasFieldPermission", () => {
    it("should return false when user role is not provided", () => {
      const context: FieldAuthContext = {
        userId: "user-1",
        resourceOwnerId: "user-1",
      };
      const result = hasFieldPermission(context, FieldPermission.VIEW_VAULT_ADDRESS);
      expect(result).toBe(false);
    });

    it("should allow admin to access all sensitive fields", () => {
      const context: FieldAuthContext = {
        userId: "admin-1",
        userRole: "admin",
        resourceOwnerId: "admin-1",
      };
      const result = hasFieldPermission(
        context,
        FieldPermission.VIEW_PROVIDER_SECRET,
      );
      expect(result).toBe(true);
    });

    it("should allow compliance role to access transaction details", () => {
      const context: FieldAuthContext = {
        userId: "compliance-1",
        userRole: "compliance",
        resourceOwnerId: "user-1",
      };
      const result = hasFieldPermission(
        context,
        FieldPermission.VIEW_TRANSACTION_DETAILS,
      );
      expect(result).toBe(true);
    });

    it("should deny compliance role from accessing provider secrets", () => {
      const context: FieldAuthContext = {
        userId: "compliance-1",
        userRole: "compliance",
        resourceOwnerId: "user-1",
      };
      const result = hasFieldPermission(
        context,
        FieldPermission.VIEW_PROVIDER_SECRET,
      );
      expect(result).toBe(false);
    });

    it("should allow support to access transaction phone", () => {
      const context: FieldAuthContext = {
        userId: "support-1",
        userRole: "support",
        resourceOwnerId: "user-1",
      };
      const result = hasFieldPermission(
        context,
        FieldPermission.VIEW_TRANSACTION_PHONE,
      );
      expect(result).toBe(true);
    });

    it("should enforce ownership requirement when requested", () => {
      const context: FieldAuthContext = {
        userId: "user-1",
        userRole: "user",
        resourceOwnerId: "user-2",
      };
      const result = hasFieldPermission(
        context,
        FieldPermission.VIEW_TRANSACTION_DETAILS,
        true, // requireOwnership
      );
      expect(result).toBe(false);
    });

    it("should allow owner access to their own transactions", () => {
      const context: FieldAuthContext = {
        userId: "user-1",
        userRole: "user",
        resourceOwnerId: "user-1",
      };
      const result = hasFieldPermission(
        context,
        FieldPermission.VIEW_TRANSACTION_DETAILS,
        true, // requireOwnership
      );
      expect(result).toBe(true);
    });
  });

  describe("authorizeFieldAccess", () => {
    it("should throw GraphQL error when not authorized", () => {
      const context: FieldAuthContext = {
        userId: "user-1",
        userRole: "user",
        resourceOwnerId: "user-2",
      };

      expect(() => {
        authorizeFieldAccess(
          context,
          FieldPermission.VIEW_VAULT_ADDRESS,
          "vaultAddress",
          true,
        );
      }).toThrow(GraphQLError);
    });

    it("should not throw when authorized", () => {
      const context: FieldAuthContext = {
        userId: "admin-1",
        userRole: "admin",
        resourceOwnerId: "admin-1",
      };

      expect(() => {
        authorizeFieldAccess(
          context,
          FieldPermission.VIEW_VAULT_ADDRESS,
          "vaultAddress",
        );
      }).not.toThrow();
    });

    it("should include field name in error message", () => {
      const context: FieldAuthContext = {
        userId: "user-1",
        userRole: "user",
      };

      try {
        authorizeFieldAccess(
          context,
          FieldPermission.VIEW_VAULT_ADDRESS,
          "sensitiveField",
        );
        expect.fail("Should have thrown");
      } catch (error) {
        if (error instanceof GraphQLError) {
          expect(error.message).toContain("sensitiveField");
        }
      }
    });
  });

  describe("maskStellarAddress", () => {
    it("should return full address when authorized", () => {
      const address = "GBBD47UZQ2EORUNUBXQMWGT4O2VQB5XRGYB3XQSHPEFQGKNL5BVJGHVM";
      const context: FieldAuthContext = {
        userId: "admin-1",
        userRole: "admin",
        resourceOwnerId: "admin-1",
      };

      const result = maskStellarAddress(address, context, false);
      expect(result).toBe(address);
    });

    it("should mask address when not authorized", () => {
      const address = "GBBD47UZQ2EORUNUBXQMWGT4O2VQB5XRGYB3XQSHPEFQGKNL5BVJGHVM";
      const context: FieldAuthContext = {
        userId: "user-1",
        userRole: "user",
        resourceOwnerId: "user-2",
      };

      const result = maskStellarAddress(address, context, false);
      expect(result).toMatch(/^GBBD\.{3}HGVM$/);
    });

    it("should return null for short addresses", () => {
      const address = "SHORT";
      const context: FieldAuthContext = {
        userId: "user-1",
        userRole: "user",
        resourceOwnerId: "user-2",
      };

      const result = maskStellarAddress(address, context, false);
      expect(result).toBe(null);
    });

    it("should enforce ownership when required", () => {
      const address = "GBBD47UZQ2EORUNUBXQMWGT4O2VQB5XRGYB3XQSHPEFQGKNL5BVJGHVM";
      const context: FieldAuthContext = {
        userId: "user-1",
        userRole: "user",
        resourceOwnerId: "user-1",
      };

      const result = maskStellarAddress(address, context, true);
      expect(result).toBe(address);
    });
  });

  describe("maskPhoneNumber", () => {
    it("should return full number when authorized", () => {
      const phone = "1234567890";
      const context: FieldAuthContext = {
        userId: "admin-1",
        userRole: "admin",
      };

      const result = maskPhoneNumber(phone, context, false);
      expect(result).toBe(phone);
    });

    it("should mask phone number when not authorized", () => {
      const phone = "1234567890";
      const context: FieldAuthContext = {
        userId: "user-1",
        userRole: "user",
        resourceOwnerId: "user-2",
      };

      const result = maskPhoneNumber(phone, context, false);
      expect(result).toMatch(/^\*{3}-\*{4}-7890$/);
    });

    it("should return null for short phone numbers", () => {
      const phone = "123";
      const context: FieldAuthContext = {
        userId: "user-1",
        userRole: "user",
        resourceOwnerId: "user-2",
      };

      const result = maskPhoneNumber(phone, context, false);
      expect(result).toBe(null);
    });

    it("support role should see full phone number", () => {
      const phone = "1234567890";
      const context: FieldAuthContext = {
        userId: "support-1",
        userRole: "support",
      };

      const result = maskPhoneNumber(phone, context, false);
      expect(result).toBe(phone);
    });
  });

  describe("maskSensitiveField", () => {
    it("should return original value when authorized", () => {
      const value = "SECRET_DATA";
      const context: FieldAuthContext = {
        userId: "admin-1",
        userRole: "admin",
      };

      const result = maskSensitiveField(
        value,
        context,
        FieldPermission.VIEW_PROVIDER_SECRET,
      );
      expect(result).toBe(value);
    });

    it("should return mask value when not authorized", () => {
      const value = "SECRET_DATA";
      const context: FieldAuthContext = {
        userId: "user-1",
        userRole: "user",
      };

      const result = maskSensitiveField(
        value,
        context,
        FieldPermission.VIEW_PROVIDER_SECRET,
        "[REDACTED]",
      );
      expect(result).toBe("[REDACTED]");
    });

    it("should return null by default when not authorized", () => {
      const value = "SECRET_DATA";
      const context: FieldAuthContext = {
        userId: "user-1",
        userRole: "user",
      };

      const result = maskSensitiveField(
        value,
        context,
        FieldPermission.VIEW_PROVIDER_SECRET,
      );
      expect(result).toBe(null);
    });
  });

  describe("isSensitiveField", () => {
    it("should identify sensitive fields", () => {
      expect(isSensitiveField("vaultAddress")).toBe(true);
      expect(isSensitiveField("phoneNumber")).toBe(true);
      expect(isSensitiveField("providerKey")).toBe(true);
      expect(isSensitiveField("providerSecret")).toBe(true);
    });

    it("should not identify non-sensitive fields", () => {
      expect(isSensitiveField("id")).toBe(false);
      expect(isSensitiveField("name")).toBe(false);
      expect(isSensitiveField("createdAt")).toBe(false);
      expect(isSensitiveField("status")).toBe(false);
    });
  });

  describe("Role-based access scenarios", () => {
    it("admin should have full access", () => {
      const adminContext: FieldAuthContext = {
        userId: "admin-1",
        userRole: "admin",
      };

      expect(hasFieldPermission(adminContext, FieldPermission.VIEW_VAULT_ADDRESS)).toBe(true);
      expect(hasFieldPermission(adminContext, FieldPermission.VIEW_PROVIDER_SECRET)).toBe(true);
      expect(hasFieldPermission(adminContext, FieldPermission.VIEW_DISPUTE_NOTES)).toBe(true);
    });

    it("compliance should have audit access", () => {
      const complianceContext: FieldAuthContext = {
        userId: "compliance-1",
        userRole: "compliance",
      };

      expect(hasFieldPermission(complianceContext, FieldPermission.VIEW_VAULT_ADDRESS)).toBe(true);
      expect(hasFieldPermission(complianceContext, FieldPermission.VIEW_TRANSACTION_PHONE)).toBe(true);
      expect(hasFieldPermission(complianceContext, FieldPermission.VIEW_DISPUTE_DETAILS)).toBe(true);
      expect(hasFieldPermission(complianceContext, FieldPermission.VIEW_PROVIDER_SECRET)).toBe(false);
    });

    it("support should have limited access", () => {
      const supportContext: FieldAuthContext = {
        userId: "support-1",
        userRole: "support",
      };

      expect(hasFieldPermission(supportContext, FieldPermission.VIEW_TRANSACTION_PHONE)).toBe(true);
      expect(hasFieldPermission(supportContext, FieldPermission.VIEW_DISPUTE_NOTES)).toBe(true);
      expect(hasFieldPermission(supportContext, FieldPermission.VIEW_PROVIDER_SECRET)).toBe(false);
      expect(hasFieldPermission(supportContext, FieldPermission.VIEW_VAULT_ADDRESS)).toBe(false);
    });

    it("regular user should have minimal access", () => {
      const userContext: FieldAuthContext = {
        userId: "user-1",
        userRole: "user",
        resourceOwnerId: "user-1",
      };

      expect(
        hasFieldPermission(
          userContext,
          FieldPermission.VIEW_TRANSACTION_DETAILS,
          true,
        ),
      ).toBe(true);
      expect(hasFieldPermission(userContext, FieldPermission.VIEW_PROVIDER_SECRET)).toBe(false);
      expect(hasFieldPermission(userContext, FieldPermission.VIEW_VAULT_ADDRESS)).toBe(false);
    });
  });

  describe("Ownership checks", () => {
    it("should allow access to own resources", () => {
      const context: FieldAuthContext = {
        userId: "user-1",
        userRole: "user",
        resourceOwnerId: "user-1",
      };

      const result = hasFieldPermission(
        context,
        FieldPermission.VIEW_TRANSACTION_DETAILS,
        true,
      );
      expect(result).toBe(true);
    });

    it("should deny access to others' resources when ownership required", () => {
      const context: FieldAuthContext = {
        userId: "user-1",
        userRole: "user",
        resourceOwnerId: "user-2",
      };

      const result = hasFieldPermission(
        context,
        FieldPermission.VIEW_TRANSACTION_DETAILS,
        true,
      );
      expect(result).toBe(false);
    });

    it("admin should bypass ownership checks", () => {
      const context: FieldAuthContext = {
        userId: "admin-1",
        userRole: "admin",
        resourceOwnerId: "user-2",
      };

      const result = hasFieldPermission(
        context,
        FieldPermission.VIEW_TRANSACTION_DETAILS,
        true,
      );
      expect(result).toBe(true);
    });
  });
});
