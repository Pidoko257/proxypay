/**
 * Timeout Policies — per-operation-type timeout configuration
 *
 * Defines canonical timeout values for every distinct operation class in the
 * ProxyPay system.  Values are intentionally conservative for external calls
 * (mobile-money providers, Stellar Horizon) while remaining tight for
 * read-only / health-check paths.
 *
 * All durations are in **milliseconds** unless the property name says
 * otherwise.
 */

// ---------------------------------------------------------------------------
// Operation-type enum
// ---------------------------------------------------------------------------

/**
 * Broad categories of operations that need different SLA budgets.
 */
export enum OperationType {
  /** Simple REST read (DB or cache-backed) */
  READ = "READ",

  /** Authentication / authorisation checks */
  AUTH = "AUTH",

  /** Write operations that touch only the local database */
  WRITE = "WRITE",

  /** Outbound calls to MTN MoMo, Airtel Money, Orange Money, etc. */
  PROVIDER_PAYMENT = "PROVIDER_PAYMENT",

  /** Status-poll / callback queries to a mobile-money provider */
  PROVIDER_STATUS = "PROVIDER_STATUS",

  /** Stellar Horizon transaction submission */
  BLOCKCHAIN_SUBMIT = "BLOCKCHAIN_SUBMIT",

  /** Stellar Horizon read queries (balance, history, status) */
  BLOCKCHAIN_READ = "BLOCKCHAIN_READ",

  /** SEP-10 / SEP-24 challenge / interactive-flow endpoints */
  STELLAR_SEP = "STELLAR_SEP",

  /** WebSocket long-poll (lower priority; held connections should be short) */
  WEBSOCKET = "WEBSOCKET",

  /** Webhook delivery to merchant endpoints */
  WEBHOOK_DELIVERY = "WEBHOOK_DELIVERY",

  /** Report / statement generation (PDF, CSV) */
  REPORT_GENERATION = "REPORT_GENERATION",

  /** Batch payout / bulk operations */
  BATCH_OPERATION = "BATCH_OPERATION",

  /** Provider health-check ping */
  HEALTH_CHECK = "HEALTH_CHECK",

  /** KYC document upload + third-party verification */
  KYC = "KYC",

  /** General fallback when no specific type matches */
  DEFAULT = "DEFAULT",
}

// ---------------------------------------------------------------------------
// Policy shape
// ---------------------------------------------------------------------------

/**
 * Full set of timeout parameters for a single operation type.
 */
export interface TimeoutPolicy {
  /** Hard timeout: request will be aborted after this many milliseconds */
  timeoutMs: number;

  /**
   * Warning threshold: log a slow-request warning when the operation exceeds
   * this many milliseconds (but has not yet timed out).
   */
  warningThresholdMs: number;

  /**
   * How many times the caller should attempt the operation before giving up.
   * The timeout applies independently to each attempt.
   */
  maxRetries: number;

  /**
   * Base delay between retry attempts (exponential-backoff seed).
   * Actual delay = baseRetryDelayMs * 2^(attempt-1).
   */
  baseRetryDelayMs: number;

  /**
   * Whether a timeout on this operation should trigger the recovery workflow
   * in `transactionRecovery.ts`.
   */
  enablePartialRecovery: boolean;

  /**
   * Whether a timeout on this operation should fire an alert via
   * `timeoutService.ts`.
   */
  alertOnTimeout: boolean;

  /**
   * Descriptive name surfaced in logs and metrics.
   */
  label: string;
}

// ---------------------------------------------------------------------------
// Policy registry
// ---------------------------------------------------------------------------

/**
 * Canonical timeout policies indexed by OperationType.
 *
 * These defaults are intentionally conservative.  Operators may override
 * individual values through environment variables (see `resolvePolicy`).
 */
export const TIMEOUT_POLICIES: Readonly<
  Record<OperationType, TimeoutPolicy>
> = {
  [OperationType.READ]: {
    label: "Read Operation",
    timeoutMs: 10_000, // 10 s
    warningThresholdMs: 5_000, // warn at 5 s
    maxRetries: 2,
    baseRetryDelayMs: 200,
    enablePartialRecovery: false,
    alertOnTimeout: false,
  },

  [OperationType.AUTH]: {
    label: "Authentication",
    timeoutMs: 10_000,
    warningThresholdMs: 3_000,
    maxRetries: 1,
    baseRetryDelayMs: 100,
    enablePartialRecovery: false,
    alertOnTimeout: false,
  },

  [OperationType.WRITE]: {
    label: "Write Operation",
    timeoutMs: 15_000,
    warningThresholdMs: 8_000,
    maxRetries: 2,
    baseRetryDelayMs: 300,
    enablePartialRecovery: false,
    alertOnTimeout: false,
  },

  [OperationType.PROVIDER_PAYMENT]: {
    label: "Provider Payment",
    timeoutMs: 60_000, // providers can be slow
    warningThresholdMs: 30_000,
    maxRetries: 3,
    baseRetryDelayMs: 2_000,
    enablePartialRecovery: true, // may have been accepted before timeout
    alertOnTimeout: true,
  },

  [OperationType.PROVIDER_STATUS]: {
    label: "Provider Status Check",
    timeoutMs: 15_000,
    warningThresholdMs: 8_000,
    maxRetries: 3,
    baseRetryDelayMs: 1_000,
    enablePartialRecovery: false,
    alertOnTimeout: false,
  },

  [OperationType.BLOCKCHAIN_SUBMIT]: {
    label: "Blockchain Submission",
    timeoutMs: 90_000, // Stellar can be slow during congestion
    warningThresholdMs: 45_000,
    maxRetries: 2,
    baseRetryDelayMs: 5_000,
    enablePartialRecovery: true, // tx may have landed before timeout
    alertOnTimeout: true,
  },

  [OperationType.BLOCKCHAIN_READ]: {
    label: "Blockchain Read",
    timeoutMs: 20_000,
    warningThresholdMs: 10_000,
    maxRetries: 3,
    baseRetryDelayMs: 1_000,
    enablePartialRecovery: false,
    alertOnTimeout: false,
  },

  [OperationType.STELLAR_SEP]: {
    label: "Stellar SEP",
    timeoutMs: 30_000,
    warningThresholdMs: 15_000,
    maxRetries: 2,
    baseRetryDelayMs: 1_500,
    enablePartialRecovery: false,
    alertOnTimeout: false,
  },

  [OperationType.WEBSOCKET]: {
    label: "WebSocket",
    timeoutMs: 45_000,
    warningThresholdMs: 30_000,
    maxRetries: 1,
    baseRetryDelayMs: 0,
    enablePartialRecovery: false,
    alertOnTimeout: false,
  },

  [OperationType.WEBHOOK_DELIVERY]: {
    label: "Webhook Delivery",
    timeoutMs: 30_000,
    warningThresholdMs: 15_000,
    maxRetries: 3,
    baseRetryDelayMs: 2_000,
    enablePartialRecovery: false,
    alertOnTimeout: false,
  },

  [OperationType.REPORT_GENERATION]: {
    label: "Report Generation",
    timeoutMs: 120_000, // 2 min
    warningThresholdMs: 60_000,
    maxRetries: 1,
    baseRetryDelayMs: 0,
    enablePartialRecovery: false,
    alertOnTimeout: false,
  },

  [OperationType.BATCH_OPERATION]: {
    label: "Batch Operation",
    timeoutMs: 180_000, // 3 min
    warningThresholdMs: 120_000,
    maxRetries: 1,
    baseRetryDelayMs: 0,
    enablePartialRecovery: true,
    alertOnTimeout: true,
  },

  [OperationType.HEALTH_CHECK]: {
    label: "Health Check",
    timeoutMs: 5_000,
    warningThresholdMs: 2_000,
    maxRetries: 1,
    baseRetryDelayMs: 0,
    enablePartialRecovery: false,
    alertOnTimeout: false,
  },

  [OperationType.KYC]: {
    label: "KYC Verification",
    timeoutMs: 60_000,
    warningThresholdMs: 30_000,
    maxRetries: 2,
    baseRetryDelayMs: 3_000,
    enablePartialRecovery: false,
    alertOnTimeout: true,
  },

  [OperationType.DEFAULT]: {
    label: "Default",
    timeoutMs: 30_000,
    warningThresholdMs: 15_000,
    maxRetries: 2,
    baseRetryDelayMs: 1_000,
    enablePartialRecovery: false,
    alertOnTimeout: false,
  },
} as const;

// ---------------------------------------------------------------------------
// Env-variable overrides
// ---------------------------------------------------------------------------

/**
 * Maps an OperationType to its environment-variable prefix.
 * e.g. OperationType.PROVIDER_PAYMENT → "TIMEOUT_PROVIDER_PAYMENT"
 */
function envPrefix(op: OperationType): string {
  return `TIMEOUT_${op}`;
}

/**
 * Returns a policy for the given OperationType, applying any environment-
 * variable overrides (e.g. `TIMEOUT_PROVIDER_PAYMENT_MS=45000`).
 */
export function resolvePolicy(op: OperationType): TimeoutPolicy {
  const base = TIMEOUT_POLICIES[op];
  const prefix = envPrefix(op);

  const overrideMs = process.env[`${prefix}_MS`];
  const overrideWarning = process.env[`${prefix}_WARNING_MS`];
  const overrideRetries = process.env[`${prefix}_MAX_RETRIES`];
  const overrideBaseDelay = process.env[`${prefix}_BASE_DELAY_MS`];

  return {
    ...base,
    ...(overrideMs !== undefined && { timeoutMs: parseInt(overrideMs, 10) }),
    ...(overrideWarning !== undefined && {
      warningThresholdMs: parseInt(overrideWarning, 10),
    }),
    ...(overrideRetries !== undefined && {
      maxRetries: parseInt(overrideRetries, 10),
    }),
    ...(overrideBaseDelay !== undefined && {
      baseRetryDelayMs: parseInt(overrideBaseDelay, 10),
    }),
  };
}

// ---------------------------------------------------------------------------
// Route → operation-type mapping helpers
// ---------------------------------------------------------------------------

/**
 * Infers an OperationType from an Express request path.
 * Returns OperationType.DEFAULT when no specific rule matches.
 */
export function inferOperationType(path: string, method: string): OperationType {
  const p = path.toLowerCase();
  const m = method.toUpperCase();

  if (p.includes("/health") || p.includes("/ready") || p.includes("/ping")) {
    return OperationType.HEALTH_CHECK;
  }

  // SEP routes must be checked before generic /auth or /deposit patterns
  if (
    p.startsWith("/sep10") ||
    p.startsWith("/sep24") ||
    p.startsWith("/sep31") ||
    p.startsWith("/sep12") ||
    p.startsWith("/sep6") ||
    p.startsWith("/sep30") ||
    p.startsWith("/sep38")
  ) {
    return OperationType.STELLAR_SEP;
  }

  if (p.includes("/auth") || p.includes("/login") || p.includes("/token")) {
    return OperationType.AUTH;
  }

  if (p.includes("/transactions/deposit") || p.includes("/transactions/withdraw")) {
    return m === "POST" ? OperationType.PROVIDER_PAYMENT : OperationType.READ;
  }

  if (p.includes("/transactions/bulk") || p.includes("/batch")) {
    return OperationType.BATCH_OPERATION;
  }

  if (p.includes("/stellar") || p.includes("/blockchain")) {
    return m === "POST" || m === "PUT"
      ? OperationType.BLOCKCHAIN_SUBMIT
      : OperationType.BLOCKCHAIN_READ;
  }

  if (p.includes("/kyc")) {
    return OperationType.KYC;
  }

  if (p.includes("/reports") || p.includes("/statements") || p.includes("/export")) {
    return OperationType.REPORT_GENERATION;
  }

  if (p.includes("/webhooks")) {
    return OperationType.WEBHOOK_DELIVERY;
  }

  if (p.includes("/ws") || p.includes("/socket")) {
    return OperationType.WEBSOCKET;
  }

  if (m === "GET" || m === "HEAD" || m === "OPTIONS") {
    return OperationType.READ;
  }

  if (m === "POST" || m === "PUT" || m === "PATCH" || m === "DELETE") {
    return OperationType.WRITE;
  }

  return OperationType.DEFAULT;
}

// ---------------------------------------------------------------------------
// Convenience helpers
// ---------------------------------------------------------------------------

/**
 * Returns a human-readable summary of all policies, useful for debugging and
 * the `/api/timeouts/policies` endpoint.
 */
export function getAllPolicySummaries(): Array<{
  operationType: OperationType;
  policy: TimeoutPolicy;
}> {
  return Object.values(OperationType).map((op) => ({
    operationType: op,
    policy: resolvePolicy(op),
  }));
}
