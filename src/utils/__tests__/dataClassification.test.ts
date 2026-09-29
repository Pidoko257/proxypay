/**
 * #649 – Data classification and selective masking for GDPR exports.
 */
import {
  REDACTED,
  classifyField,
  isMaskedByDefault,
  maskValue,
  maskExportData,
} from "../dataClassification";

describe("classifyField", () => {
  it("classifies public identifiers and state", () => {
    expect(classifyField("id")).toBe("public");
    expect(classifyField("status")).toBe("public");
    expect(classifyField("created_at")).toBe("public");
  });

  it("classifies financial fields as internal", () => {
    expect(classifyField("amount")).toBe("internal");
    expect(classifyField("user_fees")).toBe("internal");
    expect(classifyField("provider_fees")).toBe("internal");
  });

  it("classifies direct identifiers as confidential", () => {
    expect(classifyField("phone_number")).toBe("confidential");
    expect(classifyField("email")).toBe("confidential");
    expect(classifyField("stellar_address")).toBe("confidential");
  });

  it("classifies authentication material as restricted", () => {
    expect(classifyField("two_factor_secret")).toBe("restricted");
    expect(classifyField("backup_codes")).toBe("restricted");
    expect(classifyField("webhook_secret")).toBe("restricted");
  });

  it("matches snake_case and camelCase spellings alike", () => {
    expect(classifyField("phoneNumber")).toBe("confidential");
    expect(classifyField("stellarAddress")).toBe("confidential");
    expect(classifyField("twoFactorSecret")).toBe("restricted");
  });

  it("treats an unknown field as confidential so new columns do not leak", () => {
    expect(classifyField("some_brand_new_column")).toBe("confidential");
  });
});

describe("isMaskedByDefault", () => {
  it("masks confidential and restricted, but not public or internal", () => {
    expect(isMaskedByDefault("public")).toBe(false);
    expect(isMaskedByDefault("internal")).toBe(false);
    expect(isMaskedByDefault("confidential")).toBe(true);
    expect(isMaskedByDefault("restricted")).toBe(true);
  });
});

describe("maskValue", () => {
  it("leaves public values untouched", () => {
    expect(maskValue("completed", "status")).toBe("completed");
  });

  it("partially masks a phone number so the subject can still recognise it", () => {
    const masked = maskValue("+237677123456", "phone_number");
    expect(masked).not.toBe("+237677123456");
    expect(String(masked)).toMatch(/\*/);
  });

  it("partially masks an email address", () => {
    const masked = maskValue("johndoe@example.com", "email");
    expect(masked).toMatch(/\*\*\*@example\.com$/);
  });

  it("redacts a Stellar address", () => {
    const masked = maskValue(
      "GDFRUYRH6AZC64IAEO5RTYYGYSUCJ65QGZICQEVNNYE2Y25X2NW7NFXP",
      "stellar_address",
    );
    expect(String(masked)).toMatch(/\.\.\./);
  });

  it("redacts internal amounts unless includeInternal is set", () => {
    expect(maskValue("1250.75", "amount")).toBe(REDACTED);
    expect(maskValue("1250.75", "amount", { includeInternal: true })).toBe(
      "1250.75",
    );
  });

  it("returns confidential values in the clear only when opted in", () => {
    expect(maskValue("a@b.com", "email", { includeConfidential: true })).toBe(
      "a@b.com",
    );
  });

  it("redacts restricted material even when everything else is included", () => {
    expect(
      maskValue("JBSWY3DPEHPK3PXP", "two_factor_secret", {
        includeConfidential: true,
        includeInternal: true,
      }),
    ).toBe(REDACTED);
  });

  it("passes null through unchanged", () => {
    expect(maskValue(null, "email")).toBeNull();
  });
});

describe("maskExportData", () => {
  const user = {
    id: "user-1",
    phone_number: "+237677123456",
    email: "ada@example.com",
    kyc_level: "tier2",
    two_factor_secret: "JBSWY3DPEHPK3PXP",
    backup_codes: ["aaa", "bbb"],
  };

  it("masks PII by default", () => {
    const { data } = maskExportData(user) as { data: typeof user };

    expect(data.id).toBe("user-1");
    expect(data.kyc_level).toBe("tier2");
    expect(data.phone_number).not.toBe("+237677123456");
    expect(data.email).not.toBe("ada@example.com");
  });

  it("never exposes restricted material under any option combination", () => {
    const { data } = maskExportData(user, {
      includeConfidential: true,
      includeInternal: true,
    }) as { data: typeof user };

    expect(data.two_factor_secret).toBe(REDACTED);
    // Each element of a restricted array is redacted individually, so no code
    // survives even partially.
    expect(data.backup_codes).toEqual([REDACTED, REDACTED]);
  });

  it("includes confidential values when explicitly requested", () => {
    const { data } = maskExportData(user, {
      includeConfidential: true,
    }) as { data: typeof user };

    expect(data.email).toBe("ada@example.com");
    expect(data.two_factor_secret).toBe(REDACTED);
  });

  it("reports which fields were withheld and why", () => {
    const { maskedFields } = maskExportData(user);

    const paths = maskedFields.map((f) => f.path);
    expect(paths).toContain("phone_number");
    expect(paths).toContain("email");
    expect(paths).toContain("two_factor_secret");
    expect(
      maskedFields.find((f) => f.path === "two_factor_secret")?.classification,
    ).toBe("restricted");
  });

  it("recurses into arrays and reports indexed paths", () => {
    const txs = [
      { id: "t1", amount: "10.00", stellar_address: "GABC" },
      { id: "t2", amount: "20.00", stellar_address: "GDEF" },
    ];

    const { data, maskedFields } = maskExportData(txs, {}, "transactions");
    const rows = data as typeof txs;

    expect(rows[0].id).toBe("t1");
    expect(rows[0].amount).toBe(REDACTED);
    expect(rows[1].amount).toBe(REDACTED);
    expect(maskedFields[0].path).toBe("transactions[0].amount");
  });

  it("masks nested objects", () => {
    const { data } = maskExportData(
      { metadata: { payer: { phone_number: "+237677000000" } } },
      {},
      "tx",
    ) as { data: any };

    expect(data.metadata.payer.phone_number).not.toBe("+237677000000");
  });

  it("leaves null and undefined values alone", () => {
    const { data } = maskExportData({ email: null, phone_number: undefined });
    expect(data).toEqual({ email: null, phone_number: undefined });
  });
});

