import {
  verifyResourceOwnership,
  assertResourceOwnership,
  ForbiddenError,
} from "../../src/middleware/tenantIsolation";

describe("Data Isolation & Cross-Tenant Security Tests", () => {
  const userA = { id: "user_tenant_A", role: "user" };
  const userB = { id: "user_tenant_B", role: "user" };
  const merchantA = { id: "merchant_001", role: "merchant" };
  const merchantB = { id: "merchant_002", role: "merchant" };
  const complianceOfficer = { id: "staff_compliance_1", role: "compliance" };
  const superAdmin = { id: "admin_super_1", role: "admin" };

  describe("User Profile & Wallet Data Isolation", () => {
    it("allows a user to access their own resources", () => {
      expect(
        verifyResourceOwnership(userA.id, userA.id, { principalRole: userA.role })
      ).toBe(true);
    });

    it("prevents User B from accessing User A's wallet or transaction records", () => {
      expect(
        verifyResourceOwnership(userB.id, userA.id, { principalRole: userB.role })
      ).toBe(false);

      expect(() => {
        assertResourceOwnership(userB.id, userA.id, "wallet", "wallet_123", {
          principalRole: userB.role,
        });
      }).toThrow(ForbiddenError);
    });
  });

  describe("Merchant & Invoice Data Isolation", () => {
    it("allows a merchant to view and manage their own invoices and settlements", () => {
      expect(
        verifyResourceOwnership(merchantA.id, merchantA.id, {
          principalRole: merchantA.role,
        })
      ).toBe(true);
    });

    it("strictly blocks Merchant B from viewing Merchant A's invoices, settlements, or webhooks", () => {
      expect(
        verifyResourceOwnership(merchantB.id, merchantA.id, {
          principalRole: merchantB.role,
        })
      ).toBe(false);

      expect(() => {
        assertResourceOwnership(merchantB.id, merchantA.id, "invoice", "inv_abc", {
          principalRole: merchantB.role,
        });
      }).toThrow(/Access denied: you do not have permission to access this invoice/);
    });
  });

  describe("KYC Document & Sensitive Identity Data Isolation", () => {
    it("prohibits peer users from viewing another person's KYC records", () => {
      expect(
        verifyResourceOwnership(userB.id, userA.id, { principalRole: userB.role })
      ).toBe(false);
    });

    it("allows compliance role to review KYC submissions across users", () => {
      expect(
        verifyResourceOwnership(complianceOfficer.id, userA.id, {
          principalRole: complianceOfficer.role,
        })
      ).toBe(true);
    });
  });

  describe("Dispute & Chargeback Data Isolation", () => {
    it("prevents unrelated merchants or users from intervening in active disputes", () => {
      const disputeOwnerMerchant = "merchant_victim_01";
      const unrelatedMerchant = "merchant_eavesdropper_02";

      expect(
        verifyResourceOwnership(unrelatedMerchant, disputeOwnerMerchant, {
          principalRole: "merchant",
        })
      ).toBe(false);

      expect(() => {
        assertResourceOwnership(
          unrelatedMerchant,
          disputeOwnerMerchant,
          "dispute",
          "disp_999",
          { principalRole: "merchant" }
        );
      }).toThrow(ForbiddenError);
    });
  });

  describe("Financial & Tax Report Data Isolation", () => {
    it("ensures reports are strictly isolated to the requesting tenant", () => {
      const reportOwner = "tenant_company_x";
      const unauthorizedCaller = "tenant_company_y";

      expect(
        verifyResourceOwnership(unauthorizedCaller, reportOwner, {
          principalRole: "merchant",
        })
      ).toBe(false);
    });

    it("permits superadmin to export multi-tenant reports", () => {
      const reportOwner = "tenant_company_x";

      expect(
        verifyResourceOwnership(superAdmin.id, reportOwner, {
          principalRole: superAdmin.role,
        })
      ).toBe(true);
    });
  });

  describe("Edge cases and missing principals", () => {
    it("denies access when principalId or resourceOwnerId is undefined", () => {
      expect(verifyResourceOwnership(undefined, "user_1")).toBe(false);
      expect(verifyResourceOwnership("user_1", undefined)).toBe(false);
      expect(verifyResourceOwnership(undefined, undefined)).toBe(false);
    });
  });
});
