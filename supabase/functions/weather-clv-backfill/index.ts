// Computes CLV (closing-line value) for past weather trades.
// For each detected_trade whose asset_id matches a weather_outcomes.clob_token_id
// AND whose market's event_time has passed AND that isn't yet scored:
//   1. Fetch Polymarket price history for that token
//   2. Pick the last price <= event_time as the "closing line"
//   3. CLV (cents, in YES terms): (entry - close) for SELL, (close - entry) for BUY
//      Positive = your fill beat where the market closed = real edge.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

type DetectedTrade = {
  id: string;
  user_id: string;
  asset_id: string;
  side: string;
  price: number | null;
  size: number | null;
  trade_ts: number;
};

type WeatherOutcomeRow = {
  id: string;
  market_id: string;
  clob_token_id: string | null;
  weather_markets: { id: string; event_time: string } | null;
};

async function fetchClosingPrice(
  clobTokenId: string,
  eventTime: Date,
): Promise<{ price: number | null; sample_count: number; raw_url: string }> {
  // Polymarket exposes a prices-history endpoint. We grab a wide window
  // around event_time and pick the last sample at or before it.
  const start = Math.floor(eventTime.getTime() / 1000) - 6 * 3600;
  const end = Math.floor(eventTime.getTime() / 1000) + 1 * 3600;
  const url = `https://clob.polymarket.com/prices-history?market=${clobTokenId}&startTs=${start}&endTs=${end}&fidelity=1`;
  try {
    const r = await fetch(url);
    if (!r.ok) return { price: null, sample_count: 0, raw_url: url };
    const j = await r.json();
    const history: Array<{ t: number; p: number }> = Array.isArray(j?.history)
      ? j.history
      : [];
    if (history.length === 0) return { price: null, sample_count: 0, raw_url: url };
    const cutoff = Math.floor(eventTime.getTime() / 1000);
    let best: { t: number; p: number } | null = null;
    for (const h of history) {
      if (h.t <= cutoff && (best == null || h.t > best.t)) best = h;
    }
    // If nothing before event_time, fall back to earliest sample we have.
    if (!best) best = history[0];
    return {
      price: Number(best.p),
      sample_count: history.length,
      raw_url: url,
    };
  } catch {
    return { price: null, sample_count: 0, raw_url: url };
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      {
        global: {
          headers: { Authorization: req.headers.get("Authorization") ?? "" },
        },
      },
    );

    const { data: userData, error: userErr } = await supabase.auth.getUser();
    if (userErr || !userData.user) {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const userId = userData.user.id;

    // 1. Pull weather outcomes (with their parent market's event_time) that have already resolved.
    const nowIso = new Date().toISOString();
    const { data: outcomes, error: oErr } = await supabase
      .from("weather_outcomes")
      .select("id, market_id, clob_token_id, weather_markets!inner(id, event_time)")
      .not("clob_token_id", "is", null)
      .lt("weather_markets.event_time", nowIso)
      .returns<WeatherOutcomeRow[]>();
    if (oErr) throw oErr;

    const byAsset = new Map<string, WeatherOutcomeRow>();
    for (const o of outcomes ?? []) {
      if (o.clob_token_id) byAsset.set(o.clob_token_id, o);
    }
    if (byAsset.size === 0) {
      return new Response(
        JSON.stringify({ scored: 0, skipped: 0, reason: "no resolved markets yet" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // 2. Pull this user's detected trades for those assets, that aren't already scored.
    const assetIds = Array.from(byAsset.keys());
    const { data: trades, error: tErr } = await supabase
      .from("detected_trades")
      .select("id, user_id, asset_id, side, price, size, trade_ts")
      .eq("user_id", userId)
      .in("asset_id", assetIds)
      .returns<DetectedTrade[]>();
    if (tErr) throw tErr;

    const { data: alreadyScored } = await supabase
      .from("clv_scores")
      .select("detected_trade_id")
      .eq("user_id", userId);
    const scoredSet = new Set((alreadyScored ?? []).map((r) => r.detected_trade_id));

    const todo = (trades ?? []).filter(
      (t) => !scoredSet.has(t.id) && t.price != null,
    );

    let scored = 0;
    let skipped = 0;
    let paperScored = 0;
    const errors: Array<{ trade_id: string; reason: string }> = [];

    // Group by asset so we only hit Polymarket once per market.
    const byAssetTodo = new Map<string, DetectedTrade[]>();
    for (const t of todo) {
      const arr = byAssetTodo.get(t.asset_id) ?? [];
      arr.push(t);
      byAssetTodo.set(t.asset_id, arr);
    }

    // Cache closing prices we fetch so paper-row scoring can reuse them.
    const closingByAsset = new Map<string, number>();

    for (const [assetId, group] of byAssetTodo.entries()) {
      const outcome = byAsset.get(assetId);
      if (!outcome?.weather_markets?.event_time) {
        skipped += group.length;
        continue;
      }
      const eventTime = new Date(outcome.weather_markets.event_time);
      const { price: closing, sample_count, raw_url } = await fetchClosingPrice(
        assetId,
        eventTime,
      );
      if (closing == null) {
        skipped += group.length;
        errors.push({ trade_id: group[0].id, reason: "no price history" });
        continue;
      }
      closingByAsset.set(assetId, closing);

      const rows = group.map((t) => {
        const entry = Number(t.price);
        const dir = t.side?.toUpperCase() === "SELL" ? -1 : 1;
        const clvCents = (closing - entry) * dir * 100;
        return {
          user_id: userId,
          detected_trade_id: t.id,
          weather_market_id: outcome.market_id,
          weather_outcome_id: outcome.id,
          asset_id: assetId,
          side: t.side,
          entry_price: entry,
          closing_price: closing,
          clv_cents: Number(clvCents.toFixed(2)),
          shares: t.size,
          event_time: outcome.weather_markets.event_time,
          source: "polymarket_history",
          notes: { sample_count, raw_url },
        };
      });

      const { error: insErr } = await supabase
        .from("clv_scores")
        .insert(rows);
      if (insErr) {
        skipped += rows.length;
        errors.push({ trade_id: group[0].id, reason: insErr.message });
        continue;
      }
      scored += rows.length;
    }

    // ---- Score unscored PAPER rows whose event has passed ----
    const { data: paperRows } = await supabase
      .from("clv_scores")
      .select("id, asset_id, entry_price, side, weather_outcome_id, event_time")
      .eq("user_id", userId)
      .is("detected_trade_id", null)
      .is("closing_price", null)
      .lt("event_time", nowIso);
    for (const r of paperRows ?? []) {
      let closing = closingByAsset.get(r.asset_id);
      if (closing == null) {
        const eventTime = new Date(r.event_time as string);
        const { price } = await fetchClosingPrice(r.asset_id, eventTime);
        if (price == null) { skipped += 1; continue; }
        closing = price;
        closingByAsset.set(r.asset_id, closing);
      }
      const entry = Number(r.entry_price);
      const dir = r.side?.toUpperCase() === "SELL" ? -1 : 1;
      const clvCents = (closing - entry) * dir * 100;
      const { error: upErr } = await supabase
        .from("clv_scores")
        .update({
          closing_price: closing,
          clv_cents: Number(clvCents.toFixed(2)),
        })
        .eq("id", r.id);
      if (upErr) { skipped += 1; continue; }
      paperScored += 1;
    }

    return new Response(
      JSON.stringify({ scored, paper_scored: paperScored, skipped, todo_total: todo.length, errors }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : String(e) }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});
