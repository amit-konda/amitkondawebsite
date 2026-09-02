import { describe, expect, it } from "vitest";
import { suggestStrokeLine, weightedGolfStat } from "../../server/domain/golf.js";
import type { GolfRoundInput } from "../../server/domain/golf.js";

function round(strokes: number, par: number, playedAt: string): GolfRoundInput {
  return { strokes, par, playedAt };
}

describe("weightedGolfStat", () => {
  it("returns null with zero rounds logged", () => {
    expect(weightedGolfStat([])).toEqual({ value: null, roundsCount: 0, recentCount: 0, historicalCount: 0 });
  });

  it("is a plain average when there are 3 or fewer rounds (no historical bucket yet)", () => {
    const rounds = [round(50, 45, "2026-08-01"), round(48, 45, "2026-08-15"), round(52, 45, "2026-09-01")];
    // relative to par: +5, +3, +7 -> plain average = 5
    const stat = weightedGolfStat(rounds);
    expect(stat.value).toBeCloseTo(5, 10);
    expect(stat.roundsCount).toBe(3);
    expect(stat.recentCount).toBe(3);
    expect(stat.historicalCount).toBe(0);
  });

  it("weights the most recent 3 rounds 80% and everything older 20%, sorting by playedAt itself", () => {
    // Deliberately out of order — the function must sort by playedAt.
    const rounds = [
      round(90, 70, "2026-01-01"), // oldest: +20
      round(85, 70, "2026-09-01"), // most recent: +15
      round(80, 70, "2026-02-01"), // 2nd oldest: +10
      round(83, 70, "2026-08-15"), // 2nd most recent: +13
      round(84, 70, "2026-08-01") // 3rd most recent: +14
    ];
    // Sorted desc by date -> relative-to-par: [+15, +13, +14, +10, +20]
    // recent 3 = [15, 13, 14] avg = 14; historical = [10, 20] avg = 15
    // weighted = 0.8*14 + 0.2*15 = 11.2 + 3 = 14.2
    const stat = weightedGolfStat(rounds);
    expect(stat.value).toBeCloseTo(14.2, 10);
    expect(stat.roundsCount).toBe(5);
    expect(stat.recentCount).toBe(3);
    expect(stat.historicalCount).toBe(2);
  });

  it("handles a single round", () => {
    const stat = weightedGolfStat([round(58, 54, "2026-05-01")]);
    expect(stat.value).toBe(4);
    expect(stat.roundsCount).toBe(1);
  });
});

describe("suggestStrokeLine", () => {
  it("returns null when either player has no rounds logged", () => {
    const none = weightedGolfStat([]);
    const some = weightedGolfStat([round(50, 45, "2026-08-01")]);
    expect(suggestStrokeLine(none, some)).toBeNull();
    expect(suggestStrokeLine(some, none)).toBeNull();
  });

  it("gives the weaker (higher relative-to-par) player strokes", () => {
    const strong = weightedGolfStat([round(46, 45, "2026-08-01")]); // +1
    const weak = weightedGolfStat([round(53, 45, "2026-08-01")]); // +8
    const line = suggestStrokeLine(strong, weak);
    expect(line?.receiver).toBe("b"); // weak is player "b" here
    expect(line?.strokes).toBe(7.5); // floor(|1-8|) + 0.5 = 7.5
  });

  it("always lands on a half-stroke, never a whole number, even for a dead-even matchup", () => {
    const even1 = weightedGolfStat([round(50, 45, "2026-08-01")]);
    const even2 = weightedGolfStat([round(50, 45, "2026-08-01")]);
    const line = suggestStrokeLine(even1, even2);
    expect(line?.strokes).toBe(0.5);

    const a = weightedGolfStat([round(53, 45, "2026-08-01")]); // +8
    const b = weightedGolfStat([round(45, 45, "2026-08-01")]); // +0, diff = 8 exactly
    const wholeDiffLine = suggestStrokeLine(a, b);
    expect(wholeDiffLine?.strokes).toBe(8.5); // floor(8) + 0.5, not 8
  });
});
