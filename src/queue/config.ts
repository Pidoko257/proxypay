import { QueueOptions } from "bullmq";
import { bullMQRedisConnection } from "../config/redis";

// BullMQ requires a dedicated Redis connection — it must NOT share the
// connection used by the rest of the application (cache, sessions, etc.).
// We re-export the singleton from config/redis so every queue / worker
// in this directory imports the same client rather than creating new ones.
export const connection = bullMQRedisConnection;

export const queueOptions: QueueOptions = {
  connection: bullMQRedisConnection as any,
};
