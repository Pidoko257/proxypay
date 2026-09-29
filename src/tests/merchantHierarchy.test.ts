/**
 * Tests for Merchant Sub-Accounts / Multi-Level Hierarchy
 *
 * Covers:
 * - MerchantService.createSubAccount()
 * - MerchantService.getSubAccounts()
 * - MerchantService.getHierarchyTree()
 * - MerchantService.getAncestors()
 * - MerchantService.moveSubAccount()
 */

import { MerchantService } from "../services/merchantService";
import { MerchantModel, Merchant, HierarchyTreeNode, CreateSubAccountInput } from "../models/merchant";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock("../models/merchant");
jest.mock("../services/email");

const baseMerchant: Merchant = {
  id: "merchant-001",
  name: "Acme Corp",
  email: "acme@example.com",
  phoneNumber: "+237670000001",
  businessName: "Acme Corp Ltd",
  businessType: "retail",
  taxId: null,
  address: "123 Main St",
  city: "Douala",
  country: "CM",
  status: "active",
  kycStatus: "verified",
  invitationToken: undefined,
  invitationSentAt: undefined,
  invitationAcceptedAt: undefined,
  metadata: {},
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
  // Hierarchy fields
  parentMerchantId: null,
  hierarchyLevel: 0,
  hierarchyPath: "/merchant-001",
  maxSubAccounts: 10,
};

const makeSubMerchant = (overrides: Partial<Merchant> = {}): Merchant => ({
  ...baseMerchant,
  id: "merchant-sub-001",
  name: "Acme Sub-Store",
  email: "sub@example.com",
  parentMerchantId: "merchant-001",
  hierarchyLevel: 1,
  hierarchyPath: "/merchant-001/merchant-sub-001",
  ...overrides,
});

const subInput: CreateSubAccountInput = {
  name: "Acme Sub-Store",
  email: "sub@example.com",
  phoneNumber: "+237670000002",
};

// ---------------------------------------------------------------------------
// MerchantService unit tests
// ---------------------------------------------------------------------------

describe("MerchantService — Sub-Accounts & Hierarchy", () => {
  let service: MerchantService;
  let mockModel: jest.Mocked<MerchantModel>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockModel = new MerchantModel() as jest.Mocked<MerchantModel>;
    service = new MerchantService();
    // Inject the mock model
    (service as any).merchantModel = mockModel;
  });

  // ---- createSubAccount -----------------------------------------------------

  describe("createSubAccount", () => {
    it("creates a sub-account under an active parent", async () => {
      const sub = makeSubMerchant();
      mockModel.findById = jest.fn().mockResolvedValue(baseMerchant);
      mockModel.findSubAccounts = jest.fn().mockResolvedValue({ merchants: [], total: 0 });
      mockModel.findByEmail = jest.fn().mockResolvedValue(null);
      mockModel.createSubAccount = jest.fn().mockResolvedValue(sub);

      const result = await service.createSubAccount("merchant-001", subInput);

      expect(mockModel.findById).toHaveBeenCalledWith("merchant-001");
      expect(mockModel.createSubAccount).toHaveBeenCalledWith(
        "merchant-001",
        subInput,
      );
      expect(result.parentMerchantId).toBe("merchant-001");
      expect(result.hierarchyLevel).toBe(1);
    });

    it("throws 'not found' when parent merchant does not exist", async () => {
      mockModel.findById = jest.fn().mockResolvedValue(null);
      await expect(
        service.createSubAccount("nonexistent", subInput),
      ).rejects.toThrow(/not found/i);
    });

    it("throws when parent merchant is not active", async () => {
      mockModel.findById = jest.fn().mockResolvedValue({
        ...baseMerchant,
        status: "suspended",
      });
      await expect(
        service.createSubAccount("merchant-001", subInput),
      ).rejects.toThrow(/not active/i);
    });

    it("throws when sub-account limit is exceeded", async () => {
      mockModel.findById = jest.fn().mockResolvedValue({
        ...baseMerchant,
        maxSubAccounts: 2,
      });
      // Already 2 sub-accounts
      mockModel.findSubAccounts = jest.fn().mockResolvedValue({
        merchants: [],
        total: 2, // at or over limit
      });

      await expect(
        service.createSubAccount("merchant-001", {
          name: "Third Sub",
          email: "third@e.com",
          phoneNumber: "+237670000003",
        }),
      ).rejects.toThrow(/maximum/i);
    });

    it("throws when sub-account email already exists", async () => {
      mockModel.findById = jest.fn().mockResolvedValue(baseMerchant);
      mockModel.findSubAccounts = jest.fn().mockResolvedValue({ merchants: [], total: 0 });
      mockModel.findByEmail = jest.fn().mockResolvedValue(makeSubMerchant());

      await expect(
        service.createSubAccount("merchant-001", subInput),
      ).rejects.toThrow(/email/i);
    });
  });

  // ---- getSubAccounts -------------------------------------------------------

  describe("getSubAccounts", () => {
    it("returns direct sub-accounts with pagination envelope", async () => {
      const subs = [makeSubMerchant(), makeSubMerchant({ id: "sub-002", email: "s2@e.com" })];
      mockModel.findSubAccounts = jest.fn().mockResolvedValue({ merchants: subs, total: 2 });

      const result = await service.getSubAccounts("merchant-001");

      expect(mockModel.findSubAccounts).toHaveBeenCalledWith("merchant-001", undefined);
      expect(result.merchants).toHaveLength(2);
      expect(result.total).toBe(2);
      expect(result).toHaveProperty("pagination");
    });
  });

  // ---- getHierarchyTree -----------------------------------------------------

  describe("getHierarchyTree", () => {
    it("returns the full hierarchy tree starting from a merchant", async () => {
      const tree: HierarchyTreeNode = {
        ...baseMerchant,
        children: [
          { ...makeSubMerchant(), children: [] },
        ],
      };
      mockModel.findById = jest.fn().mockResolvedValue(baseMerchant);
      mockModel.getHierarchyTree = jest.fn().mockResolvedValue(tree);

      const result = await service.getHierarchyTree("merchant-001");

      expect(mockModel.getHierarchyTree).toHaveBeenCalledWith("merchant-001");
      expect(result!.children).toHaveLength(1);
    });

    it("throws when merchant is not found", async () => {
      mockModel.findById = jest.fn().mockResolvedValue(null);
      await expect(service.getHierarchyTree("nonexistent")).rejects.toThrow(/not found/i);
    });
  });

  // ---- getAncestors ---------------------------------------------------------

  describe("getAncestors", () => {
    it("returns the list of ancestors from root to parent", async () => {
      const sub = makeSubMerchant();
      const ancestors = [baseMerchant];

      mockModel.findById = jest.fn().mockResolvedValue(sub);
      mockModel.findAncestors = jest.fn().mockResolvedValue(ancestors);

      const result = await service.getAncestors("merchant-sub-001");

      expect(mockModel.findAncestors).toHaveBeenCalledWith("merchant-sub-001");
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("merchant-001");
    });

    it("returns empty array for a root merchant with no ancestors", async () => {
      mockModel.findById = jest.fn().mockResolvedValue(baseMerchant);
      mockModel.findAncestors = jest.fn().mockResolvedValue([]);

      const result = await service.getAncestors("merchant-001");
      expect(result).toHaveLength(0);
    });

    it("throws when merchant is not found", async () => {
      mockModel.findById = jest.fn().mockResolvedValue(null);
      await expect(service.getAncestors("nonexistent")).rejects.toThrow(/not found/i);
    });
  });

  // ---- moveSubAccount -------------------------------------------------------

  describe("moveSubAccount", () => {
    it("re-parents a sub-account to a new parent", async () => {
      const newParent: Merchant = {
        ...baseMerchant,
        id: "merchant-002",
        email: "acme2@example.com",
        hierarchyPath: "/merchant-002",
      };
      const sub = makeSubMerchant();
      const movedSub = {
        ...sub,
        parentMerchantId: "merchant-002",
        hierarchyPath: "/merchant-002/merchant-sub-001",
      };

      mockModel.findById = jest.fn()
        .mockResolvedValueOnce(sub)       // fetch the sub-account
        .mockResolvedValueOnce(newParent)  // fetch new parent
        .mockResolvedValueOnce(movedSub);  // re-fetch after move
      mockModel.findSubAccounts = jest.fn().mockResolvedValue({ merchants: [], total: 0 });
      mockModel.findDescendants = jest.fn().mockResolvedValue([]);
      mockModel.updateHierarchyPaths = jest.fn().mockResolvedValue(undefined);

      const result = await service.moveSubAccount("merchant-sub-001", "merchant-002");

      expect(mockModel.updateHierarchyPaths).toHaveBeenCalledWith(
        "merchant-sub-001",
        "merchant-002",
      );
      expect(result.parentMerchantId).toBe("merchant-002");
    });

    it("throws when trying to move a merchant to itself", async () => {
      // findById is not called before the self-reference check in this impl
      await expect(
        service.moveSubAccount("merchant-001", "merchant-001"),
      ).rejects.toThrow(/own parent|itself/i);
    });

    it("throws when new parent is a descendant (circular reference)", async () => {
      const sub = makeSubMerchant();
      const grandChild = makeSubMerchant({
        id: "merchant-grand-001",
        email: "grand@e.com",
        parentMerchantId: "merchant-sub-001",
        hierarchyLevel: 2,
        hierarchyPath: "/merchant-001/merchant-sub-001/merchant-grand-001",
      });

      mockModel.findById = jest.fn()
        .mockResolvedValueOnce(sub)
        .mockResolvedValueOnce(grandChild);
      mockModel.findDescendants = jest.fn().mockResolvedValue([grandChild]);

      await expect(
        service.moveSubAccount("merchant-sub-001", "merchant-grand-001"),
      ).rejects.toThrow(/circular/i);
    });

    it("throws when new parent merchant is not found", async () => {
      mockModel.findById = jest.fn()
        .mockResolvedValueOnce(makeSubMerchant())
        .mockResolvedValueOnce(null);

      await expect(
        service.moveSubAccount("merchant-sub-001", "nonexistent"),
      ).rejects.toThrow(/not found/i);
    });

    it("throws when new parent has reached max sub-accounts", async () => {
      const fullParent: Merchant = {
        ...baseMerchant,
        id: "merchant-full",
        email: "f@e.com",
        maxSubAccounts: 1,
      };
      mockModel.findById = jest.fn()
        .mockResolvedValueOnce(makeSubMerchant())
        .mockResolvedValueOnce(fullParent);
      mockModel.findDescendants = jest.fn().mockResolvedValue([]);
      mockModel.findSubAccounts = jest.fn().mockResolvedValue({
        merchants: [makeSubMerchant({ id: "existing-sub", email: "e@e.com" })],
        total: 1,
      });

      await expect(
        service.moveSubAccount("merchant-sub-001", "merchant-full"),
      ).rejects.toThrow(/maximum/i);
    });
  });
});
