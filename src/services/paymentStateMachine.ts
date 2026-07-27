import { structuredLogger } from '../utils/structuredLogger';

export enum PaymentState {
  PENDING = 'PENDING',
  PROCESSING = 'PROCESSING',
  SUCCESS = 'SUCCESS',
  FAILED = 'FAILED',
  CANCELLED = 'CANCELLED',
  REVERSED = 'REVERSED',
}

export enum PaymentEvent {
  SUBMIT = 'SUBMIT',
  PROCESS = 'PROCESS',
  SUCCESS = 'SUCCESS',
  FAIL = 'FAIL',
  CANCEL = 'CANCEL',
  RETRY = 'RETRY',
  REVERSE = 'REVERSE',
}

export interface StateTransition {
  from: PaymentState;
  to: PaymentState;
  event: PaymentEvent;
}

export interface TransitionContext {
  transactionId: string;
  userId?: string;
  metadata?: Record<string, any>;
}

/**
 * Payment State Machine
 * Manages payment lifecycle transitions with atomic logging
 */
export class PaymentStateMachine {
  private currentState: PaymentState;
  private readonly transactionId: string;
  private readonly validTransitions: Map<string, PaymentState[]>;
  private stateHistory: Array<{ state: PaymentState; timestamp: Date }> = [];

  constructor(transactionId: string, initialState: PaymentState = PaymentState.PENDING) {
    this.transactionId = transactionId;
    this.currentState = initialState;
    this.stateHistory.push({ state: initialState, timestamp: new Date() });

    // Define valid state transitions
    this.validTransitions = new Map([
      [PaymentState.PENDING, [PaymentState.PROCESSING, PaymentState.CANCELLED]],
      [PaymentState.PROCESSING, [PaymentState.SUCCESS, PaymentState.FAILED, PaymentState.CANCELLED]],
      [PaymentState.SUCCESS, [PaymentState.REVERSED]],
      [PaymentState.FAILED, [PaymentState.PROCESSING, PaymentState.CANCELLED]],
      [PaymentState.CANCELLED, []],
      [PaymentState.REVERSED, []],
    ]);
  }

  /**
   * Get current state
   */
  getState(): PaymentState {
    return this.currentState;
  }

  /**
   * Check if transition is valid
   */
  canTransitionTo(targetState: PaymentState): boolean {
    const validTargets = this.validTransitions.get(this.currentState) || [];
    return validTargets.includes(targetState);
  }

  /**
   * Perform state transition
   */
  async transitionTo(
    targetState: PaymentState,
    context?: TransitionContext
  ): Promise<boolean> {
    if (!this.canTransitionTo(targetState)) {
      structuredLogger.warn(
        {
          transactionId: this.transactionId,
          fromState: this.currentState,
          toState: targetState,
        },
        'Invalid state transition attempted'
      );
      return false;
    }

    const previousState = this.currentState;
    this.currentState = targetState;
    this.stateHistory.push({ state: targetState, timestamp: new Date() });

    structuredLogger.info(
      {
        transactionId: this.transactionId,
        fromState: previousState,
        toState: targetState,
        userId: context?.userId,
        metadata: context?.metadata,
      },
      'Payment state transition'
    );

    return true;
  }

  /**
   * Get state history
   */
  getHistory(): Array<{ state: PaymentState; timestamp: Date }> {
    return [...this.stateHistory];
  }

  /**
   * Get time in current state (in milliseconds)
   */
  getTimeInCurrentState(): number {
    if (this.stateHistory.length === 0) {
      return 0;
    }

    const currentEntry = this.stateHistory[this.stateHistory.length - 1];
    return Date.now() - currentEntry.timestamp.getTime();
  }

  /**
   * Check if in terminal state
   */
  isTerminal(): boolean {
    return [
      PaymentState.SUCCESS,
      PaymentState.FAILED,
      PaymentState.CANCELLED,
      PaymentState.REVERSED,
    ].includes(this.currentState);
  }

  /**
   * Get possible next states
   */
  getPossibleNextStates(): PaymentState[] {
    return this.validTransitions.get(this.currentState) || [];
  }

  /**
   * Reset to initial state (use with caution)
   */
  async resetToState(state: PaymentState, context?: TransitionContext): Promise<boolean> {
    this.currentState = state;
    this.stateHistory = [{ state, timestamp: new Date() }];

    structuredLogger.warn(
      {
        transactionId: this.transactionId,
        resetTo: state,
        userId: context?.userId,
      },
      'Payment state machine reset'
    );

    return true;
  }

  /**
   * Get complete state info
   */
  getStateInfo(): {
    currentState: PaymentState;
    isTerminal: boolean;
    possibleNextStates: PaymentState[];
    history: Array<{ state: PaymentState; timestamp: Date }>;
    timeInCurrentState: number;
  } {
    return {
      currentState: this.currentState,
      isTerminal: this.isTerminal(),
      possibleNextStates: this.getPossibleNextStates(),
      history: this.getHistory(),
      timeInCurrentState: this.getTimeInCurrentState(),
    };
  }
}
