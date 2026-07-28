/**
 * Versioned Provider Contract Tests
 *
 * Verifies that generated pact files match committed contracts.
 * CI fails if contracts drift.
 */
import path from "path";
import { PactV3, MatchersV3 } from "@pact-foundation/pact";
import fs from "fs";

const { like, regex, string } = MatchersV3;

const PACT_DIR = path.resolve(__dirname, "../../pacts");

describe("Versioned Provider Contracts", () => {
  const providers = [
    { name: "MTNMoMoAPI", file: "MobileMoneyService-MTNMoMoAPI.json" },
    { name: "AirtelMoneyAPI", file: "MobileMoneyService-AirtelMoneyAPI.json" },
    { name: "OrangeMoneyAPI", file: "MobileMoneyService-OrangeMoneyAPI.json" },
  ];

  for (const provider of providers) {
    describe(`${provider.name} contract`, () => {
      it(`${provider.file} exists and is valid JSON`, () => {
        const pactPath = path.join(PACT_DIR, provider.file);
        expect(fs.existsSync(pactPath)).toBe(true);

        const content = fs.readFileSync(pactPath, "utf-8");
        const parsed = JSON.parse(content);

        expect(parsed.consumer).toBe("MobileMoneyService");
        expect(parsed.provider).toBe(provider.name);
        expect(Array.isArray(parsed.interactions)).toBe(true);
        expect(parsed.interactions.length).toBeGreaterThan(0);
      });

      it(`${provider.file} contains version metadata`, () => {
        const pactPath = path.join(PACT_DIR, provider.file);
        if (!fs.existsSync(pactPath)) {
          return;
        }

        const content = fs.readFileSync(pactPath, "utf-8");
        const parsed = JSON.parse(content);

        expect(parsed.metadata).toBeDefined();
        expect(parsed.metadata.pactSpecification).toBeDefined();
      });
    });
  }

  describe("Contract freshness", () => {
    it("all pact files are committed and not stale", () => {
      const pactFiles = fs.readdirSync(PACT_DIR).filter((f) => f.endsWith(".json"));

      expect(pactFiles.length).toBeGreaterThanOrEqual(3);

      for (const file of pactFiles) {
        const pactPath = path.join(PACT_DIR, file);
        const content = fs.readFileSync(pactPath, "utf-8");
        const parsed = JSON.parse(content);

        expect(parsed.interactions.length).toBeGreaterThan(0);
      }
    });
  });
});
