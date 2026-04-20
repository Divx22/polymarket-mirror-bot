export type WeatherMarket = {
  id: string;
  city: string;
  latitude: number;
  longitude: number;
  market_question: string;
  condition_type: string;
  condition_range: string;
  temp_min_c: number | null;
  temp_max_c: number | null;
  precip_threshold_mm: number | null;
  event_time: string;
  polymarket_price: number | null;
  polymarket_url: string | null;
  clob_token_id: string | null;
  active: boolean;
  updated_at: string;
};

export type WeatherSignal = {
  id: string;
  market_id: string;
  p_noaa: number | null;
  p_ecmwf: number | null;
  p_final: number;
  agreement: number;
  p_market: number | null;
  edge: number | null;
  suggested_size_percent: number | null;
  confidence_level: "high" | "medium" | "low" | null;
  created_at: string;
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
