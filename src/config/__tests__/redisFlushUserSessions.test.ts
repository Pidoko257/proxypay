const store = new Map<string, string>();
const pipelineUnlink = jest.fn();
const pipelineExec = jest.fn();

const mockClient = {
  isOpen: true,
  on: jest.fn(),
  set: jest.fn(async (key: string, value: string) => {
    store.set(key, value);
  }),
  publish: jest.fn(async () => 1),
  get: jest.fn(async (key: string) => store.get(key) ?? null),
  del: jest.fn(),
  scan: jest.fn(),
  mGet: jest.fn(async (keys: string[]) => keys.map((k) => store.get(k) ?? null)),
  multi: jest.fn(() => {
    const pipeline = {
      unlink: (key: string) => {
        pipelineUnlink(key);
        return pipeline;
      },
      exec: async () => {
        pipelineExec();
        return [];
      },
    };
    return pipeline;
  }),
};

jest.mock("redis", () => ({
  createClient: jest.fn(() => mockClient),
}));
jest.mock("connect-redis", () => jest.fn());

import { flushUserSessions } from "../redis";

describe("flushUserSessions", () => {
  beforeEach(() => {
    store.clear();
    jest.clearAllMocks();
  });

  it("batches reads with MGET and deletes matches in one pipeline per SCAN page", async () => {
    store.set("session:a", JSON.stringify({ userId: "u1" }));
    store.set("session:b", JSON.stringify({ userId: "u2" }));
    store.set("session:c", JSON.stringify({ user_id: "u1" }));
    store.set("session:d", JSON.stringify({ userId: "u1" }));

    mockClient.scan
      .mockResolvedValueOnce({ cursor: "7", keys: ["session:a", "session:b", "session:c"] })
      .mockResolvedValueOnce({ cursor: "0", keys: ["session:d", "session:missing"] });

    await flushUserSessions("u1");

    // One MGET per scan page, never a per-key GET/DEL round trip.
    expect(mockClient.mGet).toHaveBeenCalledTimes(2);
    expect(mockClient.get).not.toHaveBeenCalled();
    expect(mockClient.del).not.toHaveBeenCalled();

    expect(mockClient.multi).toHaveBeenCalledTimes(2);
    expect(pipelineExec).toHaveBeenCalledTimes(2);
    expect(pipelineUnlink.mock.calls.map((c) => c[0])).toEqual([
      "session:a",
      "session:c",
      "session:d",
    ]);

    expect(mockClient.set).toHaveBeenCalledWith("user:u1:jwt_invalidated_at", expect.any(String));
  });

  it("skips the pipeline entirely when a page has no matching sessions", async () => {
    store.set("session:x", JSON.stringify({ userId: "someone-else" }));
    mockClient.scan
      .mockResolvedValueOnce({ cursor: "3", keys: [] })
      .mockResolvedValueOnce({ cursor: "0", keys: ["session:x"] });

    await flushUserSessions("u1");

    expect(mockClient.mGet).toHaveBeenCalledTimes(1);
    expect(mockClient.multi).not.toHaveBeenCalled();
  });
});
