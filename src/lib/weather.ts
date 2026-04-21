export type WeatherMarket = {
  id: string;
  city: string;
  latitude: number;
  longitude: number;
  market_question: string;
  condition_type: string;
  event_time: string;
  polymarket_url: string | null;
  polymarket_event_slug: string | null;
  active: boolean;
  updated_at: string;
  event_volume_24h: number | null;
  resolution_station_code: string | null;
  resolution_station_name: string | null;
  resolution_lat: number | null;
  resolution_lon: number | null;
};

// Within this window, weather is essentially deterministic and any apparent
// "edge" is likely a settlement quirk we don't understand (station rounding,
// observation timing, etc.). Suppress these from Best Trade.
export const SETTLEMENT_RISK_HOURS = 6;

export const hoursToResolution = (eventTime: string | null | undefined): number | null => {
  if (!eventTime) return null;
  const t = new Date(eventTime).getTime();
  if (!Number.isFinite(t)) return null;
  return (t - Date.now()) / 3_600_000;
};

export const isSettlementRisk = (eventTime: string | null | undefined): boolean => {
  const h = hoursToResolution(eventTime);
  return h != null && h <= SETTLEMENT_RISK_HOURS && h > -1; // exclude already-resolved (>1h past)
};

// Cap a suggested-size percent at the user's max_trade_pct (default 2%).
// Returns { capped, original } so UI can show "Capped from 4% → 2%".
export const applyMaxTradeCap = (
  suggestedPct: number | null | undefined,
  maxPct: number,
): { capped: number; wasCapped: boolean } => {
  const s = Number(suggestedPct ?? 0);
  if (!Number.isFinite(s) || s <= 0) return { capped: 0, wasCapped: false };
  const m = Number.isFinite(maxPct) && maxPct > 0 ? maxPct : 2;
  if (s > m) return { capped: m, wasCapped: true };
  return { capped: s, wasCapped: false };
};

export type WeatherOutcome = {
  id: string;
  market_id: string;
  label: string;
  bucket_min_c: number | null;
  bucket_max_c: number | null;
  sub_market_question: string | null;
  clob_token_id: string | null;
  condition_id: string | null;
  polymarket_price: number | null;
  p_model: number | null;
  p_noaa: number | null;
  p_ecmwf: number | null;
  edge: number | null;
  suggested_size_percent: number | null;
  display_order: number;
  updated_at: string;
};

export type WeatherSignal = {
  id: string;
  market_id: string;
  agreement: number;
  confidence_level: "high" | "medium" | "low" | null;
  best_outcome_label: string | null;
  best_edge: number | null;
  best_suggested_size_percent: number | null;
  created_at: string;
  market_favorite_label: string | null;
  market_favorite_price: number | null;
  model_favorite_label: string | null;
  model_favorite_prob: number | null;
  favorite_mismatch: boolean | null;
  distribution?: {
    sources?: {
      provider_disagreement?: boolean;
      disagreements?: { source: string; delta_c: number; value_c: number }[];
      reference_max_c?: number | null;
      nbm_max_c?: number | null;
      visual_crossing_max_c?: number | null;
      [k: string]: any;
    };
    [k: string]: any;
  } | null;
};

export const pct = (n: number | null | undefined, dp = 1) =>
  n == null || !Number.isFinite(Number(n))
    ? "—"
    : `${(Number(n) * 100).toFixed(dp)}%`;

export const confidenceColor = (c: string | null | undefined) => {
  if (c === "high") return "bg-emerald-500/15 text-emerald-400 border-emerald-500/30";
  if (c === "medium") return "bg-amber-500/15 text-amber-400 border-amber-500/30";
  if (c === "low") return "bg-red-500/15 text-red-400 border-red-500/30";
  return "bg-muted text-muted-foreground border-border";
};

export const edgeColor = (edge: number | null | undefined) => {
  if (edge == null) return "text-muted-foreground";
  if (edge >= 0.07) return "text-emerald-400";
  if (edge <= -0.07) return "text-red-400";
  return "text-muted-foreground";
};

export const sizeForEdge = (edge: number, agreement = 1): number => {
  const abs = Math.abs(edge);
  if (abs < 0.07) return 0;
  let base = 1;
  if (abs >= 0.15) base = 3;
  else if (abs >= 0.1) base = 2;
  return Number((base * agreement).toFixed(2));
};

// ───────────────────────────────────────────────────────────────────────────
// Momentum decision engine: ENTER / ADD / HOLD / TRIM
// All gap/acceleration values are in 0–1 units (percent of probability).
// ───────────────────────────────────────────────────────────────────────────

export type MomentumAction = "ENTER" | "ADD" | "HOLD" | "TRIM";
export type WeatherState = "STRONG" | "MODERATE" | "WEAK" | "UNKNOWN";
export type MomentumMode = "MOMENTUM" | "TRANSITION" | "CERTAINTY";

export type ActionDecision = {
  action: MomentumAction;
  confidence: number; // 0–100
  reason: string;
  acceleration: number; // 0–1 units
  volumeChange: number | null; // USDC delta, null when unknown
  degraded: boolean; // true when volume data unavailable
  mode: MomentumMode;
  weatherState: WeatherState;
};

export type WeatherSnapshotLike = {
  temperature_now: number;
  temperature_1h_ago: number | null;
  temp_forecast_1h: number | null;
  cloud_cover: number | null;
  precipitation: number | null;
  humidity: number | null;
  wind_speed: number | null;
};

/** Weather score per spec: cloud<30:+2, 30–70:+1, >70:-2; precip>0:-3; humidity>75:-1; wind>20:-1. */
export const computeWeatherScore = (s: WeatherSnapshotLike | null | undefined): number => {
  if (!s) return 0;
  let score = 0;
  const c = s.cloud_cover;
  if (c != null) {
    if (c < 30) score += 2;
    else if (c <= 70) score += 1;
    else score -= 2;
  }
  if ((s.precipitation ?? 0) > 0) score -= 3;
  if ((s.humidity ?? 0) > 75) score -= 1;
  if ((s.wind_speed ?? 0) > 20) score -= 1;
  return score;
};

export const classifyWeather = (s: WeatherSnapshotLike | null | undefined): { state: WeatherState; score: number; tempSpeed: number | null; forecastSpeed: number | null } => {
  if (!s) return { state: "UNKNOWN", score: 0, tempSpeed: null, forecastSpeed: null };
  const tempSpeed = s.temperature_1h_ago != null ? s.temperature_now - s.temperature_1h_ago : null;
  const forecastSpeed = s.temp_forecast_1h != null ? s.temp_forecast_1h - s.temperature_now : null;
  const score = computeWeatherScore(s);
  let state: WeatherState = "WEAK";
  if (tempSpeed != null && forecastSpeed != null && tempSpeed >= 0.5 && forecastSpeed >= 0.5 && score >= 1) state = "STRONG";
  else if (tempSpeed != null && tempSpeed >= 0.3 && score >= 0) state = "MODERATE";
  return { state, score, tempSpeed, forecastSpeed };
};

export const classifyMode = (ttpMinutes: number | null | undefined): MomentumMode => {
  if (ttpMinutes == null || !Number.isFinite(ttpMinutes)) return "MOMENTUM";
  if (ttpMinutes < 0) return "CERTAINTY";
  if (ttpMinutes <= 30) return "TRANSITION";
  return "MOMENTUM";
};

export type MarketVerdict = "AGREE" | "NEUTRAL" | "WEAK_DISAGREE" | "STRONG_DISAGREE" | "UNKNOWN";

export type DecideActionInput = {
  gap2h: number;
  gap1h: number;
  gapNow: number;
  /** USDC traded in [now-15m, now]. Null/undefined when unknown. */
  volLast?: number | null;
  /** USDC traded in [now-30m, now-15m]. Null/undefined when unknown. */
  volPrev?: number | null;
  /** Minutes until peak weather (preferred) or until close. */
  ttpMinutes?: number | null;
  /** Pre-classified weather state (legacy). Defaults to UNKNOWN (no veto). */
  weatherState?: WeatherState;
  /** New: market-vs-model verdict. When provided, overrides weatherState for veto decisions. */
  marketVerdict?: MarketVerdict;
};

const fmtPct = (n: number, dp = 1) => `${n >= 0 ? "+" : ""}${(n * 100).toFixed(dp)}%`;

export const decideAction = ({
  gap2h, gap1h, gapNow, volLast, volPrev, ttpMinutes, weatherState = "UNKNOWN", marketVerdict,
}: DecideActionInput): ActionDecision => {
  const m1 = gap1h - gap2h;
  const m2 = gapNow - gap1h;
  const acceleration = m2 - m1;
  const widening = gapNow > gap1h;
  const ttp = ttpMinutes ?? Infinity;
  const mode = classifyMode(ttpMinutes);

  const haveVol = volLast != null && volPrev != null && Number.isFinite(volLast) && Number.isFinite(volPrev);
  const volumeChange: number | null = haveVol ? (Number(volLast) - Number(volPrev)) : null;
  const degraded = !haveVol;

  // Verdict-driven (preferred). Falls back to legacy weatherState mapping.
  const verdict: MarketVerdict = marketVerdict
    ?? (weatherState === "STRONG" ? "AGREE"
      : weatherState === "WEAK" ? "STRONG_DISAGREE"
      : weatherState === "MODERATE" ? "NEUTRAL"
      : "UNKNOWN");

  // Priority: shrinking → TRIM, accel<-5% → TRIM, AGREE+widening → ADD,
  // STRONG_DISAGREE → HOLD (hard veto), WEAK_DISAGREE → block ADD only,
  // ENTER on widening near peak (allowed under WEAK_DISAGREE), else HOLD.
  let action: MomentumAction;
  if (!widening) {
    action = "TRIM";
  } else if (acceleration < -0.05 || (volumeChange != null && volumeChange < 0)) {
    action = "TRIM";
  } else if (acceleration > 0 && (volumeChange ?? 0) >= 0 && verdict === "AGREE") {
    action = "ADD";
  } else if (verdict === "STRONG_DISAGREE") {
    action = "HOLD";
  } else if (gapNow > 0.15 && ttp < 120) {
    action = "ENTER";
  } else {
    action = "HOLD";
  }

  // Confidence: blend of |acceleration|, gap size, |vol_change|, ttp proximity
  const accelComp = Math.min(1, Math.abs(acceleration) / 0.10) * 30; // up to 30
  const gapComp = Math.min(1, gapNow / 0.30) * 30;                    // up to 30
  const volComp = volumeChange != null
    ? Math.min(1, Math.abs(volumeChange) / 500) * 25                  // up to 25
    : 5;
  const ttpComp = Number.isFinite(ttp)
    ? Math.max(0, 1 - Math.min(1, ttp / 240)) * 15                    // up to 15 (closer = better)
    : 0;
  let confidence = Math.round(accelComp + gapComp + volComp + ttpComp);
  if (action === "TRIM") confidence = Math.max(confidence, 50);
  confidence = Math.max(0, Math.min(100, confidence));

  // Reason
  const dir = widening ? "widening" : "shrinking";
  const accelStr = `accel ${fmtPct(acceleration)}`;
  const volStr = volumeChange == null
    ? "vol n/a"
    : volumeChange > 0 ? "vol ↑"
    : volumeChange < 0 ? "vol ↓"
    : "vol flat";
  const wxStr = verdict === "UNKNOWN" ? "" : `, mkt ${verdict.toLowerCase()}`;
  const reason = `gap ${dir}, ${accelStr}, ${volStr}${wxStr}`;

  // Surface verdict via the existing weatherState field for back-compat.
  const stateForBackCompat: WeatherState =
    verdict === "AGREE" ? "STRONG"
    : verdict === "STRONG_DISAGREE" ? "WEAK"
    : verdict === "WEAK_DISAGREE" ? "MODERATE"
    : verdict === "NEUTRAL" ? "MODERATE"
    : "UNKNOWN";

  return { action, confidence, reason, acceleration, volumeChange, degraded, mode, weatherState: stateForBackCompat };
};

export const formatVolume = (v: number | null | undefined): string => {
  if (v == null || !Number.isFinite(Number(v))) return "—";
  const n = Number(v);
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}k`;
  return `$${n.toFixed(0)}`;
};
