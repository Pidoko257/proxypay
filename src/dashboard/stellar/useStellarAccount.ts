import { useState, useEffect, useCallback, useRef } from 'react';
import * as StellarSdk from 'stellar-sdk';
import {
  StellarAccount,
  Operation,
  StellarAccountState,
  UseStellarAccountOptions,
  UseStellarAccountReturn,
  StellarAccountError,
  StellarAccountViewerError,
} from './types';

const DEFAULT_OPERATION_LIMIT = 10;
const DEFAULT_REFRESH_INTERVAL = 30000; // 30 seconds

/**
 * Hook for fetching and monitoring Stellar account data
 * Handles account balances, operations, and account flags with auto-refresh
 * 
 * @example
 * const { account, xlmBalance, operations, isLoading, refetch } = useStellarAccount({
 *   accountId: 'GBRPYHIL2CI3...',
 *   autoRefreshInterval: 30000,
 *   operationLimit: 10,
 * });
 */
export function useStellarAccount(
  options: UseStellarAccountOptions,
): UseStellarAccountReturn {
  const {
    accountId,
    autoRefreshInterval = DEFAULT_REFRESH_INTERVAL,
    operationLimit = DEFAULT_OPERATION_LIMIT,
    network = 'testnet',
    horizonUrl: customHorizonUrl,
    debug = false,
  } = options;

  const [state, setState] = useState<StellarAccountState>({
    account: null,
    xlmBalance: null,
    operations: [],
    isLoading: true,
    isFetching: false,
    error: null,
    lastUpdated: null,
    isUnfunded: false,
    isFundable: true,
  });

  const intervalRef = useRef<NodeJS.Timeout>();
  const abortControllerRef = useRef<AbortController>();

  /**
   * Get Horizon server instance
   */
  const getHorizonServer = useCallback((): StellarSdk.Horizon.Server => {
    const horizonUrl =
      customHorizonUrl ||
      (network === 'testnet'
        ? 'https://horizon-testnet.stellar.org'
        : 'https://horizon.stellar.org');

    return new StellarSdk.Horizon.Server(horizonUrl, { allowHttp: false });
  }, [network, customHorizonUrl]);

  /**
   * Validate Stellar account ID
   */
  const validateAccountId = useCallback((id: string): boolean => {
    try {
      const keypair = StellarSdk.Keypair.fromPublicKey(id);
      return keypair.publicKey() === id;
    } catch {
      return false;
    }
  }, []);

  /**
   * Extract XLM balance from account
   */
  const extractXlmBalance = useCallback((account: StellarAccount): string => {
    const nativeBalance = account.balances.find(
      (b) => b.asset_type === 'native',
    );
    return nativeBalance?.balance || '0';
  }, []);

  /**
   * Fetch account data from Horizon
   */
  const fetchAccountData = useCallback(
    async (signal?: AbortSignal): Promise<StellarAccount | null> => {
      try {
        if (!validateAccountId(accountId)) {
          throw new StellarAccountViewerError(
            StellarAccountError.INVALID_ACCOUNT_ID,
            `Invalid Stellar account ID: ${accountId}`,
          );
        }

        const server = getHorizonServer();
        
        if (debug) {
          console.debug('[useStellarAccount] Fetching account:', accountId);
        }

        // Check if request is aborted
        if (signal?.aborted) return null;

        const account = await server.accounts().accountId(accountId).call();

        if (debug) {
          console.debug('[useStellarAccount] Account fetched:', account);
        }

        return account as StellarAccount;
      } catch (error) {
        if (error instanceof StellarAccountViewerError) {
          throw error;
        }

        const message = error instanceof Error ? error.message : String(error);

        if (message.includes('404') || message.includes('not found')) {
          throw new StellarAccountViewerError(
            StellarAccountError.ACCOUNT_NOT_FOUND,
            `Account ${accountId} not found on Stellar ${network}`,
            { accountId, network },
          );
        }

        if (message.includes('timeout')) {
          throw new StellarAccountViewerError(
            StellarAccountError.TIMEOUT,
            'Request timeout while fetching account data',
          );
        }

        if (message.includes('429') || message.includes('rate limit')) {
          throw new StellarAccountViewerError(
            StellarAccountError.RATE_LIMITED,
            'Horizon API rate limit exceeded',
          );
        }

        throw new StellarAccountViewerError(
          StellarAccountError.NETWORK_ERROR,
          `Failed to fetch account: ${message}`,
          { originalError: error },
        );
      }
    },
    [accountId, getHorizonServer, validateAccountId, debug, network],
  );

  /**
   * Fetch recent operations for account
   */
  const fetchOperations = useCallback(
    async (signal?: AbortSignal): Promise<Operation[]> => {
      try {
        if (!validateAccountId(accountId)) {
          return [];
        }

        const server = getHorizonServer();

        if (debug) {
          console.debug('[useStellarAccount] Fetching operations:', accountId);
        }

        // Check if request is aborted
        if (signal?.aborted) return [];

        const operationsResponse = await server
          .operations()
          .forAccount(accountId)
          .order('desc')
          .limit(operationLimit)
          .call();

        const operations = operationsResponse._embedded.records as Operation[];

        if (debug) {
          console.debug(
            '[useStellarAccount] Fetched',
            operations.length,
            'operations',
          );
        }

        return operations;
      } catch (error) {
        if (debug) {
          console.warn('[useStellarAccount] Failed to fetch operations:', error);
        }

        // Don't throw for operations fetch - it's not critical
        return [];
      }
    },
    [accountId, getHorizonServer, validateAccountId, operationLimit, debug],
  );

  /**
   * Refresh both account and operations data
   */
  const refetch = useCallback(async (): Promise<void> => {
    try {
      setState((prev) => ({ ...prev, isFetching: true, error: null }));

      // Abort previous requests
      abortControllerRef.current?.abort();
      const controller = new AbortController();
      abortControllerRef.current = controller;

      const [account, operations] = await Promise.all([
        fetchAccountData(controller.signal),
        fetchOperations(controller.signal),
      ]);

      if (controller.signal.aborted) return;

      if (account) {
        const xlmBalance = extractXlmBalance(account);
        setState({
          account,
          xlmBalance,
          operations,
          isLoading: false,
          isFetching: false,
          error: null,
          lastUpdated: new Date(),
          isUnfunded: false,
          isFundable: true,
        });
      }
    } catch (error) {
      if (abortControllerRef.current?.signal.aborted) return;

      const err = error instanceof Error ? error : new Error(String(error));

      if (
        error instanceof StellarAccountViewerError &&
        error.code === StellarAccountError.ACCOUNT_NOT_FOUND
      ) {
        setState({
          account: null,
          xlmBalance: null,
          operations: [],
          isLoading: false,
          isFetching: false,
          error: err,
          lastUpdated: new Date(),
          isUnfunded: true,
          isFundable: true,
        });
      } else {
        setState((prev) => ({
          ...prev,
          isLoading: false,
          isFetching: false,
          error: err,
        }));
      }

      if (debug) {
        console.error('[useStellarAccount] Error:', err);
      }
    }
  }, [fetchAccountData, fetchOperations, extractXlmBalance, debug]);

  /**
   * Refresh only account data
   */
  const refreshAccount = useCallback(async (): Promise<void> => {
    try {
      setState((prev) => ({ ...prev, isFetching: true }));

      abortControllerRef.current?.abort();
      const controller = new AbortController();
      abortControllerRef.current = controller;

      const account = await fetchAccountData(controller.signal);

      if (controller.signal.aborted || !account) return;

      const xlmBalance = extractXlmBalance(account);
      setState((prev) => ({
        ...prev,
        account,
        xlmBalance,
        isFetching: false,
        error: null,
        lastUpdated: new Date(),
        isUnfunded: false,
      }));
    } catch (error) {
      if (abortControllerRef.current?.signal.aborted) return;

      const err = error instanceof Error ? error : new Error(String(error));
      setState((prev) => ({
        ...prev,
        isFetching: false,
        error: err,
      }));
    }
  }, [fetchAccountData, extractXlmBalance]);

  /**
   * Refresh only operations
   */
  const refreshOperations = useCallback(async (): Promise<void> => {
    try {
      abortControllerRef.current?.abort();
      const controller = new AbortController();
      abortControllerRef.current = controller;

      const operations = await fetchOperations(controller.signal);

      if (controller.signal.aborted) return;

      setState((prev) => ({
        ...prev,
        operations,
      }));
    } catch (error) {
      if (debug) {
        console.warn('[useStellarAccount] Failed to refresh operations:', error);
      }
    }
  }, [fetchOperations, debug]);

  /**
   * Reset state to initial
   */
  const reset = useCallback((): void => {
    abortControllerRef.current?.abort();
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
    }
    setState({
      account: null,
      xlmBalance: null,
      operations: [],
      isLoading: true,
      isFetching: false,
      error: null,
      lastUpdated: null,
      isUnfunded: false,
      isFundable: true,
    });
  }, []);

  /**
   * Initial fetch and auto-refresh setup
   */
  useEffect(() => {
    // Initial fetch
    refetch();

    // Setup auto-refresh interval
    if (autoRefreshInterval > 0) {
      intervalRef.current = setInterval(() => {
        refetch();
      }, autoRefreshInterval);
    }

    // Cleanup
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
      abortControllerRef.current?.abort();
    };
  }, [autoRefreshInterval, refetch]);

  return {
    ...state,
    refetch,
    refreshAccount,
    refreshOperations,
    reset,
  };
}
