import {
  ApiKeyScope,
  ScopeSets,
  listAllScopeNames,
  createApiKey,
  generateApiKey,
  validateApiKey,
  describeScopes,
  validateTimeWindow,
  hasScope,
} from "../apikeys";
import bcrypt from "bcrypt";

describe("ApiKey scopes and helpers", () => {
  test("ScopeSets exposes resource arrays", () => {
    expect(ScopeSets).toHaveProperty("TRANSACTIONS");
    expect(ScopeSets.TRANSACTIONS).toEqual(
      expect.arrayContaining(["TRANSACTIONS_READ", "TRANSACTIONS_WRITE"]),
    );
    expect(ScopeSets).toHaveProperty("DEPOSITS");
    expect(ScopeSets.DEPOSITS).toEqual(
      expect.arrayContaining(["DEPOSITS_READ", "DEPOSITS_INITIATE"]),
    );
  });

  test("listAllScopeNames includes known scopes", () => {
    const all = listAllScopeNames();
    expect(all).toEqual(expect.arrayContaining(["DEPOSITS_INITIATE", "TRANSACTIONS_READ"]));
  });

  test("generateApiKey formats key as pk_{env}_{64hex}", () => {
    const key = generateApiKey("production");
    expect(key).toMatch(/^pk_production_[a-f0-9]{64}$/);

    const defaultKey = generateApiKey();
    expect(defaultKey).toMatch(/^pk_[a-zA-Z0-9_-]+_[a-f0-9]{64}$/);
  });

  test("createApiKey generates keyPrefix, cost-12 keyHash, and raw key", () => {
    const user: { apiKeys?: any[] } = { apiKeys: [] };
    const keyObj = createApiKey(user, {
      env: "test",
      scopes: ["DEPOSITS_INITIATE", "DEPOSITS_READ"],
      expiresInDays: 1,
    });

    expect(keyObj.key).toBeDefined();
    expect(keyObj.key).toMatch(/^pk_test_[a-f0-9]{64}$/);
    expect(keyObj.keyPrefix).toBe(keyObj.key!.slice(0, 8));
    expect(keyObj.keyHash).toBeDefined();
    expect(bcrypt.compareSync(keyObj.key!, keyObj.keyHash)).toBe(true);

    expect(keyObj.scopes).toEqual(expect.arrayContaining(["DEPOSITS_INITIATE", "DEPOSITS_READ"]));
    expect((keyObj.permissions & ApiKeyScope.DEPOSITS_INITIATE) === ApiKeyScope.DEPOSITS_INITIATE).toBe(true);
    expect((keyObj.permissions & ApiKeyScope.DEPOSITS_READ) === ApiKeyScope.DEPOSITS_READ).toBe(true);
  });

  test("validateApiKey validates incoming key against prefix and bcrypt keyHash", () => {
    const user: { apiKeys?: any[] } = { apiKeys: [] };
    const createdKey = createApiKey(user, { env: "test" });
    const rawKey = createdKey.key!;

    const found = validateApiKey(user, rawKey);
    expect(found).toBeDefined();
    expect(found?.keyPrefix).toBe(rawKey.slice(0, 8));

    const invalidKey = "pk_test_invalidkeythatisnotmatchinganything1234567890abcdef12345678";
    expect(validateApiKey(user, invalidKey)).toBeNull();
  });

  test("describeScopes returns names for a permission bitmask", () => {
    const mask = ApiKeyScope.TRANSACTIONS_READ | ApiKeyScope.BALANCE_READ;
    const names = describeScopes(mask);
    expect(names).toEqual(expect.arrayContaining(["TRANSACTIONS_READ", "BALANCE_READ"]));
  });

  test("validateTimeWindow catches invalid values and accepts valid windows", () => {
    expect(validateTimeWindow({ startHour: 24, endHour: 1 })).toBeTruthy();
    expect(validateTimeWindow({ startHour: 1, endHour: 1 })).toBe("startHour and endHour must differ");
    expect(validateTimeWindow({ startHour: 0, endHour: 23 })).toBeNull();
  });

  test("hasScope recognizes a granted scope", () => {
    const mask = ApiKeyScope.DEPOSITS_INITIATE | ApiKeyScope.DEPOSITS_READ;
    const fakeKey = { permissions: mask } as any;
    expect(hasScope(fakeKey, ApiKeyScope.DEPOSITS_INITIATE)).toBe(true);
    expect(hasScope(fakeKey, ApiKeyScope.TRANSACTIONS_READ)).toBe(false);
  });
});
