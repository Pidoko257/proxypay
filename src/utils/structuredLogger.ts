import pino, { Logger as PinoLogger, ChildLoggerOptions } from 'pino';
import { baseLogger } from './logger';

export interface LogContext {
  requestId?: string;
  userId?: string;
  correlationId?: string;
  traceId?: string;
  [key: string]: any;
}

export interface TimerHandle {
  end(data?: Record<string, any>): void;
}

/**
 * StructuredLogger: High-level structured logging API
 * Wraps Pino logger with context binding and helper methods
 */
export class StructuredLogger {
  private logger: PinoLogger;
  private context: LogContext = {};

  constructor(logger: PinoLogger = baseLogger) {
    this.logger = logger;
  }

  /**
   * Create a child logger with bound context
   */
  createChild(context: LogContext): StructuredLogger {
    const childLogger = this.logger.child(context as any);
    const child = new StructuredLogger(childLogger);
    child.context = { ...this.context, ...context };
    return child;
  }

  /**
   * Bind context to current logger
   */
  bindContext(context: LogContext): this {
    this.context = { ...this.context, ...context };
    this.logger = this.logger.child(context as any);
    return this;
  }

  /**
   * Get current context
   */
  getContext(): LogContext {
    return { ...this.context };
  }

  /**
   * Clear bound context
   */
  clearContext(): this {
    this.context = {};
    return this;
  }

  /**
   * Log at INFO level
   */
  info(data: Record<string, any> | string, message?: string): void {
    if (typeof data === 'string') {
      this.logger.info(data);
    } else {
      this.logger.info(data, message || '');
    }
  }

  /**
   * Log at DEBUG level
   */
  debug(data: Record<string, any> | string, message?: string): void {
    if (typeof data === 'string') {
      this.logger.debug(data);
    } else {
      this.logger.debug(data, message || '');
    }
  }

  /**
   * Log at WARN level
   */
  warn(data: Record<string, any> | string, message?: string): void {
    if (typeof data === 'string') {
      this.logger.warn(data);
    } else {
      this.logger.warn(data, message || '');
    }
  }

  /**
   * Log at ERROR level
   */
  error(data: Record<string, any> | Error | string, message?: string): void {
    if (data instanceof Error) {
      this.logger.error(
        {
          error: data.message,
          stack: data.stack,
        },
        message || data.message
      );
    } else if (typeof data === 'string') {
      this.logger.error(data);
    } else {
      this.logger.error(data, message || '');
    }
  }

  /**
   * Log security event
   */
  security(data: Record<string, any>, message: string): void {
    this.logger.info(
      {
        ...data,
        security_event: true,
      },
      message
    );
  }

  /**
   * Log audit event (compliance)
   */
  audit(data: Record<string, any>, message: string): void {
    this.logger.info(
      {
        ...data,
        audit_event: true,
      },
      message
    );
  }

  /**
   * Time an async operation
   */
  async timeAsync<T>(
    operation: () => Promise<T>,
    operationName: string,
    data?: Record<string, any>
  ): Promise<T> {
    const startTime = performance.now();
    try {
      const result = await operation();
      const duration = Math.round(performance.now() - startTime);
      this.info(
        { duration_ms: duration, ...data },
        `${operationName} completed`
      );
      return result;
    } catch (error) {
      const duration = Math.round(performance.now() - startTime);
      this.error(
        {
          duration_ms: duration,
          error: error instanceof Error ? error.message : String(error),
          ...data,
        },
        `${operationName} failed`
      );
      throw error;
    }
  }

  /**
   * Time a sync operation
   */
  timeSync<T>(
    operation: () => T,
    operationName: string,
    data?: Record<string, any>
  ): T {
    const startTime = performance.now();
    try {
      const result = operation();
      const duration = Math.round(performance.now() - startTime);
      this.info(
        { duration_ms: duration, ...data },
        `${operationName} completed`
      );
      return result;
    } catch (error) {
      const duration = Math.round(performance.now() - startTime);
      this.error(
        {
          duration_ms: duration,
          error: error instanceof Error ? error.message : String(error),
          ...data,
        },
        `${operationName} failed`
      );
      throw error;
    }
  }

  /**
   * Create a timer that can be ended later
   */
  createTimer(timerName: string): TimerHandle {
    const startTime = performance.now();
    return {
      end: (data?: Record<string, any>) => {
        const duration = Math.round(performance.now() - startTime);
        this.info(
          { duration_ms: duration, timer: timerName, ...data },
          `Timer ${timerName} completed`
        );
      },
    };
  }

  /**
   * Get underlying Pino logger
   */
  getPinoLogger(): PinoLogger {
    return this.logger;
  }
}

// Singleton instance
export const structuredLogger = new StructuredLogger(baseLogger);
