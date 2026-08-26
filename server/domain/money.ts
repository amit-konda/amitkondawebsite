/**
 * Money rules — integer cents only, never floats.
 * Positive = won; negative = lost. Session results must sum to exactly 0.
 */

export const MAX_AMOUNT_CENTS = 100_000_000; // $1,000,000 per participant

export type ParseResult = { ok: true; cents: number } | { ok: false; error: string };

const CENTS_RE = /^([+-]?)(\d*)(?:\.(\d{1,2}))?$/;

/**
 * Parse a user-entered dollar string ("-12.50", "+10000", "6,000", "-.5") into cents.
 * Rejects malformed input, more than 2 decimals, and values above MAX_AMOUNT_CENTS.
 */
export function parseCentsInput(input: unknown): ParseResult {
  if (typeof input !== "string") return { ok: false, error: "Amount must be a string." };
  const cleaned = input.replace(/,/g, "").trim();
  const m = CENTS_RE.exec(cleaned);
  if (!m || (m[2] === "" && m[3] === undefined)) {
    return { ok: false, error: "Enter a dollar amount like -12.50 or +10000." };
  }
  const sign = m[1] === "-" ? -1 : 1;
  const dollars = m[2] === "" ? 0 : Number(m[2]);
  const frac = m[3] ?? "";
  const cents = sign * (dollars * 100 + Number(frac.padEnd(2, "0")));
  if (!Number.isSafeInteger(cents) || Math.abs(cents) > MAX_AMOUNT_CENTS) {
    return { ok: false, error: "Amount is outside the allowed range." };
  }
  return { ok: true, cents };
}

export interface ResultInput {
  memberId: string;
  amountCents: number;
}

/**
 * Validate a full set of session results:
 * >=2 participants, no duplicates, non-zero amounts within limits, exact zero sum.
 */
export function validateSessionResults(
  results: ResultInput[]
): { ok: true; results: ResultInput[] } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!Array.isArray(results) || results.length < 2) {
    return { ok: false, errors: ["At least two participants are required."] };
  }
  const seen = new Set<string>();
  let sum = 0;
  for (const r of results) {
    if (typeof r?.memberId !== "string" || !r.memberId) {
      errors.push("Every participant needs a member id.");
      continue;
    }
    if (seen.has(r.memberId)) {
      errors.push("Duplicate participant: " + r.memberId);
      continue;
    }
    seen.add(r.memberId);
    const cents = r.amountCents;
    if (!Number.isSafeInteger(cents)) {
      errors.push("Amounts must be whole cents.");
      continue;
    }
    if (cents === 0) {
      errors.push("Every participant amount must be non-zero.");
      continue;
    }
    if (Math.abs(cents) > MAX_AMOUNT_CENTS) {
      errors.push("An amount is outside the allowed range.");
      continue;
    }
    sum += cents;
  }
  if (errors.length > 0) return { ok: false, errors };
  if (sum !== 0) {
    return { ok: false, errors: ["Results must sum to exactly $0.00."] };
  }
  return { ok: true, results };
}

/** Format cents as "$1,234.56" (or "-$12.50"). */
export function formatCents(cents: number): string {
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100);
  const frac = String(abs % 100).padStart(2, "0");
  const grouped = dollars.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const sign = cents < 0 ? "-" : cents > 0 ? "+" : "";
  return `${sign}$${grouped}.${frac}`;
}
