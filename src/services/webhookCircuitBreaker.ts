/**
 * Webhook Circuit Breaker (issue #573)
 *
 * Tracks consecutive delivery failures per webhook endpoint and prevents
 * hammering a dead webhook. States:
 *  - closed:  deliveries allowed, failures accumulate
 *  - open:    deliveries blocked until the recovery window elapses
 *  - half_open: a single probe delivery is allowed to test recovery
 *
 * The breaker automatically recovers after `recoveryTimeMs` (default 24h),
 * and can be reset manually via the admin endpoint
 * (POST /api/admin/webhooks/circuit-breakers/reset).
 */
import { WebhookCircuitBreakerTransitionTotal, WebhookCircuitBreakerState } from "../utils/metrics";

export type WebhookCircuitState = "closed" | "open" | "half_open";

export interface WebhookCircuitBreakerOptions {
  /** Consecutive failures before the breaker opens. */
  failureThreshold?: number;
  /** How long the breaker stays open before allowing a probe (default 24h). */
  recoveryTimeMs?: number;
  /** Injection point for the current time. */
  now?: () => number;
  logger?: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
    error?: (msg: string, meta?: Record<string, unknown>) => void;
  };
}

export interface WebhookCircuitBreakerSnapshot {
  state: WebhookCircuitState;
  consecutiveFailures: number;
  openedAt: string | null;
  recoveryAt: string | null;
}

const DEFAULT_FAILURE_THRESHOLD = 5;
const DEFAULT_RECOVERY_TIME_MS = 24 * 60 * 60 * 1000; // 24 hours

function setGauge(state: WebhookCircuitState): void {
  WebhookCircuitBreakerState.set({ state }, state === "closed" ? 1 : state === "open" ? 0 : 0.5);
}

export class WebhookCircuitBreaker {
  private state: WebhookCircuitState = "closed";
  private consecutiveFailures = 0;
  private openedAtMs: number | null = null;
  private readonly failureThreshold: number;
  private readonly recoveryTimeMs: number;
  private readonly now: () => number;
  private readonly logger: NonNullable<WebhookCircuitBreakerOptions["logger"]>;

  constructor(private readonly key: string, options: WebhookCircuitBreakerOptions = {}) {
    this.failureThreshold = Math.max(1, options.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD);
    this.recoveryTimeMs = Math.max(1, options.recoveryTimeMs ?? DEFAULT_RECOVERY_TIME_MS);
    this.now = options.now ?? Date.now;
    this.logger = options.logger ?? console;
    setGauge(this.state);
  }

  getKey(): string {
    return this.key;
  }

  getState(): WebhookCircuitState {
    return this.state;
  }

  getConsecutiveFailures(): number {
    return this.consecutiveFailures;
  }

  /**
   * Returns true when a delivery may be attempted. Transitioning from open
   * to half_open on the first allowed probe is handled here.
   */
  canAttempt(): boolean {
    if (this.state === "closed") {
      return true;
    }
    if (this.state === "open" && this.openedAtMs !== null) {
      if (this.now() - this.openedAtMs >= this.recoveryTimeMs) {
        this.transition("half_open", "recovery_window_elapsed");
      }
    }
    return this.state === "half_open";
  }

  recordSuccess(): void {
    if (this.state === "closed" && this.consecutiveFailures === 0) {
      return;
    }
    const recovered = this.state !== "closed";
    this.consecutiveFailures = 0;
    this.openedAtMs = null;
    if (recovered) {
      this.transition("closed", "delivery_succeeded");
    }
  }

  recordFailure(): void {
    if (this.state === "half_open") {
      // Probe failed: go straight back to open with a fresh recovery window.
      this.consecutiveFailures += 1;
      this.openBreaker();
      return;
    }
    this.consecutiveFailures += 1;
    if (this.state === "closed" && this.consecutiveFailures >= this.failureThreshold) {
      this.openBreaker();
    }
  }

  /** Manual admin reset: clears failures and returns to closed. */
  reset(): void {
    this.consecutiveFailures = 0;
    this.openedAtMs = null;
    if (this.state !== "closed") {
      this.transition("closed", "manual_reset");
    }
  }

  snapshot(): WebhookCircuitBreakerSnapshot {
    return {
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      openedAt: this.openedAtMs === null ? null : new Date(this.openedAtMs).toISOString(),
      recoveryAt:
        this.openedAtMs === null ? null : new Date(this.openedAtMs + this.recoveryTimeMs).toISOString(),
    };
  }

  private openBreaker(): void {
    this.openedAtMs = this.now();
    if (this.state === "half_open") {
      this.transition("open", "probe_failed");
    } else {
      this.transition("open", "failure_threshold_reached");
    }
  }

  private transition(next: WebhookCircuitState, reason: string): void {
    const prev = this.state;
    if (prev === next) return;
    this.state = next;
    setGauge(next);
    WebhookCircuitBreakerTransitionTotal.inc({ webhook: this.key, from: prev, to: next });
    this.logger.info(`Webhook circuit breaker ${prev} -> ${next}`, {
      webhook: this.key,
      reason,
      consecutiveFailures: this.consecutiveFailures,
    });
  }
}

/** Shared registry keyed by webhook URL so admin resets reach the same instance used by WebhookService. */
export class WebhookCircuitBreakerRegistry {
  private static breakers = new Map<string, WebhookCircuitBreaker>();

  static get(key: string, options?: WebhookCircuitBreakerOptions): WebhookCircuitBreaker {
    let breaker = WebhookCircuitBreakerRegistry.breakers.get(key);
    if (!breaker) {
      breaker = new WebhookCircuitBreaker(key, options);
      WebhookCircuitBreakerRegistry.breakers.set(key, breaker);
    }
    return breaker;
  }

  static reset(key: string): WebhookCircuitBreaker | undefined {
    const breaker = WebhookCircuitBreakerRegistry.breakers.get(key);
    if (breaker) {
      breaker.reset();
    }
    return breaker;
  }

  static list(): WebhookCircuitBreaker[] {
    return Array.from(WebhookCircuitBreakerRegistry.breakers.values());
  }
}
