/**
 * Stellar Account Viewer - Barrel Export
 * Central export point for all components and utilities
 */

// Main component
export { StellarAccountViewer, default } from './StellarAccountViewer';

// Subcomponents
export { BalanceDisplay } from './BalanceDisplay';
export { OperationsHistory } from './OperationsHistory';
export { AccountFlags } from './AccountFlags';

// Hook
export { useStellarAccount } from './useStellarAccount';

// Types
export type {
  Balance,
  AccountFlags,
  Signer,
  StellarAccount,
  Operation,
  OperationsResponse,
  StellarAccountState,
  UseStellarAccountOptions,
  UseStellarAccountReturn,
  StellarAccountViewerProps,
  BalanceDisplayProps,
  OperationsHistoryProps,
  AccountFlagsProps,
  FormattedOperation,
  HorizonConfig,
  FetchAccountOptions,
} from './types';

export {
  StellarAccountError,
  StellarAccountViewerError,
} from './types';

// CSS Module (for TypeScript support)
import styles from './StellarAccountViewer.module.css';
export { styles };
