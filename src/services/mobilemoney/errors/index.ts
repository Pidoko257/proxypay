/**
 * Provider Error Adapter Registry
 *
 * Centralised lookup for provider-specific error adapters.
 * Use `getProviderErrorAdapter(providerName)` anywhere in the codebase
 * to translate raw provider errors into canonical ProviderError objects.
 *
 * @example
 * import { getProviderErrorAdapter } from './errors';
 *
 * const adapter = getProviderErrorAdapter('mtn');
 * const error = adapter.mapError(rawAxiosError, 'requestPayment');
 */

export { ProviderError, ProviderErrorCode, logProviderError, TRANSIENT_PROVIDER_ERRORS } from "./providerErrors";
export type { IProviderErrorAdapter, ProviderErrorContext } from "./providerErrors";

import { IProviderErrorAdapter } from "./providerErrors";
import { MTNErrorAdapter } from "./mtnErrorAdapter";
import { AirtelErrorAdapter } from "./airtelErrorAdapter";
import { OrangeErrorAdapter } from "./orangeErrorAdapter";

const adapters = new Map<string, IProviderErrorAdapter>([
  ["mtn", new MTNErrorAdapter()],
  ["airtel", new AirtelErrorAdapter()],
  ["orange", new OrangeErrorAdapter()],
]);

/**
 * Returns the registered error adapter for the given provider name.
 * Provider names are case-insensitive (normalised to lowercase).
 * If no specific adapter is found a generic no-op adapter is returned.
 */
export function getProviderErrorAdapter(
  providerName: string,
): IProviderErrorAdapter {
  const key = providerName.toLowerCase();
  const adapter = adapters.get(key);
  if (adapter) return adapter;

  // Fallback: return the first registered adapter that matches a prefix
  for (const [registeredKey, registeredAdapter] of adapters) {
    if (key.startsWith(registeredKey) || registeredKey.startsWith(key)) {
      return registeredAdapter;
    }
  }

  // Generic fallback — wraps the error with minimum information
  return {
    providerName,
    mapError: (rawError, operation) => {
      const { ProviderError: PE, ProviderErrorCode: PEC } =
        // dynamic require to avoid circular imports in test environments
        require("./providerErrors") as typeof import("./providerErrors");
      const message =
        rawError instanceof Error ? rawError.message : String(rawError);
      return new PE(`${providerName} ${operation} failed: ${message}`, PEC.UNKNOWN, {
        provider: providerName,
        operation,
        originalError: rawError,
        rawMessage: message,
      });
    },
  };
}
