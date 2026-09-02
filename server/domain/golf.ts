/**
 * Golf betting-line calculator.
 *
 * Each round is scored relative to the course's par that day (strokes -
 * par), so rounds played on a different tee/par setup stay comparable. For
 * a given player and course, the most recent up-to-3 rounds are weighted
 * 80% and every older round 20% — recent form matters most, but a long
 * losing (or winning) streak still nudges the number. A player with 3 or
 * fewer rounds total has no "historical" bucket, so their recent average
 * stands alone.
 *
 * The suggested line is always a half-stroke (4.5, never 4 or 5) so a
 * handshake bet built from it can never push.
 */

export interface GolfRoundInput {
  strokes: number;
  par: number;
  playedAt: string | Date;
}

export interface WeightedGolfStat {
  /** Weighted average strokes relative to par (lower is better). Null with zero rounds logged. */
  value: number | null;
  roundsCount: number;
  recentCount: number;
  historicalCount: number;
}

const RECENT_WINDOW = 3;
const RECENT_WEIGHT = 0.8;
const HISTORICAL_WEIGHT = 0.2;

function average(nums: number[]): number {
  return nums.reduce((sum, n) => sum + n, 0) / nums.length;
}

/**
 * Weighted "strokes relative to par" for one player at one course.
 * `rounds` need not be pre-sorted — this sorts by playedAt (most recent
 * first) itself before splitting into the recent/historical buckets.
 */
export function weightedGolfStat(rounds: GolfRoundInput[]): WeightedGolfStat {
  if (rounds.length === 0) {
    return { value: null, roundsCount: 0, recentCount: 0, historicalCount: 0 };
  }
  const sorted = [...rounds].sort(
    (a, b) => new Date(b.playedAt).getTime() - new Date(a.playedAt).getTime()
  );
  const toPar = sorted.map((r) => r.strokes - r.par);
  const recent = toPar.slice(0, RECENT_WINDOW);
  const historical = toPar.slice(RECENT_WINDOW);
  const recentAvg = average(recent);
  const value =
    historical.length > 0 ? RECENT_WEIGHT * recentAvg + HISTORICAL_WEIGHT * average(historical) : recentAvg;
  return { value, roundsCount: sorted.length, recentCount: recent.length, historicalCount: historical.length };
}

export interface StrokeLine {
  /** Strokes the weaker player receives — always ends in .5, so a bet built from it can never push. */
  strokes: number;
  /** Which side receives the strokes. */
  receiver: "a" | "b";
}

/**
 * Suggest a fair stroke line between two players' weighted stats at the
 * same course. Null when either side has no rounds logged yet — there's
 * nothing to base a line on.
 */
export function suggestStrokeLine(a: WeightedGolfStat, b: WeightedGolfStat): StrokeLine | null {
  if (a.value == null || b.value == null) return null;
  const diff = a.value - b.value; // positive: a's weighted score is worse (higher relative-to-par) than b's
  const receiver: "a" | "b" = diff >= 0 ? "a" : "b";
  // floor() + 0.5 guarantees the line always lands on a half-stroke, even
  // when the two players are (near) dead even (diff ~ 0 -> 0.5).
  const strokes = Math.floor(Math.abs(diff)) + 0.5;
  return { strokes, receiver };
}
