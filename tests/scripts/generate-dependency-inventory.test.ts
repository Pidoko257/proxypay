import fs from "fs";
import path from "path";
import {
  classifyDependency,
  generateDependencyInventory,
  formatInventoryMarkdown,
} from "../../src/scripts/generate-dependency-inventory";

describe("generate-dependency-inventory", () => {
  describe("classifyDependency", () => {
    it("classifies payment and provider packages", () => {
      expect(classifyDependency("@stellar/stellar-sdk")).toBe("payment_provider");
      expect(classifyDependency("stripe")).toBe("payment_provider");
      expect(classifyDependency("paypal-rest-sdk")).toBe("payment_provider");
      expect(classifyDependency("mtn-momo-client")).toBe("payment_provider");
    });

    it("classifies cryptography packages", () => {
      expect(classifyDependency("jsonwebtoken")).toBe("cryptography");
      expect(classifyDependency("bcrypt")).toBe("cryptography");
      expect(classifyDependency("crypto-js")).toBe("cryptography");
      expect(classifyDependency("libsodium-wrappers")).toBe("cryptography");
    });

    it("classifies cloud infrastructure packages", () => {
      expect(classifyDependency("@aws-sdk/client-s3")).toBe("cloud_infrastructure");
      expect(classifyDependency("@google-cloud/storage")).toBe("cloud_infrastructure");
      expect(classifyDependency("@azure/identity")).toBe("cloud_infrastructure");
    });

    it("classifies database and cache packages", () => {
      expect(classifyDependency("pg")).toBe("database_cache");
      expect(classifyDependency("ioredis")).toBe("database_cache");
      expect(classifyDependency("knex")).toBe("database_cache");
    });

    it("classifies network and HTTP packages", () => {
      expect(classifyDependency("express")).toBe("network_http");
      expect(classifyDependency("axios")).toBe("network_http");
      expect(classifyDependency("ws")).toBe("network_http");
    });

    it("defaults to runtime utility for other packages", () => {
      expect(classifyDependency("lodash")).toBe("runtime_utility");
      expect(classifyDependency("zod")).toBe("runtime_utility");
    });
  });

  describe("generateDependencyInventory & formatInventoryMarkdown", () => {
    it("generates structured inventory from project files", () => {
      const inventory = generateDependencyInventory(process.cwd());

      expect(inventory).toBeDefined();
      expect(inventory.totalDirect).toBeGreaterThan(0);
      expect(inventory.totalPackages).toBeGreaterThanOrEqual(inventory.totalDirect);
      expect(inventory.categories.payment_provider).toBeDefined();
      expect(inventory.categories.cryptography).toBeDefined();

      const markdown = formatInventoryMarkdown(inventory);
      expect(markdown).toContain("ProxyPay Dependency Inventory & Release Review");
      expect(markdown).toContain("Total Direct Dependencies");
      expect(markdown).toContain("Breakdown by Category");
    });
  });
});
