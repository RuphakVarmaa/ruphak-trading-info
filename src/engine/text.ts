/** Small text helpers for the engine's human-readable reasons. */

/** An English ordinal: 1st, 2nd, 3rd, 4th … 11th, 12th, 13th … 21st, 62nd, 101st. */
export function ordinal(n: number): string {
  const tens = Math.abs(n) % 100;
  const suffix = tens >= 11 && tens <= 13 ? "th" : (["th", "st", "nd", "rd"][Math.abs(n) % 10] ?? "th");
  return `${n}${suffix}`;
}
