import { badRequest } from "../errors.js";

export interface WeightedShare {
  participantId: string;
  weight: number;
}

/**
 * Deterministically distributes integer cents by largest remainder.
 * Ties are resolved by participant id, so retries produce identical totals.
 */
export function allocateLargestRemainder(totalCents: number, shares: WeightedShare[]): Map<string, number> {
  if (!Number.isSafeInteger(totalCents) || totalCents < 0) {
    throw badRequest("invalid_amount", "Amount must be non-negative integer cents.");
  }
  if (shares.length === 0) {
    if (totalCents === 0) return new Map();
    throw badRequest("missing_shares", "At least one share is required.");
  }
  if (new Set(shares.map((share) => share.participantId)).size !== shares.length) {
    throw badRequest("duplicate_share", "Each participant may appear only once.");
  }
  const totalWeight = shares.reduce((sum, share) => {
    if (!Number.isSafeInteger(share.weight) || share.weight <= 0) {
      throw badRequest("invalid_share", "Share weights must be positive integers.");
    }
    return sum + share.weight;
  }, 0);
  if (!Number.isSafeInteger(totalWeight)) throw badRequest("invalid_share", "Share weights are too large.");

  const totalWeightBig = BigInt(totalWeight);
  const rows = shares.map((share) => {
    const numerator = BigInt(totalCents) * BigInt(share.weight);
    return {
      ...share,
      amount: Number(numerator / totalWeightBig),
      remainder: numerator % totalWeightBig
    };
  });
  let remaining = totalCents - rows.reduce((sum, row) => sum + row.amount, 0);
  rows.sort((a, b) => (a.remainder === b.remainder ? a.participantId.localeCompare(b.participantId) : a.remainder > b.remainder ? -1 : 1));
  for (let i = 0; i < remaining; i++) rows[i]!.amount += 1;
  return new Map(rows.map((row) => [row.participantId, row.amount]));
}

export interface ParticipantSubtotal {
  participantId: string;
  subtotalCents: number;
}

export interface FinalAllocation extends ParticipantSubtotal {
  taxCents: number;
  tipCents: number;
  feesCents: number;
  discountCents: number;
  totalCents: number;
}

/** Allocate receipt adjustments proportionally and guarantee exact reconciliation. */
export function allocateReceiptTotals(
  subtotals: ParticipantSubtotal[],
  adjustments: { taxCents: number; tipCents: number; feesCents: number; discountCents: number }
): FinalAllocation[] {
  for (const row of subtotals) {
    if (!Number.isSafeInteger(row.subtotalCents) || row.subtotalCents < 0) {
      throw badRequest("invalid_amount", "Subtotals must be non-negative integer cents.");
    }
  }
  const shares = subtotals.map((row) => ({ participantId: row.participantId, weight: row.subtotalCents }));
  if (shares.every((share) => share.weight === 0)) {
    if (Object.values(adjustments).some((value) => value !== 0)) {
      throw badRequest("zero_subtotal", "Cannot allocate adjustments across a zero subtotal.");
    }
    return subtotals.map((row) => ({ ...row, taxCents: 0, tipCents: 0, feesCents: 0, discountCents: 0, totalCents: 0 }));
  }
  const nonzero = shares.filter((share) => share.weight > 0);
  const tax = allocateLargestRemainder(adjustments.taxCents, nonzero);
  const tip = allocateLargestRemainder(adjustments.tipCents, nonzero);
  const fees = allocateLargestRemainder(adjustments.feesCents, nonzero);
  const discount = allocateLargestRemainder(adjustments.discountCents, nonzero);
  return subtotals.map((row) => {
    const taxCents = tax.get(row.participantId) ?? 0;
    const tipCents = tip.get(row.participantId) ?? 0;
    const feesCents = fees.get(row.participantId) ?? 0;
    const discountCents = discount.get(row.participantId) ?? 0;
    const totalCents = row.subtotalCents + taxCents + tipCents + feesCents - discountCents;
    if (totalCents < 0) throw badRequest("discount_exceeds_share", "A discount cannot make a participant total negative.");
    return {
      ...row,
      taxCents,
      tipCents,
      feesCents,
      discountCents,
      totalCents
    };
  });
}
