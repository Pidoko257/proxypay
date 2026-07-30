/**
 * PII masking utility.
 *
 * Complements `redact.ts` (which strips values keyed by a sensitive field
 * name) by scanning string *content* for common PII patterns — email
 * addresses and phone numbers — and masking them wherever they appear,
 * including inside free-text messages such as error strings.
 */

export const PII_MASK = "[REDACTED_PII]";

const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

// Matches E.164-style numbers (+ followed by 6-15 digits) or grouped/
// separated numbers like "080-1234-5678" / "(080) 123 4567". Requires a
// separator or a leading "+" so plain numeric ids/amounts are left alone.
const PHONE_REGEX =
  /\+\d{6,15}\b|\(?\d{2,4}\)?[\s.-]\d{3,4}[\s.-]\d{3,4}(?:[\s.-]\d{2,4})?\b/g;

function maskEmail(email: string): string {
  const atIndex = email.indexOf("@");
  if (atIndex <= 0) return PII_MASK;
  const user = email.slice(0, atIndex);
  const domain = email.slice(atIndex + 1);
  const visible = user.slice(0, 1);
  return `${visible}${"*".repeat(Math.max(user.length - 1, 3))}@${domain}`;
}

function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length <= 4) return "*".repeat(digits.length);
  const lastFour = digits.slice(-4);
  return `${"*".repeat(digits.length - 4)}${lastFour}`;
}

/** Masks emails and phone numbers found anywhere within a string. */
export function maskPiiInString(value: string): string {
  return value.replace(EMAIL_REGEX, maskEmail).replace(PHONE_REGEX, maskPhone);
}

/**
 * Recursively walks a value, masking PII found in any string it contains.
 * Mirrors `redact()`'s traversal shape but targets value *content* rather
 * than field names, so it is safe to compose with `redact()`.
 */
export function maskPii(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (value instanceof Error) {
    const plain: Record<string, unknown> = {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
    for (const key of Object.keys(value as unknown as Record<string, unknown>)) {
      plain[key] = (value as unknown as Record<string, unknown>)[key];
    }
    return maskPii(plain);
  }

  if (Array.isArray(value)) {
    return value.map((item) => maskPii(item));
  }

  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      result[key] = maskPii(val);
    }
    return result;
  }

  if (typeof value === "string") {
    return maskPiiInString(value);
  }

  return value;
}
