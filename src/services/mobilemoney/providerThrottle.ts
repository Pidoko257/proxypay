import { Queue, QueueEvents, Worker } from "bullmq";
import IORedis from "ioredis";

const QUEUE_NAME = "mobile-money-provider-calls";
const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";
const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
const queue = new Queue(QUEUE_NAME, { connection });
const queueEvents = new QueueEvents(QUEUE_NAME, { connection });

const TAKE_TOKEN_SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local rate = tonumber(ARGV[2])
local capacity = tonumber(ARGV[3])
local requested = tonumber(ARGV[4])
local values = redis.call('HMGET', key, 'tokens', 'timestamp')
local tokens = tonumber(values[1])
local timestamp = tonumber(values[2])
if not tokens then tokens = capacity end
if not timestamp then timestamp = now end
local elapsed = math.max(0, now - timestamp)
tokens = math.min(capacity, tokens + elapsed * rate)
local granted = 0
local wait_ms = 0
if tokens >= requested then
  tokens = tokens - requested
  granted = 1
else
  wait_ms = math.ceil((requested - tokens) / rate)
end
redis.call('HSET', key, 'tokens', tokens, 'timestamp', now)
redis.call('PEXPIRE', key, math.ceil((capacity / rate) * 1000) + 60000)
return { granted, wait_ms }
`;

export type ProviderCall =
  | { operation: "payment"; provider: string; phoneNumber: string; amount: string }
  | { operation: "payout"; provider: string; phoneNumber: string; amount: string }
  | { operation: "batchPayout"; provider: string; items: unknown[] };

function settings(provider: string) {
  const prefix = provider.toUpperCase();
  const rate = Number(process.env[`${prefix}_MOMO_TOKENS_PER_SECOND`] || "5");
  const capacity = Number(process.env[`${prefix}_MOMO_BUCKET_CAPACITY`] || String(Math.max(1, rate)));
  if (!Number.isFinite(rate) || rate <= 0 || !Number.isFinite(capacity) || capacity <= 0) {
    throw new Error(`Invalid ${prefix} MoMo token bucket configuration`);
  }
  return { rate, capacity };
}

function enabled(): boolean {
  if (process.env.PROVIDER_THROTTLING_ENABLED === "false") return false;
  return process.env.NODE_ENV !== "test" || process.env.PROVIDER_THROTTLING_ENABLED === "true";
}

async function takeToken(provider: string, requested = 1): Promise<void> {
  const { rate, capacity } = settings(provider);
  const result = (await connection.eval(
    TAKE_TOKEN_SCRIPT,
    1,
    `provider-throttle:${provider}`,
    String(Date.now()),
    String(rate / 1000),
    String(capacity),
    String(requested),
  )) as [number, number];
  if (Number(result[0]) === 1) return;
  await new Promise((resolve) => setTimeout(resolve, Number(result[1])));
  return takeToken(provider, requested);
}

let workerStarted = false;
function ensureWorker(): void {
  if (workerStarted) return;
  workerStarted = true;
  new Worker(
    QUEUE_NAME,
    async (job) => {
      const call = job.data as ProviderCall;
      await takeToken(
        call.provider,
        call.operation === "batchPayout" ? Math.max(1, call.items.length) : 1,
      );
      // Load the compiled implementation directly to avoid re-enqueueing this job.
      const { MobileMoneyService: BaseMobileMoneyService } = require("./mobileMoneyService_impl.js");
      const service = new BaseMobileMoneyService();
      if (call.operation === "payment") return service.initiatePayment(call.provider, call.phoneNumber, call.amount);
      if (call.operation === "payout") return service.sendPayout(call.provider, call.phoneNumber, call.amount);
      return service.sendBatchPayout(call.provider, call.items);
    },
    { connection, concurrency: Number(process.env.PROVIDER_THROTTLE_CONCURRENCY || "10") },
  );
}

export async function enqueueProviderCall<T>(call: ProviderCall): Promise<T> {
  if (!enabled()) {
    const { MobileMoneyService: BaseMobileMoneyService } = require("./mobileMoneyService_impl.js");
    const service = new BaseMobileMoneyService();
    if (call.operation === "payment") return service.initiatePayment(call.provider, call.phoneNumber, call.amount) as Promise<T>;
    if (call.operation === "payout") return service.sendPayout(call.provider, call.phoneNumber, call.amount) as Promise<T>;
    return service.sendBatchPayout(call.provider, call.items) as Promise<T>;
  }

  ensureWorker();
  const job = await queue.add("provider-call", call, {
    removeOnComplete: 1000,
    removeOnFail: 5000,
    attempts: Number(process.env.PROVIDER_THROTTLE_JOB_ATTEMPTS || "3"),
    backoff: { type: "exponential", delay: 1000 },
  });
  return job.waitUntilFinished(queueEvents) as Promise<T>;
}

export async function closeProviderThrottle(): Promise<void> {
  await Promise.all([queue.close(), queueEvents.close(), connection.quit()]);
}
