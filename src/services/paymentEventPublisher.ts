import Redis from 'ioredis';
import { structuredLogger } from '../utils/structuredLogger';
import EventEmitter from 'events';

export interface PaymentStatusEvent {
  transactionId: string;
  status: string;
  userId?: string;
  metadata?: Record<string, any>;
  timestamp: Date;
  source: 'horizon' | 'provider' | 'worker' | 'admin';
}

export interface EventListener {
  (event: PaymentStatusEvent): void | Promise<void>;
}

/**
 * Payment Event Publisher - publishes payment status updates
 */
export class PaymentEventPublisher {
  private redis: Redis;
  private readonly channel = 'payment:status:updates';

  constructor(redis: Redis) {
    this.redis = redis;
  }

  /**
   * Publish a payment status update
   */
  async publishStatusUpdate(event: PaymentStatusEvent): Promise<void> {
    try {
      const message = JSON.stringify(event);
      const subscriberCount = await this.redis.publish(this.channel, message);

      structuredLogger.info(
        {
          transactionId: event.transactionId,
          status: event.status,
          subscriberCount,
        },
        'Payment status update published'
      );
    } catch (error) {
      structuredLogger.error(
        {
          transactionId: event.transactionId,
          error: error instanceof Error ? error.message : String(error),
        },
        'Failed to publish payment status update'
      );
      throw error;
    }
  }

  /**
   * Publish multiple updates in batch
   */
  async publishBatch(events: PaymentStatusEvent[]): Promise<void> {
    try {
      const pipeline = this.redis.pipeline();
      for (const event of events) {
        const message = JSON.stringify(event);
        pipeline.publish(this.channel, message);
      }
      await pipeline.exec();

      structuredLogger.info(
        { eventCount: events.length },
        'Batch payment status updates published'
      );
    } catch (error) {
      structuredLogger.error(
        {
          error: error instanceof Error ? error.message : String(error),
          eventCount: events.length,
        },
        'Failed to publish batch payment status updates'
      );
      throw error;
    }
  }

  /**
   * Get channel name
   */
  getChannel(): string {
    return this.channel;
  }
}

/**
 * Payment Status Update Listener - subscribes to payment updates
 */
export class PaymentStatusUpdateListener extends EventEmitter {
  private redis: Redis;
  private subscriber: Redis;
  private readonly channel = 'payment:status:updates';
  private listeners: Map<string, EventListener[]> = new Map();
  private isConnected = false;

  constructor(redis: Redis) {
    super();
    this.redis = redis;
    this.subscriber = redis.duplicate();
  }

  /**
   * Start listening for updates
   */
  async connect(): Promise<void> {
    if (this.isConnected) {
      return;
    }

    try {
      await this.subscriber.subscribe(this.channel);
      this.isConnected = true;

      this.subscriber.on('message', (channel: string, message: string) => {
        if (channel === this.channel) {
          this.handleMessage(message);
        }
      });

      structuredLogger.info({ channel: this.channel }, 'Payment status listener connected');
    } catch (error) {
      structuredLogger.error(
        {
          error: error instanceof Error ? error.message : String(error),
        },
        'Failed to connect payment status listener'
      );
      throw error;
    }
  }

  /**
   * Stop listening for updates
   */
  async disconnect(): Promise<void> {
    if (!this.isConnected) {
      return;
    }

    try {
      await this.subscriber.unsubscribe(this.channel);
      await this.subscriber.quit();
      this.isConnected = false;

      structuredLogger.info({ channel: this.channel }, 'Payment status listener disconnected');
    } catch (error) {
      structuredLogger.error(
        {
          error: error instanceof Error ? error.message : String(error),
        },
        'Error disconnecting payment status listener'
      );
    }
  }

  /**
   * Subscribe to updates for a transaction
   */
  subscribe(transactionId: string, listener: EventListener): void {
    if (!this.listeners.has(transactionId)) {
      this.listeners.set(transactionId, []);
    }
    this.listeners.get(transactionId)!.push(listener);

    structuredLogger.debug(
      { transactionId, listenerCount: this.listeners.get(transactionId)!.length },
      'Listener subscribed to transaction updates'
    );
  }

  /**
   * Unsubscribe from updates for a transaction
   */
  unsubscribe(transactionId: string, listener?: EventListener): void {
    if (!this.listeners.has(transactionId)) {
      return;
    }

    if (listener) {
      const index = this.listeners.get(transactionId)!.indexOf(listener);
      if (index > -1) {
        this.listeners.get(transactionId)!.splice(index, 1);
      }
    } else {
      this.listeners.delete(transactionId);
    }

    structuredLogger.debug(
      { transactionId },
      'Listener unsubscribed from transaction updates'
    );
  }

  /**
   * Handle incoming message
   */
  private async handleMessage(message: string): Promise<void> {
    try {
      const event = JSON.parse(message) as PaymentStatusEvent;
      event.timestamp = new Date(event.timestamp);

      const listeners = this.listeners.get(event.transactionId) || [];

      for (const listener of listeners) {
        try {
          await listener(event);
        } catch (error) {
          structuredLogger.warn(
            {
              transactionId: event.transactionId,
              error: error instanceof Error ? error.message : String(error),
            },
            'Error in payment status listener'
          );
        }
      }

      this.emit('update', event);
    } catch (error) {
      structuredLogger.warn(
        {
          error: error instanceof Error ? error.message : String(error),
        },
        'Failed to parse payment status update message'
      );
    }
  }

  /**
   * Get subscriber count for a transaction
   */
  getSubscriberCount(transactionId: string): number {
    return this.listeners.get(transactionId)?.length || 0;
  }

  /**
   * Get total subscribers
   */
  getTotalSubscribers(): number {
    let count = 0;
    for (const listeners of this.listeners.values()) {
      count += listeners.length;
    }
    return count;
  }

  /**
   * Check if connected
   */
  isReady(): boolean {
    return this.isConnected;
  }
}
