// Weather → Market bucket matcher.
// Pure functions that project a peak temperature from a weather snapshot
// and compare its probability mass against Polymarket bucket prices.

import type { WeatherSnapshotLike } from "./weather";

export type MarketVerdict = "AGREE" | "NEUTRAL" | "WEAK_DISAGREE" | "STRONG_DISAGREE" | "UNKNOWN";

export type BucketLike = {
  label: string;
  bucket_min_c: number | null;
  bucket_max_c: number | null;
  /** Live mid (preferred) or polymarket_price, in 0–1 range. */
  marketPrice: number | null;
};

export type ProjectionRow = {
  label: string;
  marketPct: number; // 0–100
  modelPct: number;  // 0–100
  edge: number;      // signed pp (model - market), integer
  isProjected: boolean; // true if projection mean falls inside this bucket
};

export type ProjectionResult = {
  meanC: number;
  bandC: number;       // ± half-width in °C
  sigmaC: number;      // band / 1.96
  hoursToPeak: number;
  rows: ProjectionRow[];
  verdict: MarketVerdict;
  marketTopLabel: string | null;
  modelTopLabel: string | null;
  bestValueLabel: string | null; // bucket with highest positive edge (model − market)
  bestValueEdge: number | null;  // pp; null when no positive edge exists
};

export const cToF = (c: number): number => c * 9 / 5 + 32;
export const fToC = (f: number): number => (f - 32) * 5 / 9;

/** Linear extrapolation of peak temp (°C). Falls back gracefully when forecast_speed is missing. */
export function projectPeakTempC(
  s: WeatherSnapshotLike | null | undefined,
  hoursToPeak: number | null | undefined,
): { meanC: number; bandC: number; sigmaC: number } | null {
  if (!s || !Number.isFinite(s.temperature_now)) return null;
  const h = Number.isFinite(hoursToPeak as number) ? Math.max(0, Number(hoursToPeak)) : 0;
  const rawForecastSpeed = s.temp_forecast_1h != null ? s.temp_forecast_1h - s.temperature_now : 0;
  // Dampen late-stage growth — temperature is non-linear near peak and flattens.
  let damp = 1;
  if (h <= 0) damp = 0;
  else if (h < 1) damp = 0.25;
  else if (h < 2) damp = 0.5;
  const forecastSpeed = rawForecastSpeed * damp;
  const meanC = s.temperature_now + forecastSpeed * h;

  // Band: base 1°F + cloud/wind contributions, capped 1–4°F → convert to °C
  const cloudPct = Math.max(0, Math.min(100, s.cloud_cover ?? 0));
  const windKmh = Math.max(0, s.wind_speed ?? 0);
  const bandF = Math.max(1, Math.min(4, 1 + (cloudPct / 100) * 1.5 + (windKmh / 30) * 1));
  const bandC = bandF * 5 / 9;
  const sigmaC = bandC / 1.96;
  return { meanC, bandC, sigmaC };
}

// Abramowitz & Stegun erf approximation (max error ~1.5e-7)
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const y =
    1 -
    (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-a * a);
  return sign * y;
}

const normalCdf = (x: number, mean: number, sigma: number): number => {
  if (sigma <= 0) return x >= mean ? 1 : 0;
  return 0.5 * (1 + erf((x - mean) / (sigma * Math.SQRT2)));
};

/** Probability mass of N(meanC, sigmaC) inside [minC, maxC]. Open ends supported via ±Infinity. */
export function bucketProbability(
  meanC: number,
  sigmaC: number,
  minC: number | null,
  maxC: number | null,
): number {
  const lo = minC == null ? -Infinity : minC;
  const hi = maxC == null ? Infinity : maxC;
  if (hi <= lo) return 0;
  const pHi = hi === Infinity ? 1 : normalCdf(hi, meanC, sigmaC);
  const pLo = lo === -Infinity ? 0 : normalCdf(lo, meanC, sigmaC);
  return Math.max(0, Math.min(1, pHi - pLo));
}

const inBucket = (mean: number, minC: number | null, maxC: number | null): boolean => {
  const lo = minC ?? -Infinity;
  const hi = maxC ?? Infinity;
  return mean >= lo && mean < hi;
};

export function compareToMarket(
  snapshot: WeatherSnapshotLike | null | undefined,
  hoursToPeak: number | null | undefined,
  buckets: BucketLike[],
): ProjectionResult | null {
  const proj = projectPeakTempC(snapshot, hoursToPeak);
  if (!proj) return null;
  const usable = buckets.filter(
    (b) => b.marketPrice != null && Number.isFinite(b.marketPrice) && (b.bucket_min_c != null || b.bucket_max_c != null),
  );
  if (usable.length === 0) return null;

  // Top 4 by market price desc
  const top = [...usable].sort((a, b) => (b.marketPrice as number) - (a.marketPrice as number)).slice(0, 4);

  // Normalize market prices across the top 4 so they sum to ~1 (display purposes only)
  const marketSum = top.reduce((s, b) => s + (b.marketPrice as number), 0) || 1;

  // Compute raw model probabilities then renormalize to the same top-4 universe
  const rawModel = top.map((b) => bucketProbability(proj.meanC, proj.sigmaC, b.bucket_min_c, b.bucket_max_c));
  const modelSum = rawModel.reduce((s, p) => s + p, 0) || 1;

  const rows: ProjectionRow[] = top.map((b, i) => {
    const marketPct = ((b.marketPrice as number) / marketSum) * 100;
    const modelPct = (rawModel[i] / modelSum) * 100;
    return {
      label: b.label,
      marketPct,
      modelPct,
      edge: Math.round(modelPct - marketPct),
      isProjected: inBucket(proj.meanC, b.bucket_min_c, b.bucket_max_c),
    };
  });

  const marketTop = [...rows].sort((a, b) => b.marketPct - a.marketPct)[0] ?? null;
  const modelTop = [...rows].sort((a, b) => b.modelPct - a.modelPct)[0] ?? null;

  let verdict: MarketVerdict = "UNKNOWN";
  if (marketTop && modelTop) {
    if (marketTop.label !== modelTop.label) {
      // Strength-filtered: edge magnitude on the model's top bucket determines severity.
      const modelRow = rows.find((r) => r.label === modelTop.label)!;
      verdict = modelRow.edge >= 15 ? "STRONG_DISAGREE" : "WEAK_DISAGREE";
    } else {
      // Same #1; check edge magnitude on market #1 row
      const row = rows.find((r) => r.label === marketTop.label)!;
      verdict = Math.abs(row.edge) <= 10 ? "AGREE" : "NEUTRAL";
    }
  }

  // Best value: bucket with the highest positive edge (model − market).
  const positives = rows.filter((r) => r.edge > 0).sort((a, b) => b.edge - a.edge);
  const best = positives[0] ?? null;

  return {
    meanC: proj.meanC,
    bandC: proj.bandC,
    sigmaC: proj.sigmaC,
    hoursToPeak: Number.isFinite(hoursToPeak as number) ? Number(hoursToPeak) : 0,
    rows,
    verdict,
    marketTopLabel: marketTop?.label ?? null,
    modelTopLabel: modelTop?.label ?? null,
    bestValueLabel: best?.label ?? null,
    bestValueEdge: best?.edge ?? null,
  };
}
