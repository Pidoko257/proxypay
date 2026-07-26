/**
 * Known Exchange Addresses Configuration
 *
 * Stores Stellar addresses of known exchanges and services that require a memo
 * to properly credit incoming payments. Payments to these addresses without
 * the required memo type will be rejected.
 *
 * Memo types (per Stellar SDK):
 * - "text"    - Memo.text (up to 28 bytes of arbitrary text)
 * - "id"      - Memo.id (unsigned 64-bit integer, used by many exchanges)
 * - "hash"    - Memo.hash (32-byte hash)
 */

export type StellarMemoType = "text" | "id" | "hash";

export interface ExchangeAddressEntry {
  /** The Stellar public key of the exchange/known service */
  address: string;
  /** Human-readable name for identification */
  name: string;
  /** The required memo type for payments to this address */
  requiredMemoType: StellarMemoType;
  /** Description of what the memo should contain */
  description?: string;
  /** When this entry was added */
  addedAt: string;
  /** Who added this entry */
  addedBy?: string;
}

/**
 * Initial list of known exchange addresses that require memos.
 *
 * These are well-known Stellar addresses for major exchanges.
 * This list should be kept up to date as exchanges may rotate addresses.
 *
 * NOTE: These are example addresses - replace with actual production addresses.
 */
export const KNOWN_EXCHANGE_ADDRESSES: ExchangeAddressEntry[] = [
  {
    address: "GCO2IP3MJNUOKS4PUDI4C7LGGMQDJGXG3COYX3WSB4HHNAHKYV5YL3VC",
    name: "Coinbase",
    requiredMemoType: "id",
    description:
      "Coinbase requires a Memo ID (numeric) for all XLM deposits. The memo is shown in your Coinbase XLM deposit page.",
    addedAt: new Date().toISOString(),
    addedBy: "system",
  },
  {
    address: "GB7GRJ5DTE3AA2TCVHQS2LAD3D7NFG7YLTOEWEBVRNUUI2Q3TJ5UQIFM",
    name: "Binance",
    requiredMemoType: "id",
    description:
      "Binance requires a Memo ID for XLM deposits. Find your unique memo ID on the Binance deposit page.",
    addedAt: new Date().toISOString(),
    addedBy: "system",
  },
  {
    address: "GA5XIGA5C7QTPTWXQHY6MCJRMTRZDOSHR6EFIBNDQTCQHG262N4GGKTM",
    name: "Kraken",
    requiredMemoType: "id",
    description:
      "Kraken requires a Memo ID for XLM deposits. Find it on your Kraken funding page.",
    addedAt: new Date().toISOString(),
    addedBy: "system",
  },
  {
    address: "GDUKMGUGDZQK6YHYA5Z6AY2G4XDSZPSZ3SW5UN3ARVMO6QSRDWP5YLEX",
    name: "Lobstr",
    requiredMemoType: "text",
    description:
      "Lobstr may require a text memo for certain deposit types. Check your Lobstr deposit instructions.",
    addedAt: new Date().toISOString(),
    addedBy: "system",
  },
];

/**
 * In-memory registry of exchange addresses (populated from the static list above).
 * This can be modified at runtime via admin endpoints.
 */
let exchangeAddressRegistry: ExchangeAddressEntry[] = [
  ...KNOWN_EXCHANGE_ADDRESSES,
];

/**
 * Normalize a Stellar address for comparison (uppercase).
 */
function normalizeAddress(address: string): string {
  return address.trim().toUpperCase();
}

/**
 * Check if an address is a known exchange address.
 * Returns the exchange entry if found, or null.
 */
export function findExchangeAddress(
  address: string,
): ExchangeAddressEntry | null {
  const normalized = normalizeAddress(address);
  return (
    exchangeAddressRegistry.find(
      (entry) => normalizeAddress(entry.address) === normalized,
    ) ?? null
  );
}

/**
 * Get all known exchange addresses.
 */
export function getAllExchangeAddresses(): ExchangeAddressEntry[] {
  return [...exchangeAddressRegistry];
}

/**
 * Add a new exchange address entry to the registry.
 * Returns the added entry.
 */
export function addExchangeAddress(
  entry: Omit<ExchangeAddressEntry, "addedAt">,
): ExchangeAddressEntry {
  const normalized = normalizeAddress(entry.address);

  // Check for duplicates
  const existing = exchangeAddressRegistry.find(
    (e) => normalizeAddress(e.address) === normalized,
  );
  if (existing) {
    throw new Error(
      `Address ${entry.address} is already registered as "${existing.name}"`,
    );
  }

  const newEntry: ExchangeAddressEntry = {
    ...entry,
    addedAt: new Date().toISOString(),
  };
  exchangeAddressRegistry.push(newEntry);
  return newEntry;
}

/**
 * Remove an exchange address entry by address.
 * Returns true if removed, false if not found.
 */
export function removeExchangeAddress(address: string): boolean {
  const normalized = normalizeAddress(address);
  const initialLength = exchangeAddressRegistry.length;
  exchangeAddressRegistry = exchangeAddressRegistry.filter(
    (entry) => normalizeAddress(entry.address) !== normalized,
  );
  return exchangeAddressRegistry.length < initialLength;
}

/**
 * Reset the registry to the initial state (useful for testing).
 */
export function resetExchangeAddressRegistry(): void {
  exchangeAddressRegistry = [...KNOWN_EXCHANGE_ADDRESSES];
}
