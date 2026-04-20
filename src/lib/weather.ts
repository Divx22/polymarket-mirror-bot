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

export const formatVolume = (v: number | null | undefined): string => {
  if (v == null || !Number.isFinite(Number(v))) return "—";
  const n = Number(v);
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}k`;
  return `$${n.toFixed(0)}`;
};
