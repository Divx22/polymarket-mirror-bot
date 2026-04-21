// Detects whether a weather market question asks for a daily LOW (min) or
// daily HIGH (max). Defaults to "max" when ambiguous, since the vast majority
// of Polymarket weather markets resolve on the daily high.

export type TempExtreme = "min" | "max";

const MIN_PATTERNS = [
  /\blowest\b/i,
  /\bminimum\b/i,
  /\bmin\.?\s*temp/i,
  /\boverniGht\s*low/i,
  /\bdaily\s*low\b/i,
  /\blow\s*temp(erature)?\b/i,
  /\bcoldest\b/i,
];

const MAX_PATTERNS = [
  /\bhighest\b/i,
  /\bmaximum\b/i,
  /\bmax\.?\s*temp/i,
  /\bdaily\s*high\b/i,
  /\bhigh\s*temp(erature)?\b/i,
  /\bhottest\b/i,
  /\bpeak\s*temp/i,
];

/**
 * Detect the temperature extreme being asked about.
 *
 * Pass any text that may identify the market — typically the market_question.
 * Multiple inputs are concatenated, so it's safe to pass `(question, slug)`.
 */
export function detectTempExtreme(...texts: Array<string | null | undefined>): TempExtreme {
  const blob = texts.filter(Boolean).join(" ");
  if (!blob) return "max";
  // Min wins ties — markets usually say "highest" implicitly, so an explicit
  // "lowest" is a strong signal we should respect.
  if (MIN_PATTERNS.some((re) => re.test(blob))) return "min";
  if (MAX_PATTERNS.some((re) => re.test(blob))) return "max";
  return "max";
}
