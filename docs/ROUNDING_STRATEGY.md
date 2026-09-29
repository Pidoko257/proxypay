# Transaction Amount Rounding Strategy & Rules

## 1. Overview & Problem Statement
In high-volume financial applications and multi-currency payment platforms, standard rounding (often known as "round-half-up" or `Math.round(x)`) creates a systemic upward statistical bias because ties ending in `.5` always round upwards away from zero. 

When millions of transactions, fee splits, or exchange conversions are aggregated in reconciliation engines, this asymmetric rounding leads to "off-by-cent" reconciliation drift, discrepancy reports with banking partners, and unaligned ledger totals.

To guarantee precision and mathematical consistency across **display**, **storage**, and **calculation**, Proxypay standardizes on **Banker's Rounding** (also known as **Round Half to Even** or **Gaussian Rounding** / **IEEE 754 standard rounding**).

---

## 2. Banker's Rounding (Round Half to Even)

### The Rule
- If the fraction to be rounded is **less than 0.5**, round down (towards zero).
- If the fraction to be rounded is **greater than 0.5**, round up (away from zero).
- If the fraction is **exactly 0.5** (a tie):
  - Round to the nearest **even** integer.
  - If the preceding digit is even, keep it unchanged.
  - If the preceding digit is odd, round up to make it even.

### Comparison Table
| Value | Standard Round-Half-Up | Banker's Rounding (Half to Even) |
|---|---|---|
| `2.4` | `2.0` | `2.0` |
| `2.5` | `3.0` | **`2.0`** (2 is even) |
| `2.6` | `3.0` | `3.0` |
| `3.5` | `4.0` | **`4.0`** (4 is even) |
| `1.245` (2 dp) | `1.25` | **`1.24`** (4 is even) |
| `1.255` (2 dp) | `1.26` | **`1.26`** (6 is even) |
| `-2.5` | `-3.0` | **`-2.0`** |
| `-3.5` | `-4.0` | **`-4.0`** |

### Statistical Implication
Across large transactional batches, approximately 50% of `.5` ties round up and 50% round down, resulting in a zero expected rounding bias and perfect reconciliation equilibrium between provider debits and merchant credits.

---

## 3. Currency-Specific Precision Rules (ISO 4217)

| Currency | Code | Minor Units | Smallest Unit | Strategy |
|---|---|---|---|---|
| **Central African CFA Franc** | `XAF` | `0` | `1 FCFA` | Round to nearest even whole integer |
| **Ghanaian Cedi** | `GHS` | `2` | `0.01 ₵` (Pesewa) | Round to 2 decimal places using half-even |
| **Nigerian Naira** | `NGN` | `2` | `0.01 ₦` (Kobo) | Round to 2 decimal places using half-even |
| **US Dollar** | `USD` | `2` | `0.01 $` (Cent) | Round to 2 decimal places using half-even |

---

## 4. Platform Implementation & Developer Usage

### Core Utilities
The platform provides centralized, IEEE 754 float-drift-safe utilities under `src/utils/currency/`:

```typescript
import { roundHalfEven, bankersRound, roundCurrencyBankers } from './src/utils/currency/bankersRounding';
import { CurrencyFormatter } from './src/utils/currency/CurrencyFormatter';

// 1. General banker's rounding to specific decimals
const roundedVal = roundHalfEven(1.245, 2); // 1.24
const roundedVal2 = bankersRound(1.255, 2); // 1.26

// 2. Rounding by ISO 4217 currency
const usdAmount = roundCurrencyBankers(100.005, 'USD'); // 100.00
const xafAmount = roundCurrencyBankers(5000.5, 'XAF');  // 5000

// 3. CurrencyFormatter static helpers
const formatted = CurrencyFormatter.format(1.245, 'USD', { roundingMode: 'half-even' });
const rounded = CurrencyFormatter.roundAmountBankers(1.255, 'USD'); // 1.26
```

---

## 5. Architectural Consistency Guidelines
1. **Calculations**: All intermediate fees, split payments, and FX conversions must maintain full IEEE 754 precision until the final settlement or balance step, where `roundCurrencyBankers(amount, currency)` is applied.
2. **Reconciliation**: When comparing provider settlements with platform internal ledger rows, both sums must be evaluated after applying half-even rounding to prevent off-by-one-cent warnings.
3. **Database Storage**: Fractional monetary units stored as integer minor units (cents / pesewas / kobo) must be cast via `roundCurrencyBankers` prior to database persistence.
4. **Display**: UI and receipts must reflect identical values to internal accounting by using `CurrencyFormatter` with the unified rounding rules.