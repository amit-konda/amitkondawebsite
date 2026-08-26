import { describe, expect, it } from "vitest";
import {
  formatCents,
  MAX_AMOUNT_CENTS,
  parseCentsInput,
  validateSessionResults
} from "../../server/domain/money.js";

describe("parseCentsInput", () => {
  it("parses signed dollar strings into integer cents", () => {
    expect(parseCentsInput("-12.50")).toEqual({ ok: true, cents: -1250 });
    expect(parseCentsInput("+10000")).toEqual({ ok: true, cents: 1000000 });
    expect(parseCentsInput("6,000.5")).toEqual({ ok: true, cents: 600050 });
    expect(parseCentsInput("0.01")).toEqual({ ok: true, cents: 1 });
    expect(parseCentsInput("-.5")).toEqual({ ok: true, cents: -50 });
    expect(parseCentsInput("100")).toEqual({ ok: true, cents: 10000 });
  });

  it("rejects malformed, excessive-decimal, and unsafe values", () => {
    for (const bad of [
      "abc",
      "1.234",
      "12.5.0",
      "",
      "  ",
      "$12.50",
      "1_000",
      "0.001",
      "12..5",
      "--5",
      "1e3",
      "999999999999999999999"
    ]) {
      expect(parseCentsInput(bad).ok, `should reject ${JSON.stringify(bad)}`).toBe(false);
    }
  });

  it("rejects amounts above the safe product limit", () => {
    expect(parseCentsInput("1000001")).toEqual({
      ok: false,
      error: "Amount is outside the allowed range."
    });
    expect(parseCentsInput(String(MAX_AMOUNT_CENTS / 100))).toEqual({
      ok: true,
      cents: MAX_AMOUNT_CENTS
    });
  });
});

describe("validateSessionResults", () => {
  it("accepts a balanced three-player subset", () => {
    const r = validateSessionResults([
      { memberId: "a", amountCents: 10000 },
      { memberId: "b", amountCents: -6000 },
      { memberId: "c", amountCents: -4000 }
    ]);
    expect(r.ok).toBe(true);
  });

  it("rejects a one-cent imbalance", () => {
    const r = validateSessionResults([
      { memberId: "a", amountCents: 10000 },
      { memberId: "b", amountCents: -6000 },
      { memberId: "c", amountCents: -4001 }
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join()).toContain("sum");
  });

  it("rejects duplicate members and fewer than two participants", () => {
    const dup = validateSessionResults([
      { memberId: "a", amountCents: 100 },
      { memberId: "a", amountCents: -100 }
    ]);
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.errors.join()).toContain("Duplicate");

    const one = validateSessionResults([{ memberId: "a", amountCents: 100 }]);
    expect(one.ok).toBe(false);
    if (!one.ok) expect(one.errors.join()).toContain("two");

    const none = validateSessionResults([]);
    expect(none.ok).toBe(false);
  });

  it("rejects zero amounts", () => {
    const r = validateSessionResults([
      { memberId: "a", amountCents: 0 },
      { memberId: "b", amountCents: 0 }
    ]);
    expect(r.ok).toBe(false);
  });
});

describe("formatCents", () => {
  it("formats with sign, grouping, and two decimals", () => {
    expect(formatCents(1250)).toBe("+$12.50");
    expect(formatCents(-60)).toBe("-$0.60");
    expect(formatCents(1000000)).toBe("+$10,000.00");
    expect(formatCents(0)).toBe("$0.00");
  });
});
