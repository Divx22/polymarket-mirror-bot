import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const CLOB = "https://clob.polymarket.com";

type Order = {
  asset_id: string;
  side: string;
  intended_size: number | null;
  intended_price: number | null;
  intended_usdc: number | null;
  executed_at: string | null;
  created_at: string;
  status: string;
  market_question: string | null;
  outcome: string | null;
};

async function getMid(tokenId: string): Promise<number | null> {
  try {
    const r = await fetch(`${CLOB}/midpoint?token_id=${tokenId}`);
    if (!r.ok) return null;
    const j = await r.json();
    const m = Number(j?.mid);
    return Number.isFinite(m) ? m : null;
  } catch {
    return null;
  }
}

function bucketKey(iso: string, kind: "day" | "week" | "month"): string {
  const d = new Date(iso);
  if (kind === "day") return d.toISOString().slice(0, 10);
  if (kind === "month")
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  // week (ISO-ish): year-Www starting Monday UTC
  const tmp = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = (tmp.getUTCDay() + 6) % 7;
  tmp.setUTCDate(tmp.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 4));
  const week =
    1 +
    Math.round(
      ((tmp.getTime() - firstThursday.getTime()) / 86400000 -
        3 +
        ((firstThursday.getUTCDay() + 6) % 7)) /
        7,
    );
  return `${tmp.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const auth = req.headers.get("Authorization") ?? "";
    const supa = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: auth } } },
    );
    const { data: u } = await supa.auth.getUser();
    if (!u?.user) {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: orders, error } = await supa
      .from("paper_orders")
      .select(
        "asset_id,side,intended_size,intended_price,intended_usdc,executed_at,created_at,status,market_question,outcome",
      )
      .eq("user_id", u.user.id)
      .in("status", ["submitted", "filled"])
      .order("executed_at", { ascending: true });

    if (error) throw error;

    const fills = (orders ?? []) as Order[];

    // Per-asset running position with weighted avg cost; realized P&L on sells
    const positions = new Map<
      string,
      {
        shares: number;
        avgCost: number;
        realized: number;
        market_question: string | null;
        outcome: string | null;
      }
    >();
    const realizedEvents: { ts: string; pnl: number }[] = [];

    for (const o of fills) {
      const size = Number(o.intended_size ?? 0);
      const price = Number(o.intended_price ?? 0);
      if (!size || !price) continue;
      const key = o.asset_id;
      const p =
        positions.get(key) ??
        {
          shares: 0,
          avgCost: 0,
          realized: 0,
          market_question: o.market_question,
          outcome: o.outcome,
        };
      if (o.side?.toUpperCase() === "BUY") {
        const newShares = p.shares + size;
        p.avgCost = newShares > 0 ? (p.avgCost * p.shares + price * size) / newShares : 0;
        p.shares = newShares;
      } else {
        const sellSize = Math.min(size, p.shares); // ignore short for now
        const pnl = (price - p.avgCost) * sellSize;
        p.realized += pnl;
        p.shares -= sellSize;
        if (p.shares <= 0) p.avgCost = 0;
        realizedEvents.push({ ts: o.executed_at ?? o.created_at, pnl });
      }
      positions.set(key, p);
    }

    // Unrealized for open positions
    const openPositions: any[] = [];
    let unrealizedTotal = 0;
    for (const [asset_id, p] of positions.entries()) {
      if (p.shares <= 1e-9) continue;
      const mid = await getMid(asset_id);
      const unrealized = mid != null ? (mid - p.avgCost) * p.shares : null;
      if (unrealized != null) unrealizedTotal += unrealized;
      openPositions.push({
        asset_id,
        market_question: p.market_question,
        outcome: p.outcome,
        shares: p.shares,
        avg_cost: p.avgCost,
        current_price: mid,
        unrealized,
      });
    }

    // Bucket realized
    const bucket = (kind: "day" | "week" | "month") => {
      const m = new Map<string, { period: string; realized: number; trades: number }>();
      for (const e of realizedEvents) {
        const k = bucketKey(e.ts, kind);
        const cur = m.get(k) ?? { period: k, realized: 0, trades: 0 };
        cur.realized += e.pnl;
        cur.trades += 1;
        m.set(k, cur);
      }
      return Array.from(m.values()).sort((a, b) => (a.period < b.period ? 1 : -1));
    };

    const realizedTotal = realizedEvents.reduce((s, e) => s + e.pnl, 0);

    return new Response(
      JSON.stringify({
        realized_total: realizedTotal,
        unrealized_total: unrealizedTotal,
        net_total: realizedTotal + unrealizedTotal,
        daily: bucket("day"),
        weekly: bucket("week"),
        monthly: bucket("month"),
        positions: openPositions,
        fills_count: fills.length,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e?.message ?? e) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
