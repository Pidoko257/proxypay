import {
  validateMemoForDestination,
  isKnownExchangeAddress,
} from "../memoValidationService";
import {
  addExchangeAddress,
  removeExchangeAddress,
  resetExchangeAddressRegistry,
  getAllExchangeAddresses,
} from "../../config/exchangeAddresses";

describe("memoValidationService", () => {
  // Use addresses from the initial config
  const COINBASE_ADDRESS = "GCO2IP3MJNUOKS4PUDI4C7LGGMQDJGXG3COYX3WSB4HHNAHKYV5YL3VC";
  const BINANCE_ADDRESS = "GB7GRJ5DTE3AA2TCVHQS2LAD3D7NFG7YLTOEWEBVRNUUI2Q3TJ5UQIFM";

  beforeEach(() => {
    resetExchangeAddressRegistry();
  });

  describe("validateMemoForDestination", () => {
    it("should return valid=true for addresses that are not known exchanges", () => {
      const result = validateMemoForDestination(
        "GBBM6BKZPEHWYO3E3YKREDPQXMS4VK35YLNU7NFBRI26RAN7GI5POFBB",
      );
      expect(result.valid).toBe(true);
    });

    it("should return valid=true for known exchange address with valid memo", () => {
      const result = validateMemoForDestination(COINBASE_ADDRESS, "123456", "id");
      expect(result.valid).toBe(true);
    });

    it("should return valid=false when memo is missing for a known exchange address", () => {
      const result = validateMemoForDestination(COINBASE_ADDRESS);
      expect(result.valid).toBe(false);
      expect(result.errorCode).toBe("ERR_MEMO_REQUIRED");
      expect(result.requiredMemoType).toBe("id");
      expect(result.exchangeName).toBe("Coinbase");
    });

    it("should return valid=false when memo is empty for a known exchange address", () => {
      const result = validateMemoForDestination(COINBASE_ADDRESS, "", "id");
      expect(result.valid).toBe(false);
      expect(result.errorCode).toBe("ERR_MEMO_REQUIRED");
    });

    it("should return valid=false when memo type mismatches required memo type", () => {
      const result = validateMemoForDestination(
        COINBASE_ADDRESS,
        "hello world",
        "text",
      );
      expect(result.valid).toBe(false);
      expect(result.errorCode).toBe("ERR_MEMO_TYPE_MISMATCH");
      expect(result.requiredMemoType).toBe("id");
    });

    it("should accept memo without explicit type (backward compatibility)", () => {
      // If memo is provided but type is not, we don't enforce type checking
      const result = validateMemoForDestination(COINBASE_ADDRESS, "123456");
      expect(result.valid).toBe(true);
    });

    it("should validate Binance address requires 'id' memo type", () => {
      const result = validateMemoForDestination(BINANCE_ADDRESS);
      expect(result.valid).toBe(false);
      expect(result.errorCode).toBe("ERR_MEMO_REQUIRED");
      expect(result.requiredMemoType).toBe("id");
      expect(result.exchangeName).toBe("Binance");
    });

    it("should validate addresses case-insensitively", () => {
      const lowerCaseAddr = COINBASE_ADDRESS.toLowerCase();
      const result = validateMemoForDestination(lowerCaseAddr);
      expect(result.valid).toBe(false);
      expect(result.errorCode).toBe("ERR_MEMO_REQUIRED");
    });

    it("should handle whitespace in addresses", () => {
      const result = validateMemoForDestination("  " + COINBASE_ADDRESS + "  ");
      expect(result.valid).toBe(false);
      expect(result.errorCode).toBe("ERR_MEMO_REQUIRED");
    });
  });

  describe("isKnownExchangeAddress", () => {
    it("should return true for known exchange address", () => {
      expect(isKnownExchangeAddress(COINBASE_ADDRESS)).toBe(true);
    });

    it("should return false for unknown address", () => {
      expect(
        isKnownExchangeAddress(
          "GBBM6BKZPEHWYO3E3YKREDPQXMS4VK35YLNU7NFBRI26RAN7GI5POFBB",
        ),
      ).toBe(false);
    });
  });

  describe("with dynamically added addresses", () => {
    it("should validate against newly added exchange addresses", () => {
      const newAddress = "GBBM6BKZPEHWYO3E3YKREDPQXMS4VK35YLNU7NFBRI26RAN7GI5POFBB";
      addExchangeAddress({
        address: newAddress,
        name: "TestExchange",
        requiredMemoType: "text",
        description: "Test exchange requiring text memo",
        addedBy: "test",
      });

      const result = validateMemoForDestination(newAddress);
      expect(result.valid).toBe(false);
      expect(result.errorCode).toBe("ERR_MEMO_REQUIRED");
      expect(result.requiredMemoType).toBe("text");
      expect(result.exchangeName).toBe("TestExchange");
    });

    it("should not require memo for removed exchange addresses", () => {
      removeExchangeAddress(COINBASE_ADDRESS);
      const result = validateMemoForDestination(COINBASE_ADDRESS);
      expect(result.valid).toBe(true);
    });

    it("should throw when adding duplicate address", () => {
      expect(() => {
        addExchangeAddress({
          address: COINBASE_ADDRESS,
          name: "DuplicateCoinbase",
          requiredMemoType: "text",
          addedBy: "test",
        });
      }).toThrow(/already registered/);
    });
  });
});
