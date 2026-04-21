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
  /** Optional Polymarket CLOB token id for the bucket — used to identify trades. */
  clob_token_id?: string | null;
};

export type ProjectionRow = {
  label: string;
  marketPct: number; // 0–100
  modelPct: number;  // 0–100
  edge: number;      // signed pp (model - market), integer
  isProjected: boolean; // true if projection mean falls inside this bucket
};

export type PeakConditions = {
  temp_c: number;
  cloud: number | null;
  precipitation: number | null;
  humidity: number | null;
  wind: number | null;
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
  /** 0-100 confidence score derived from band width + drift/plateau penalties. */
  confidence: number;
  forecastDrift: boolean;
  plateauDetected: boolean;
  /** Conditions interpolated to the peak hour, useful for UI display. */
  peak: PeakConditions | null;
};

export const cToF = (c: number): number => c * 9 / 5 + 32;
export const fToC = (f: number): number => (f - 32) * 5 / 9;

const lerp = (a: number, b: number, w: number) => a * (1 - w) + b * w;
const lerpNullable = (a: number | null, b: number | null, w: number): number | null => {
  if (a == null && b == null) return null;
  if (a == null) return b;
  if (b == null) return a;
  return lerp(a, b, w);
};

/** Interpolate hourly forecast path to land exactly on hoursToPeak. */
function interpolatePeak(
  path: WeatherSnapshotLike["forecast_path"],
  hoursToPeak: number,
): PeakConditions | null {
  if (!path || path.length === 0) return null;
  const h = Math.max(0, hoursToPeak);
  const lastOffset = path[path.length - 1].hour_offset;
  if (h >= lastOffset) {
    const p = path[path.length - 1];
    return { temp_c: p.temp_c, cloud: p.cloud, precipitation: p.precipitation, humidity: p.humidity, wind: p.wind };
  }
  // find bracketing points
  let lo = path[0];
  let hi = path[path.length - 1];
  for (let i = 0; i < path.length - 1; i++) {
    if (path[i].hour_offset <= h && path[i + 1].hour_offset >= h) {
      lo = path[i];
      hi = path[i + 1];
      break;
    }
  }
  const span = hi.hour_offset - lo.hour_offset || 1;
  const w = (h - lo.hour_offset) / span;
  return {
    temp_c: lerp(lo.temp_c, hi.temp_c, w),
    cloud: lerpNullable(lo.cloud, hi.cloud, w),
    precipitation: lerpNullable(lo.precipitation, hi.precipitation, w),
    humidity: lerpNullable(lo.humidity, hi.humidity, w),
    wind: lerpNullable(lo.wind, hi.wind, w),
  };
}

/** Project peak temp + uncertainty band using full forecast path when available. */
export function projectPeakTempC(
  s: WeatherSnapshotLike | null | undefined,
  hoursToPeak: number | null | undefined,
): {
  meanC: number;
  bandC: number;
  sigmaC: number;
  peak: PeakConditions | null;
  forecastDrift: boolean;
  plateauDetected: boolean;
} | null {
  if (!s || !Number.isFinite(s.temperature_now)) return null;
  const h = Number.isFinite(hoursToPeak as number) ? Math.max(0, Number(hoursToPeak)) : 0;

  // Layer 1+2: Mean from forecast path (preferred) or 1h linear fallback.
  let meanC: number;
  let peak: PeakConditions | null = null;
  if (s.forecast_path && s.forecast_path.length > 0) {
    peak = interpolatePeak(s.forecast_path, h);
    meanC = peak ? peak.temp_c : s.temperature_now;
  } else {
    // Fallback: 1h linear extrapolation with mild damping near peak.
    const rawForecastSpeed = s.temp_forecast_1h != null ? s.temp_forecast_1h - s.temperature_now : 0;
    let damp = 1;
    if (h <= 0) damp = 0;
    else if (h < 1) damp = 0.25;
    else if (h < 2) damp = 0.5;
    meanC = s.temperature_now + rawForecastSpeed * damp;
  }

  // Layer 3: Proportional weather adjustments at the peak hour (or current values as fallback).
  const peakCloud = peak?.cloud ?? s.cloud_cover;
  const peakPrecip = peak?.precipitation ?? s.precipitation;
  const peakHum = peak?.humidity ?? s.humidity;
  if (peakCloud != null) {
    const cloudAdj = ((peakCloud - 50) / 100) * -0.4;
    const precipAdj = peakPrecip != null ? Math.min(Math.max(peakPrecip, 0), 2) * -0.2 : 0;
    const humAdj = peakHum != null && peakHum > 80 ? -0.1 : 0;
    let totalAdj = cloudAdj + precipAdj + humAdj;
    totalAdj = Math.max(-0.8, Math.min(0.8, totalAdj));
    meanC += totalAdj;
  }

  // Curve-shape: detect plateau bracketing the peak.
  let plateauDetected = false;
  if (s.forecast_path && s.forecast_path.length >= 2) {
    const a = s.forecast_path.find((p) => p.hour_offset === Math.floor(h));
    const b = s.forecast_path.find((p) => p.hour_offset === Math.ceil(h));
    if (a && b && a !== b && Math.abs(a.temp_c - b.temp_c) < 0.2) {
      plateauDetected = true;
      meanC -= 0.3;
    }
  }

  // Forecast drift: compare last-hour real change vs what the model said would happen.
  let forecastDrift = false;
  if (s.temperature_1h_ago != null && s.temp_forecast_1h != null) {
    const realSpeed = s.temperature_now - s.temperature_1h_ago;
    const forecastSpeed = s.temp_forecast_1h - s.temperature_now;
    if (Math.abs(realSpeed - forecastSpeed) > 0.5) forecastDrift = true;
  }

  // Band: cloud + wind contributions evaluated at the peak hour.
  const peakWind = peak?.wind ?? s.wind_speed;
  const cloudPct = Math.max(0, Math.min(100, peakCloud ?? 0));
  const windKmh = Math.max(0, peakWind ?? 0);
  let bandF = Math.max(1, Math.min(4, 1 + (cloudPct / 100) * 1.5 + (windKmh / 30) * 1));
  if (forecastDrift) bandF = Math.min(5, bandF + 0.5);
  const bandC = bandF * 5 / 9;
  const sigmaC = bandC / 1.96;

  return { meanC, bandC, sigmaC, peak, forecastDrift, plateauDetected };
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
      const modelRow = rows.find((r) => r.label === modelTop.label)!;
      verdict = modelRow.edge >= 15 ? "STRONG_DISAGREE" : "WEAK_DISAGREE";
    } else {
      const row = rows.find((r) => r.label === marketTop.label)!;
      verdict = Math.abs(row.edge) <= 10 ? "AGREE" : "NEUTRAL";
    }
  }

  // Best value
  const positives = rows.filter((r) => r.edge > 0).sort((a, b) => b.edge - a.edge);
  const best = positives[0] ?? null;

  // Confidence: starts from band width, penalize drift + plateau.
  const bandF = proj.bandC * 9 / 5;
  let confidence = Math.round(100 - bandF * 15);
  if (proj.forecastDrift) confidence -= 20;
  if (proj.plateauDetected) confidence -= 5;
  confidence = Math.max(0, Math.min(100, confidence));

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
    confidence,
    forecastDrift: proj.forecastDrift,
    plateauDetected: proj.plateauDetected,
    peak: proj.peak,
  };
}
