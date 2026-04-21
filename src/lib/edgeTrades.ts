// Edge trade helpers: log opportunities (manual + auto), resolve them later, compute PnL.
// All trades go through the public.edge_trades table.

import { supabase } from "@/integrations/supabase/client";
import type { ProjectionResult } from "./weatherProjection";

export type EdgeTradeStatus = "open" | "won" | "lost" | "void";
export type EdgeTradeSource = "manual" | "auto_edge";

export type EdgeTradeRow = {
  id: string;
  user_id: string;
  market_slug: string | null;
  market_question: string;
  city: string | null;
  event_time: string | null;
  outcome_label: string;
  clob_token_id: string | null;
  bucket_min_c: number | null;
  bucket_max_c: number | null;
  side: string;
  entry_price: number;
  suggested_price: number | null;
  edge_pp: number | null;
  p_model: number | null;
  projected_temp_c: number | null;
  projected_temp_unit: string | null;
  stake_usdc: number;
  status: EdgeTradeStatus;
  actual_temp_c: number | null;
  exit_price: number | null;
  pnl_usdc: number | null;
  resolved_at: string | null;
  source: EdgeTradeSource;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

/** Best-value bucket as a fair (model) price 0..1, derived from the projection. */
export function fairPriceFromProjection(projection: ProjectionResult): {
  fairPrice: number;
  marketPrice: number;
  edgePp: number;
  modelPct: number;
  marketPct: number;
  bucketLabel: string;
} | null {
  if (!projection.bestValueLabel || projection.bestValueEdge == null) return null;
  const row = projection.rows.find((r) => r.label === projection.bestValueLabel);
  if (!row) return null;
  return {
    fairPrice: row.modelPct / 100,
    marketPrice: row.marketPct / 100,
    edgePp: row.edge,
    modelPct: row.modelPct,
    marketPct: row.marketPct,
    bucketLabel: row.label,
  };
}

export type LogEdgeTradeInput = {
  source: EdgeTradeSource;
  market_slug?: string | null;
  market_question: string;
  city?: string | null;
  event_time?: string | null;
  outcome_label: string;
  clob_token_id?: string | null;
  bucket_min_c?: number | null;
  bucket_max_c?: number | null;
  side?: string;
  entry_price: number;       // 0..1
  suggested_price?: number | null; // 0..1 fair price from WX projection
  edge_pp?: number | null;
  p_model?: number | null;   // 0..1
  projected_temp_c?: number | null;
  projected_temp_unit?: "C" | "F";
  stake_usdc?: number;
  notes?: string | null;
};

export async function logEdgeTrade(input: LogEdgeTradeInput): Promise<{ ok: boolean; duplicate?: boolean; error?: string; id?: string }> {
  const { data: u } = await supabase.auth.getUser();
  if (!u?.user) return { ok: false, error: "Not authenticated" };
  const payload = {
    user_id: u.user.id,
    source: input.source,
    market_slug: input.market_slug ?? null,
    market_question: input.market_question,
    city: input.city ?? null,
    event_time: input.event_time ?? null,
    outcome_label: input.outcome_label,
    clob_token_id: input.clob_token_id ?? null,
    bucket_min_c: input.bucket_min_c ?? null,
    bucket_max_c: input.bucket_max_c ?? null,
    side: input.side ?? "YES",
    entry_price: input.entry_price,
    suggested_price: input.suggested_price ?? null,
    edge_pp: input.edge_pp ?? null,
    p_model: input.p_model ?? null,
    projected_temp_c: input.projected_temp_c ?? null,
    projected_temp_unit: input.projected_temp_unit ?? "C",
    stake_usdc: input.stake_usdc ?? 0,
    notes: input.notes ?? null,
  };
  const { data, error } = await supabase.from("edge_trades").insert(payload).select("id").maybeSingle();
  if (error) {
    // Unique violation on auto_edge dedup index → not a real error.
    if (error.code === "23505") return { ok: true, duplicate: true };
    return { ok: false, error: error.message };
  }
  return { ok: true, id: data?.id };
}

/** Compute PnL given outcome (status) and the original entry/stake. */
export function computePnl(row: Pick<EdgeTradeRow, "status" | "entry_price" | "stake_usdc" | "exit_price" | "side">): number | null {
  if (row.status === "open") return null;
  if (row.status === "void") return 0;
  const stake = Number(row.stake_usdc ?? 0);
  if (!Number.isFinite(stake) || stake <= 0) return 0;
  const entry = Number(row.entry_price);
  if (!Number.isFinite(entry) || entry <= 0) return 0;
  const shares = stake / entry;
  // Closed early at exit_price?
  if (row.exit_price != null && Number.isFinite(row.exit_price)) {
    return shares * (Number(row.exit_price) - entry);
  }
  // Settled by event: YES side wins → resolves at 1.0, lost → 0.
  if (row.status === "won") return shares * (1 - entry);
  return shares * (0 - entry); // lost
}

export type ResolveInput = {
  id: string;
  status: EdgeTradeStatus;
  actual_temp_c?: number | null;
  exit_price?: number | null;     // 0..1
  notes?: string | null;
};

export async function resolveEdgeTrade(input: ResolveInput): Promise<{ ok: boolean; error?: string }> {
  // Fetch the row first so we can compute pnl client-side.
  const { data: row, error: fErr } = await supabase
    .from("edge_trades")
    .select("entry_price, stake_usdc, side")
    .eq("id", input.id)
    .maybeSingle();
  if (fErr || !row) return { ok: false, error: fErr?.message ?? "Trade not found" };
  const pnl = computePnl({
    status: input.status,
    entry_price: Number(row.entry_price),
    stake_usdc: Number(row.stake_usdc),
    exit_price: input.exit_price ?? null,
    side: row.side,
  });
  const { error } = await supabase
    .from("edge_trades")
    .update({
      status: input.status,
      actual_temp_c: input.actual_temp_c ?? null,
      exit_price: input.exit_price ?? null,
      pnl_usdc: pnl,
      resolved_at: input.status === "open" ? null : new Date().toISOString(),
      notes: input.notes ?? null,
    })
    .eq("id", input.id);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

export async function deleteEdgeTrade(id: string): Promise<{ ok: boolean; error?: string }> {
  const { error } = await supabase.from("edge_trades").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}
