import {
  withFieldAuthorization,
  withFieldMasking,
  withFieldArrayAuthorization,
  checkFieldAccessBatch,
  FieldPermission,
} from "../fieldResolverWrapper";

describe("Field Resolver Wrapper", () => {
  const mockCtx = {
    auth: { authenticated: true, subject: "user-1" },
    userRole: "admin",
  };

  describe("withFieldAuthorization", () => {
    it("should allow authorized access", async () => {
      const mockResolver = jest.fn().mockResolvedValue("sensitive-data");
      const wrappedResolver = withFieldAuthorization(
        mockResolver,
        FieldPermission.VIEW_PROVIDER_SECRET,
      );

      const result = await wrappedResolver({}, {}, mockCtx as any);

      expect(result).toBe("sensitive-data");
      expect(mockResolver).toHaveBeenCalled();
    });

    it("should return null for unauthorized access", async () => {
      const mockResolver = jest.fn().mockResolvedValue("sensitive-data");
      const unAuthCtx = {
        auth: { authenticated: true, subject: "user-1" },
        userRole: "user",
      };
      const wrappedResolver = withFieldAuthorization(
        mockResolver,
        FieldPermission.VIEW_PROVIDER_SECRET,
      );

      const result = await wrappedResolver({}, {}, unAuthCtx as any);

      expect(result).toBe(null);
      expect(mockResolver).not.toHaveBeenCalled();
    });

    it("should apply custom mask function", async () => {
      const mockResolver = jest.fn().mockResolvedValue("secret-123");
      const maskFn = jest.fn().mockReturnValue("[MASKED]");
      const unAuthCtx = {
        auth: { authenticated: true, subject: "user-1" },
        userRole: "user",
      };

      const wrappedResolver = withFieldAuthorization(mockResolver, FieldPermission.VIEW_PROVIDER_SECRET, {
        maskFn,
      });

      const result = await wrappedResolver({}, {}, unAuthCtx as any);

      expect(result).toBe("[MASKED]");
      expect(maskFn).toHaveBeenCalled();
    });

    it("should enforce ownership requirement", async () => {
      const mockResolver = jest.fn().mockResolvedValue("data");
      const wrappedResolver = withFieldAuthorization(
        mockResolver,
        FieldPermission.VIEW_TRANSACTION_DETAILS,
        { requireOwnership: true },
      );

      // User accessing their own resource
      const result1 = await wrappedResolver(
        { userId: "user-1" },
        {},
        mockCtx as any,
      );
      expect(result1).toBe("data");

      // User accessing someone else's resource
      const userCtx = {
        auth: { authenticated: true, subject: "user-1" },
        userRole: "user",
      };
      const result2 = await wrappedResolver(
        { userId: "user-2" },
        {},
        userCtx as any,
      );
      expect(result2).toBe(null);
    });
  });

  describe("withFieldMasking", () => {
    it("should return unmasked value when authorized", async () => {
      const address = "GBBD47UZQ2EORUNUBXQMWGT4O2VQB5XRGYB3XQSHPEFQGKNL5BVJGHVM";
      const mockResolver = jest.fn().mockResolvedValue(address);

      const wrappedResolver = withFieldMasking(
        mockResolver,
        FieldPermission.VIEW_VAULT_ADDRESS,
        "stellar",
      );

      const result = await wrappedResolver({}, {}, mockCtx as any);
      expect(result).toBe(address);
    });

    it("should mask stellar address when unauthorized", async () => {
      const address = "GBBD47UZQ2EORUNUBXQMWGT4O2VQB5XRGYB3XQSHPEFQGKNL5BVJGHVM";
      const mockResolver = jest.fn().mockResolvedValue(address);
      const unAuthCtx = {
        auth: { authenticated: true, subject: "user-1" },
        userRole: "user",
      };

      const wrappedResolver = withFieldMasking(
        mockResolver,
        FieldPermission.VIEW_VAULT_ADDRESS,
        "stellar",
      );

      const result = await wrappedResolver({}, {}, unAuthCtx as any);
      expect(result).toMatch(/^GBBD\.{3}HGVM$/);
    });

    it("should mask phone number when unauthorized", async () => {
      const phone = "1234567890";
      const mockResolver = jest.fn().mockResolvedValue(phone);
      const unAuthCtx = {
        auth: { authenticated: true, subject: "user-1" },
        userRole: "user",
      };

      const wrappedResolver = withFieldMasking(
        mockResolver,
        FieldPermission.VIEW_TRANSACTION_PHONE,
        "phone",
      );

      const result = await wrappedResolver({}, {}, unAuthCtx as any);
      expect(result).toMatch(/^\*{3}-\*{4}-7890$/);
    });

    it("should support ownership requirement for masking", async () => {
      const address = "GBBD47UZQ2EORUNUBXQMWGT4O2VQB5XRGYB3XQSHPEFQGKNL5BVJGHVM";
      const mockResolver = jest.fn().mockResolvedValue(address);

      const wrappedResolver = withFieldMasking(
        mockResolver,
        FieldPermission.VIEW_VAULT_ADDRESS,
        "stellar",
        { requireOwnership: true },
      );

      // User accessing their own resource
      const result1 = await wrappedResolver(
        { userId: "user-1" },
        {},
        { auth: { authenticated: true, subject: "user-1" }, userRole: "user" } as any,
      );
      expect(result1).toBe(address);

      // User accessing someone else's resource
      const result2 = await wrappedResolver(
        { userId: "user-2" },
        {},
        { auth: { authenticated: true, subject: "user-1" }, userRole: "user" } as any,
      );
      expect(result2).toMatch(/^GBBD\.{3}HGVM$/);
    });
  });

  describe("withFieldArrayAuthorization", () => {
    it("should return all items when authorized", async () => {
      const items = [
        { id: "1", userId: "user-1", name: "Item 1" },
        { id: "2", userId: "user-2", name: "Item 2" },
        { id: "3", userId: "user-1", name: "Item 3" },
      ];
      const mockResolver = jest.fn().mockResolvedValue(items);

      const wrappedResolver = withFieldArrayAuthorization(
        mockResolver,
        FieldPermission.VIEW_TRANSACTION_DETAILS,
      );

      const result = await wrappedResolver({}, {}, mockCtx as any);
      expect(result).toHaveLength(3);
    });

    it("should filter items based on ownership", async () => {
      const items = [
        { id: "1", userId: "user-1", name: "Item 1" },
        { id: "2", userId: "user-2", name: "Item 2" },
        { id: "3", userId: "user-1", name: "Item 3" },
      ];
      const mockResolver = jest.fn().mockResolvedValue(items);

      const userCtx = {
        auth: { authenticated: true, subject: "user-1" },
        userRole: "user",
      };

      const wrappedResolver = withFieldArrayAuthorization(
        mockResolver,
        FieldPermission.VIEW_TRANSACTION_DETAILS,
        { requireOwnership: true },
      );

      const result = await wrappedResolver({}, {}, userCtx as any);
      expect(result).toHaveLength(2);
      expect(result[0].id).toBe("1");
      expect(result[1].id).toBe("3");
    });

    it("should return empty array when no permissions", async () => {
      const items = [
        { id: "1", userId: "user-2", name: "Item 1" },
        { id: "2", userId: "user-3", name: "Item 2" },
      ];
      const mockResolver = jest.fn().mockResolvedValue(items);

      const userCtx = {
        auth: { authenticated: true, subject: "user-1" },
        userRole: "restricted",
      };

      const wrappedResolver = withFieldArrayAuthorization(
        mockResolver,
        FieldPermission.VIEW_PROVIDER_SECRET,
      );

      const result = await wrappedResolver({}, {}, userCtx as any);
      expect(result).toHaveLength(0);
    });
  });

  describe("checkFieldAccessBatch", () => {
    it("should check multiple fields at once", () => {
      const fieldPermissions = {
        vaultAddress: FieldPermission.VIEW_VAULT_ADDRESS,
        providerSecret: FieldPermission.VIEW_PROVIDER_SECRET,
        transactionPhone: FieldPermission.VIEW_TRANSACTION_PHONE,
      };

      const context = {
        userId: "admin-1",
        userRole: "admin",
        resourceOwnerId: "admin-1",
      };

      const result = checkFieldAccessBatch(fieldPermissions, context);

      expect(result.vaultAddress).toBe(true);
      expect(result.providerSecret).toBe(true);
      expect(result.transactionPhone).toBe(true);
    });

    it("should return false for unauthorized fields", () => {
      const fieldPermissions = {
        vaultAddress: FieldPermission.VIEW_VAULT_ADDRESS,
        providerSecret: FieldPermission.VIEW_PROVIDER_SECRET,
        transactionDetails: FieldPermission.VIEW_TRANSACTION_DETAILS,
      };

      const context = {
        userId: "user-1",
        userRole: "user",
        resourceOwnerId: "user-1",
      };

      const result = checkFieldAccessBatch(fieldPermissions, context);

      expect(result.vaultAddress).toBe(false);
      expect(result.providerSecret).toBe(false);
      expect(result.transactionDetails).toBe(true); // User has this permission
    });

    it("should handle mixed permissions for different roles", () => {
      const fieldPermissions = {
        vaultAddress: FieldPermission.VIEW_VAULT_ADDRESS,
        transactionPhone: FieldPermission.VIEW_TRANSACTION_PHONE,
        disputeNotes: FieldPermission.VIEW_DISPUTE_NOTES,
      };

      const supportContext = {
        userId: "support-1",
        userRole: "support",
        resourceOwnerId: "user-1",
      };

      const result = checkFieldAccessBatch(fieldPermissions, supportContext);

      expect(result.vaultAddress).toBe(false);
      expect(result.transactionPhone).toBe(true);
      expect(result.disputeNotes).toBe(true);
    });
  });
});
