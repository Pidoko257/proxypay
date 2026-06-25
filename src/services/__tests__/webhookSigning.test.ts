import { signPayload, verifySignature } from "../webhookSigning";

const SECRET = "test-secret";

describe("signPayload", () => {
  it("produces a known vector (v1)", () => {
    expect(signPayload(SECRET, "1700000000", '{"event":"transaction.completed"}')).toBe(
      "04754999c7d1ce6d94f38ddc2fc6acc873d336426ad6c0ccd1924999f1bb855d",
    );
  });

  it("produces a known vector (v2)", () => {
    expect(
      signPayload(SECRET, "1700000001", '{"event":"transaction.failed","id":"txn_abc"}'),
    ).toBe("65c55592a2fc8a0830fb1424a40aa73d3eaf0460618c1670e8523928b6fabd8a");
  });

  it("is sensitive to body changes", () => {
    const sig1 = signPayload(SECRET, "1700000000", '{"a":"1"}');
    const sig2 = signPayload(SECRET, "1700000000", '{"a":"2"}');
    expect(sig1).not.toBe(sig2);
  });

  it("is sensitive to timestamp changes", () => {
    const body = '{"event":"tx"}';
    expect(signPayload(SECRET, "1700000000", body)).not.toBe(
      signPayload(SECRET, "1700000001", body),
    );
  });

  it("is sensitive to secret changes", () => {
    const body = '{"event":"tx"}';
    expect(signPayload("secret-a", "1700000000", body)).not.toBe(
      signPayload("secret-b", "1700000000", body),
    );
  });
});

describe("verifySignature", () => {
  const TS = 1700000000;
  const BODY = '{"event":"transaction.completed"}';
  // Pre-computed: signPayload(SECRET, "1700000000", BODY)
  const VALID_SIG = "04754999c7d1ce6d94f38ddc2fc6acc873d336426ad6c0ccd1924999f1bb855d";
  // now = TS * 1000 so age = 0
  const NOW = TS * 1000;

  it("returns ok for a valid signature within tolerance", () => {
    expect(
      verifySignature({ secret: SECRET, timestamp: String(TS), rawBody: BODY, signature: VALID_SIG, now: NOW }),
    ).toEqual({ ok: true });
  });

  it("returns ok at the boundary (exactly 5 min old)", () => {
    expect(
      verifySignature({
        secret: SECRET,
        timestamp: String(TS),
        rawBody: BODY,
        signature: VALID_SIG,
        now: NOW + 5 * 60 * 1000,
      }),
    ).toEqual({ ok: true });
  });

  it("rejects a timestamp just beyond 5-minute tolerance", () => {
    const result = verifySignature({
      secret: SECRET,
      timestamp: String(TS),
      rawBody: BODY,
      signature: VALID_SIG,
      now: NOW + 5 * 60 * 1000 + 1,
    });
    expect(result).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects a future timestamp beyond tolerance", () => {
    const result = verifySignature({
      secret: SECRET,
      timestamp: String(TS + 400),
      rawBody: BODY,
      signature: VALID_SIG,
      now: NOW,
    });
    expect(result).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects an invalid signature", () => {
    const result = verifySignature({
      secret: SECRET,
      timestamp: String(TS),
      rawBody: BODY,
      signature: "0000000000000000000000000000000000000000000000000000000000000000",
      now: NOW,
    });
    expect(result).toEqual({ ok: false, reason: "invalid" });
  });

  it("rejects when body is tampered", () => {
    const result = verifySignature({
      secret: SECRET,
      timestamp: String(TS),
      rawBody: '{"event":"transaction.failed"}',
      signature: VALID_SIG,
      now: NOW,
    });
    expect(result).toEqual({ ok: false, reason: "invalid" });
  });

  it("rejects a non-numeric timestamp", () => {
    const result = verifySignature({
      secret: SECRET,
      timestamp: "not-a-number",
      rawBody: BODY,
      signature: VALID_SIG,
      now: NOW,
    });
    expect(result).toEqual({ ok: false, reason: "expired" });
  });
});
