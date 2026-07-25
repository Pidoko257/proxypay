import { redisClient } from "../config/redis";
import { BulkJob } from "../routes/bulk";

// TTL for batch jobs in Redis: 24 hours
const BATCH_JOB_TTL_SECONDS = 86400;

// Key patterns
const jobKey = (jobId: string) => `batch:job:${jobId}`;
const userJobsKey = (userId: string) => `batch:user:${userId}:jobs`;

/**
 * BatchJob extends BulkJob with additional tracking fields for the
 * Redis-backed store.
 */
export interface BatchJob extends BulkJob {
  userId: string;
  batchSize: number;
  exportUrl?: string;
}

/**
 * Serialise a BatchJob for Redis storage. Dates are stored as ISO strings.
 */
function serialise(job: BatchJob): string {
  return JSON.stringify({
    ...job,
    createdAt: job.createdAt instanceof Date ? job.createdAt.toISOString() : job.createdAt,
    completedAt:
      job.completedAt instanceof Date
        ? job.completedAt.toISOString()
        : job.completedAt ?? null,
  });
}

/**
 * Deserialise a BatchJob from Redis storage.
 */
function deserialise(raw: string): BatchJob {
  const obj = JSON.parse(raw) as Record<string, unknown>;
  return {
    ...(obj as unknown as BatchJob),
    createdAt: new Date(obj.createdAt as string),
    completedAt: obj.completedAt ? new Date(obj.completedAt as string) : undefined,
    errors: (obj.errors as Array<{ row: number; error: string }>) ?? [],
  };
}

/**
 * Redis-backed batch job store.
 *
 * All data is stored with a 24-hour TTL so that orphaned jobs are automatically
 * garbage-collected without requiring manual cleanup.
 *
 * Key layout
 * ----------
 * batch:job:{jobId}          → serialised BatchJob (string)
 * batch:user:{userId}:jobs   → sorted set: member=jobId, score=createdAt epoch ms
 */
export class BatchJobStore {
  /**
   * Persist a new batch job.
   */
  async create(job: BatchJob): Promise<void> {
    if (!redisClient.isOpen) return;

    const multi = redisClient.multi();

    // Store the job data
    multi.set(jobKey(job.id), serialise(job), { EX: BATCH_JOB_TTL_SECONDS });

    // Track the job under the user's sorted set (score = epoch ms for ordering)
    multi.zAdd(userJobsKey(job.userId), {
      score: job.createdAt.getTime(),
      value: job.id,
    });
    // Refresh the user index TTL alongside the job
    multi.expire(userJobsKey(job.userId), BATCH_JOB_TTL_SECONDS);

    await multi.exec();
  }

  /**
   * Retrieve a batch job by ID. Returns null when not found.
   */
  async get(jobId: string): Promise<BatchJob | null> {
    if (!redisClient.isOpen) return null;

    const raw = await redisClient.get(jobKey(jobId));
    if (!raw) return null;

    try {
      return deserialise(raw);
    } catch {
      console.error(`[BatchJobStore] Failed to deserialise job ${jobId}`);
      return null;
    }
  }

  /**
   * Atomically increment job progress counters.
   *
   * Uses a Lua script so that the read-modify-write is atomic even under
   * concurrent workers updating the same job.
   */
  async incrementProgress(
    jobId: string,
    succeeded: boolean,
    error?: { row: number; error: string },
  ): Promise<void> {
    if (!redisClient.isOpen) return;

    const key = jobKey(jobId);

    // Lua script: atomically update processed / succeeded / failed / errors
    const script = `
      local raw = redis.call('GET', KEYS[1])
      if not raw then return nil end
      local job = cjson.decode(raw)
      job.processed = (job.processed or 0) + 1
      if ARGV[1] == '1' then
        job.succeeded = (job.succeeded or 0) + 1
      else
        job.failed = (job.failed or 0) + 1
        if ARGV[2] ~= '' then
          if not job.errors then job.errors = {} end
          table.insert(job.errors, cjson.decode(ARGV[2]))
        end
      end
      local ttl = redis.call('TTL', KEYS[1])
      redis.call('SET', KEYS[1], cjson.encode(job), 'EX', ttl > 0 and ttl or ${BATCH_JOB_TTL_SECONDS})
      return 1
    `;

    try {
      await redisClient.eval(script, {
        keys: [key],
        arguments: [
          succeeded ? "1" : "0",
          error ? JSON.stringify(error) : "",
        ],
      });
    } catch (err) {
      console.error(`[BatchJobStore] incrementProgress failed for job ${jobId}:`, err);
    }
  }

  /**
   * Mark a batch job as completed.
   */
  async complete(jobId: string): Promise<void> {
    if (!redisClient.isOpen) return;

    const key = jobKey(jobId);

    const script = `
      local raw = redis.call('GET', KEYS[1])
      if not raw then return nil end
      local job = cjson.decode(raw)
      job.status = 'completed'
      job.completedAt = ARGV[1]
      local ttl = redis.call('TTL', KEYS[1])
      redis.call('SET', KEYS[1], cjson.encode(job), 'EX', ttl > 0 and ttl or ${BATCH_JOB_TTL_SECONDS})
      return 1
    `;

    try {
      await redisClient.eval(script, {
        keys: [key],
        arguments: [new Date().toISOString()],
      });
    } catch (err) {
      console.error(`[BatchJobStore] complete failed for job ${jobId}:`, err);
    }
  }

  /**
   * List batch jobs for a user, newest first.
   */
  async listByUser(userId: string, limit = 20): Promise<BatchJob[]> {
    if (!redisClient.isOpen) return [];

    // ZREVRANGE gives us job IDs sorted newest-first
    const jobIds = await redisClient.zRange(
      userJobsKey(userId),
      "+inf",
      "-inf",
      { BY: "SCORE", REV: true, LIMIT: { offset: 0, count: limit } },
    );

    if (jobIds.length === 0) return [];

    const pipeline = redisClient.multi();
    for (const id of jobIds) {
      pipeline.get(jobKey(id));
    }

    const results = await pipeline.exec();
    const jobs: BatchJob[] = [];

    for (const raw of results) {
      if (typeof raw === "string") {
        try {
          jobs.push(deserialise(raw));
        } catch {
          // Skip corrupted entries
        }
      }
    }

    return jobs;
  }

  /**
   * Delete a batch job and remove it from the user index.
   */
  async delete(jobId: string): Promise<void> {
    if (!redisClient.isOpen) return;

    // We need the job first to get the userId for the index cleanup
    const job = await this.get(jobId);

    const multi = redisClient.multi();
    multi.del(jobKey(jobId));
    if (job) {
      multi.zRem(userJobsKey(job.userId), jobId);
    }
    await multi.exec();
  }

  /**
   * Update the exportUrl on a completed job.
   */
  async setExportUrl(jobId: string, exportUrl: string): Promise<void> {
    if (!redisClient.isOpen) return;

    const key = jobKey(jobId);
    const script = `
      local raw = redis.call('GET', KEYS[1])
      if not raw then return nil end
      local job = cjson.decode(raw)
      job.exportUrl = ARGV[1]
      local ttl = redis.call('TTL', KEYS[1])
      redis.call('SET', KEYS[1], cjson.encode(job), 'EX', ttl > 0 and ttl or ${BATCH_JOB_TTL_SECONDS})
      return 1
    `;

    try {
      await redisClient.eval(script, {
        keys: [key],
        arguments: [exportUrl],
      });
    } catch (err) {
      console.error(`[BatchJobStore] setExportUrl failed for job ${jobId}:`, err);
    }
  }
}

export const batchJobStore = new BatchJobStore();
