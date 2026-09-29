import express, { Request, Response } from "express";
import request from "supertest";
import {
  CallbackIdempotencyStore,
  callbackIdempotency,
  extractCallbackIdempotencyKey,
} from "../src/middleware/callbackIdempotency";

describe("Mobile Money Callback Processing Idempotency (Issue #679)", () => {
  let store: CallbackIdempotencyStore;

  beforeEach(() => {
    store = new CallbackIdempotencyStore();
  });

  describe("CallbackIdempotencyStore unit tests", () => {
    it("hashes payload with SHA-256 correctly", () => {
      const payload = { transactionId: "txn_123", amount: 5000, currency: "XAF" };
      const hash1 = store.hashPayload(payload);
      const hash2 = store.hashPayload(payload);
      expect(hash1).toBe(hash2);
      expect(hash1).toHaveLength(64);
    });

    it("records first callback and marks duplicate on second call", () => {
      const provider = "mtn";
      const key = "mtn_txn_001";
      const hash = store.hashPayload({ id: "001" });

      expect(store.findDuplicate(provider, key, hash)).toBeNull();

      store.recordCallback(provider, key, hash);

      const dup = store.findDuplicate(provider, key, hash);
      expect(dup).not.toBeNull();
      expect(dup?.idempotencyKey).toBe(key);
      expect(dup?.provider).toBe(provider);
      expect(dup?.payloadHash).toBe(hash);
    });

    it("detects duplicate even if key is absent but payload hash matches", () => {
      const provider = "airtel";
      const key = "gen_key_1";
      const hash = store.hashPayload({ ref: "airtel_ref_99" });

      store.recordCallback(provider, key, hash);

      const dup = store.findDuplicate(provider, "different_key", hash);
      expect(dup).not.toBeNull();
      expect(dup?.payloadHash).toBe(hash);
    });

    it("expires keys after TTL", () => {
      const shortTtlStore = new CallbackIdempotencyStore(10); // 10ms
      const provider = "orange";
      const key = "orange_txn_exp";
      const hash = shortTtlStore.hashPayload({ id: "exp" });

      shortTtlStore.recordCallback(provider, key, hash);
      expect(shortTtlStore.findDuplicate(provider, key, hash)).not.toBeNull();

      // Wait 15ms for expiration
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          expect(shortTtlStore.findDuplicate(provider, key, hash)).toBeNull();
          resolve();
        }, 20);
      });
    });
  });

  describe("extractCallbackIdempotencyKey", () => {
    it("extracts from x-callback-id header", () => {
      const req = {
        header: (name: string) => (name.toLowerCase() === "x-callback-id" ? "cb-hdr-123" : undefined),
        body: {},
      } as any;
      expect(extractCallbackIdempotencyKey(req, "mtn")).toBe("cb-hdr-123");
    });

    it("extracts from x-idempotency-key header", () => {
      const req = {
        header: (name: string) => (name.toLowerCase() === "x-idempotency-key" ? "idem-key-456" : undefined),
        body: {},
      } as any;
      expect(extractCallbackIdempotencyKey(req, "airtel")).toBe("idem-key-456");
    });

    it("extracts from body financialTransactionId", () => {
      const req = {
        header: () => undefined,
        body: { financialTransactionId: "fin_txn_789" },
      } as any;
      expect(extractCallbackIdempotencyKey(req, "mtn")).toBe("fin_txn_789");
    });

    it("extracts from body transactionId", () => {
      const req = {
        header: () => undefined,
        body: { transactionId: "txn_orange_001" },
      } as any;
      expect(extractCallbackIdempotencyKey(req, "orange")).toBe("txn_orange_001");
    });

    it("generates SHA-256 fallback when no headers or ID fields exist", () => {
      const req = {
        header: () => undefined,
        body: { status: "SUCCESSFUL", amount: 1000 },
      } as any;
      const key = extractCallbackIdempotencyKey(req, "mtn");
      expect(key).toHaveLength(64);
    });
  });

  describe("Express Middleware HTTP Flow", () => {
    let app: express.Express;
    let downstreamHandlerCalledCount = 0;

    beforeEach(() => {
      downstreamHandlerCalledCount = 0;
      app = express();
      app.use(express.json());
      app.use(callbackIdempotency({ provider: "mtn", store }));

      app.post("/callback", (req: Request, res: Response) => {
        downstreamHandlerCalledCount++;
        res.status(200).json({ status: "accepted", processed: true });
      });
    });

    it("processes the initial callback and executes downstream handler", async () => {
      const payload = {
        financialTransactionId: "fin_momo_001",
        status: "SUCCESSFUL",
        amount: 2500,
      };

      const res = await request(app).post("/callback").send(payload);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("accepted");
      expect(res.body.processed).toBe(true);
      expect(res.headers["x-callback-duplicate"]).toBeUndefined();
      expect(downstreamHandlerCalledCount).toBe(1);
    });

    it("skips downstream processing when a duplicate callback arrives", async () => {
      const payload = {
        financialTransactionId: "fin_momo_002",
        status: "SUCCESSFUL",
        amount: 5000,
      };

      // 1st request
      const res1 = await request(app).post("/callback").send(payload);
      expect(res1.status).toBe(200);
      expect(res1.body.processed).toBe(true);
      expect(downstreamHandlerCalledCount).toBe(1);

      // 2nd duplicate request
      const res2 = await request(app).post("/callback").send(payload);
      expect(res2.status).toBe(200);
      expect(res2.body.duplicate).toBe(true);
      expect(res2.body.status).toBe("accepted");
      expect(res2.headers["x-callback-duplicate"]).toBe("true");

      // Downstream handler was NOT called a second time!
      expect(downstreamHandlerCalledCount).toBe(1);
    });

    it("detects duplicates sent via X-Callback-Id header", async () => {
      // 1st request
      const res1 = await request(app)
        .post("/callback")
        .set("X-Callback-Id", "webhook_cb_abc")
        .send({ status: "COMPLETED" });
      expect(res1.status).toBe(200);
      expect(downstreamHandlerCalledCount).toBe(1);

      // 2nd duplicate request
      const res2 = await request(app)
        .post("/callback")
        .set("X-Callback-Id", "webhook_cb_abc")
        .send({ status: "COMPLETED" });
      expect(res2.status).toBe(200);
      expect(res2.body.duplicate).toBe(true);
      expect(res2.headers["x-callback-duplicate"]).toBe("true");

      // Downstream handler was NOT called again!
      expect(downstreamHandlerCalledCount).toBe(1);
    });
  });
});