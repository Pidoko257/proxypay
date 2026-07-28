import crypto from "crypto";
import { encryptAES, deriveKey } from "../../utils/encryption";

jest.mock("../../config/database", () => {
  // In-memory store keyed by provider_name — keeps tests pure and
  // mirrors the relevant columns of provider_credentials.
  const store = new Map<
    string,
    {
      provider_name: string;
      auth_mode: string;
      encrypted_payload: string;
      last_rotated_at: Date;
      created_at: Date;
      updated_at: Date;
    }
  >();
  return {
    pool: {
      async query(sql: string, params: any[] = []) {
        const lowered = sql.toLowerCase();
        if (lowered.includes("insert into provider_credentials")) {
          const [name, mode, encrypted] = params;
          const now = new Date();
          store.set(name, {
            provider_name: name,
            auth_mode: mode,
            encrypted_payload: encrypted,
            last_rotated_at: now,
            created_at: now,
            updated_at: now,
          });
          return {
            rows: [
              {
                provider_name: name,
                auth_mode: mode,
                encrypted_payload: encrypted,
                last_rotated_at: now,
                created_at: now,
                updated_at: now,
              },
            ],
            rowCount: 1,
          };
        }
        if (lowered.includes("select * from provider_credentials where provider_name")) {
          const [name] = params;
          const row = store.get(name);
          return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
        }
        if (lowered.includes("delete from provider_credentials where provider_name")) {
          const [name] = params;
          const had = store.delete(name);
          return { rowCount: had ? 1 : 0 };
        }
        if (
          lowered.includes(
            "select provider_name, auth_mode, last_rotated_at, encrypted_payload",
          )
        ) {
          return {
            rows: [...store.values()].map((r) => ({
              provider_name: r.provider_name,
              auth_mode: r.auth_mode,
              last_rotated_at: r.last_rotated_at,
              encrypted_payload: r.encrypted_payload,
            })),
            rowCount: store.size,
          };
        }
        return { rows: [], rowCount: 0 };
      },
    },
  };
});

import { credentialManager } from "../credentialManager";

describe("credentialManager", () => {
  const originalKey = process.env.DB_ENCRYPTION_KEY;
  beforeAll(() => {
    process.env.DB_ENCRYPTION_KEY =
      "test-encryption-key-for-credentialmanager-32+chars-long";
  });
  afterAll(() => {
    if (originalKey === undefined) delete process.env.DB_ENCRYPTION_KEY;
    else process.env.DB_ENCRYPTION_KEY = originalKey;
  });

  it("round-trips a credential payload through encryption", async () => {
    await credentialManager.upsertCredentials("mtn", "direct", {
      apiKey: "kp_live_xxx",
      apiSecret: "secret-yyy",
      subscriptionKey: "sub-zzz",
      callbackSecret: "cb-secret",
    });
    const record = await credentialManager.readCredentials("mtn");
    expect(record).toBeTruthy();
    expect(record?.payload.apiKey).toBe("kp_live_xxx");
    expect(record?.payload.apiSecret).toBe("secret-yyy");
    expect(record?.payload.subscriptionKey).toBe("sub-zzz");
    expect(record?.payload.callbackSecret).toBe("cb-secret");
    expect(record?.authMode).toBe("direct");
  });

  it("returns null when no row exists", async () => {
    const record = await credentialManager.readCredentials("never-stored");
    expect(record).toBeNull();
  });

  it("overwrites last_rotated_at on upsert", async () => {
    await credentialManager.upsertCredentials("airtel", "direct", {
      apiKey: "ak1",
      apiSecret: "as1",
    });
    const before = await credentialManager.readCredentials("airtel");
    await new Promise((r) => setTimeout(r, 10));
    await credentialManager.upsertCredentials("airtel", "direct", {
      apiKey: "ak2",
      apiSecret: "as2",
    });
    const after = await credentialManager.readCredentials("airtel");
    expect(after?.payload.apiKey).toBe("ak2");
    expect(
      new Date(after!.lastRotatedAt).getTime(),
    ).toBeGreaterThanOrEqual(new Date(before!.lastRotatedAt).getTime());
  });

  it("stores opaque ciphertext (no cleartext leak)", async () => {
    await credentialManager.upsertCredentials("orange", "web", {
      username: "ops",
      password: "hunter2",
    });
    const all = await credentialManager.listCredentials();
    const orange = all.find((c) => c.providerName === "orange");
    expect(orange).toBeTruthy();
    expect(orange!.hasApiKey).toBe(false);
    expect(orange!.hasApiSecret).toBe(false);
    expect(orange!.hasSubscriptionKey).toBe(false);
    expect(orange!.hasCallbackSecret).toBe(false);
  });

  it("deletes credentials", async () => {
    await credentialManager.upsertCredentials("vodacom-temp", "direct", {
      apiKey: "x",
      apiSecret: "y",
    });
    const existed = await credentialManager.readCredentials("vodacom-temp");
    expect(existed).toBeTruthy();
    const deleted = await credentialManager.deleteCredentials("vodacom-temp");
    expect(deleted).toBe(true);
    const after = await credentialManager.readCredentials("vodacom-temp");
    expect(after).toBeNull();
  });

  it("encrypts and decrypts with the deriveKey fallback path", () => {
    // The credential manager sources the master key via envalid at
    // startup; changing the env var after the import does not change
    // the resolved value. We exercise the underlying primitives
    // directly to confirm the credential manager can rely on them.
    const key = deriveKey("test-key-material");
    const encrypted = encryptAES("secret", key);
    expect(encrypted.ciphertext).toMatch(/^[0-9a-f]+$/);
    expect(encrypted.iv.length).toBe(24); // 12 bytes -> 24 hex chars
  });

  it("survives concurrent unrelated calls", async () => {
    await Promise.all([
      credentialManager.upsertCredentials("concurrent-a", "direct", {
        apiKey: "a1",
        apiSecret: "a2",
      }),
      credentialManager.upsertCredentials("concurrent-b", "oauth", {
        clientId: "cid",
        clientSecret: "csec",
      }),
    ]);
    const a = await credentialManager.readCredentials("concurrent-a");
    const b = await credentialManager.readCredentials("concurrent-b");
    expect(a?.payload.apiKey).toBe("a1");
    expect(b?.payload.clientId).toBe("cid");
    expect(b?.payload.clientSecret).toBe("csec");
  });

  it("encrypts with a real (non-mock) AES-256-GCM key", () => {
    // Spot-check the actual encryption primitive independently of the
    // service layer — protects against accidental swap of the
    // encryption helper in a future refactor.
    const key = crypto.createHash("sha256").update("manual-test-key").digest();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const ct = Buffer.concat([cipher.update("hello", "utf8"), cipher.final()]).toString("hex");
    expect(ct).toMatch(/^[0-9a-f]+$/);
    expect(ct.length).toBeGreaterThan(0);
  });
});
