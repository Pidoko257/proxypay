import { structuredLogger } from '../utils/structuredLogger';
import { PaymentStatusEvent, PaymentEventPublisher, PaymentStatusUpdateListener } from './paymentEventPublisher';
import Redis from 'ioredis';

/**
 * Payment Status Update Broadcaster
 * Handles broadcasting payment status updates to WebSocket clients
 */
export class PaymentStatusUpdateBroadcaster {
  private publisher: PaymentEventPublisher;
  private listener: PaymentStatusUpdateListener;
  private websocketManager: any; // WebSocket manager instance
  private retryQueue: PaymentStatusEvent[] = [];
  private maxRetries = 3;

  constructor(redis: Redis, websocketManager?: any) {
    this.publisher = new PaymentEventPublisher(redis);
    this.listener = new PaymentStatusUpdateListener(redis);
    this.websocketManager = websocketManager;
  }

  /**
   * Initialize the broadcaster
   */
  async initialize(): Promise<void> {
    try {
      await this.listener.connect();

      this.listener.on('update', async (event: PaymentStatusEvent) => {
        await this.broadcastToClients(event);
      });

      structuredLogger.info('Payment status update broadcaster initialized');
    } catch (error) {
      structuredLogger.error(
        {
          error: error instanceof Error ? error.message : String(error),
        },
        'Failed to initialize payment status update broadcaster'
      );
      throw error;
    }
  }

  /**
   * Publish a payment status update
   */
  async publishUpdate(event: PaymentStatusEvent): Promise<void> {
    try {
      await this.publisher.publishStatusUpdate(event);
    } catch (error) {
      // Add to retry queue on failure
      this.retryQueue.push(event);
      structuredLogger.warn(
        {
          transactionId: event.transactionId,
          retryQueueSize: this.retryQueue.length,
        },
        'Added payment update to retry queue'
      );
    }
  }

  /**
   * Broadcast to WebSocket clients
   */
  private async broadcastToClients(event: PaymentStatusEvent): Promise<void> {
    if (!this.websocketManager) {
      return;
    }

    try {
      // Broadcast to user's room if userId is available
      if (event.userId) {
        this.websocketManager.broadcastToUser(
          event.userId,
          'payment:status:update',
          event
        );
      }

      // Broadcast to transaction-specific room
      this.websocketManager.broadcast(
        `transaction:${event.transactionId}`,
        'payment:status:update',
        event
      );

      structuredLogger.debug(
        {
          transactionId: event.transactionId,
          status: event.status,
        },
        'Broadcast payment status update to WebSocket clients'
      );
    } catch (error) {
      structuredLogger.warn(
        {
          transactionId: event.transactionId,
          error: error instanceof Error ? error.message : String(error),
        },
        'Failed to broadcast payment status update to clients'
      );
    }
  }

  /**
   * Process retry queue
   */
  async processRetryQueue(): Promise<void> {
    if (this.retryQueue.length === 0) {
      return;
    }

    const events = [...this.retryQueue];
    this.retryQueue = [];

    structuredLogger.info(
      { eventCount: events.length },
      'Processing payment status update retry queue'
    );

    for (const event of events) {
      try {
        await this.publisher.publishStatusUpdate(event);
      } catch (error) {
        this.retryQueue.push(event);
        structuredLogger.warn(
          {
            transactionId: event.transactionId,
            retryQueueSize: this.retryQueue.length,
          },
          'Retry failed, re-queuing payment update'
        );
      }
    }
  }

  /**
   * Get retry queue size
   */
  getRetryQueueSize(): number {
    return this.retryQueue.length;
  }

  /**
   * Get listener
   */
  getListener(): PaymentStatusUpdateListener {
    return this.listener;
  }

  /**
   * Subscribe to transaction updates
   */
  subscribe(transactionId: string, callback: (event: PaymentStatusEvent) => void): void {
    this.listener.subscribe(transactionId, callback);
  }

  /**
   * Unsubscribe from transaction updates
   */
  unsubscribe(transactionId: string, callback?: (event: PaymentStatusEvent) => void): void {
    this.listener.unsubscribe(transactionId, callback);
  }

  /**
   * Get stats
   */
  getStats(): {
    isReady: boolean;
    retryQueueSize: number;
    totalSubscribers: number;
  } {
    return {
      isReady: this.listener.isReady(),
      retryQueueSize: this.retryQueue.length,
      totalSubscribers: this.listener.getTotalSubscribers(),
    };
  }

  /**
   * Shutdown broadcaster
   */
  async shutdown(): Promise<void> {
    try {
      await this.listener.disconnect();
      structuredLogger.info('Payment status update broadcaster shutdown');
    } catch (error) {
      structuredLogger.error(
        {
          error: error instanceof Error ? error.message : String(error),
        },
        'Error shutting down payment status update broadcaster'
      );
    }
  }
}
