// Returns Polymarket markets ranked as good market-making candidates.
// Heuristic: pick markets with non-trivial bid/ask spread AND active volume,
// AND >= min_days_to_expiry days remaining. Skip already-added markets.
import "npm:tslib@2.6.2";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GAMMA = "https://gamma-api.polymarket.com";
const CLOB = "https://clob.polymarket.com";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

async function getBestBidAsk(tokenId: string) {
  try {
    const r = await fetch(`${CLOB}/book?token_id=${tokenId}`);
    if (!r.ok) return null;
    const j = await r.json();
    const bids = (j.bids ?? []).map((b: any) => Number(b.price)).filter((n: number) => n > 0);
    const asks = (j.asks ?? []).map((a: any) => Number(a.price)).filter((n: number) => n > 0);
    const bestBid = bids.length ? Math.max(...bids) : null;
    const bestAsk = asks.length ? Math.min(...asks) : null;
    if (bestBid == null || bestAsk == null) return null;
    return { bestBid, bestAsk, spread: bestAsk - bestBid };
  } catch {
    return null;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const jwt = authHeader.replace("Bearer ", "");
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE);
    const { data: userData } = await admin.auth.getUser(jwt);
    const user = userData?.user;
    if (!user) {
      return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: cfg } = await admin
      .from("mm_config").select("min_days_to_expiry").eq("user_id", user.id).maybeSingle();
    const minDays = cfg?.min_days_to_expiry ?? 7;

    const { data: existing } = await admin
      .from("mm_markets").select("asset_id").eq("user_id", user.id);
    const existingSet = new Set((existing ?? []).map((r: any) => String(r.asset_id)));

    // Pull a wider net: many longshot multi-outcome markets live in lower-volume tiers
    const url = `${GAMMA}/markets?active=true&closed=false&order=volume24hr&ascending=false&limit=200`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`gamma ${r.status}`);
    const markets = await r.json();

    // Require at least 21 days to expiry — Alex's pattern is long-tail
    const minMs = Math.max(minDays, 21) * 86400000;
    const minEnd = new Date(Date.now() + minMs);
    const candidates: any[] = [];

    for (const m of markets) {
      if (candidates.length >= 60) break;
      const endDate = m.endDate ? new Date(m.endDate) : null;
      if (!endDate || endDate < minEnd) continue;
      let tokens: any[] = [];
      try { tokens = typeof m.clobTokenIds === "string" ? JSON.parse(m.clobTokenIds) : (m.clobTokenIds ?? []); } catch { continue; }
      let outcomes: any[] = [];
      try { outcomes = typeof m.outcomes === "string" ? JSON.parse(m.outcomes) : (m.outcomes ?? []); } catch { outcomes = []; }
      if (!tokens.length) continue;

      const daysLeft = Math.max(1, Math.round((endDate.getTime() - Date.now()) / 86400000));

      // Iterate EVERY outcome (not just tokens[0]) — for multi-outcome races (F1, Seoul mayor,
      // Eurovision, French election) each driver/candidate is a separate longshot to quote.
      for (let i = 0; i < tokens.length; i++) {
        if (candidates.length >= 60) break;
        const tokenId = String(tokens[i]);
        if (existingSet.has(tokenId)) continue;
        const book = await getBestBidAsk(tokenId);
        if (!book) continue;

        // Sub-cent longshot pattern (tripping's playbook):
        // bid 0.002–0.10, spread ≥ 1 tick (0.001), skip favorites
        if (book.bestBid < 0.002 || book.bestBid > 0.10) continue;
        if (book.bestAsk > 0.20) continue;
        if (book.spread < 0.001) continue;

        candidates.push({
          asset_id: tokenId,
          condition_id: m.conditionId,
          market_question: m.question,
          outcome: outcomes[i] ?? `Outcome ${i+1}`,
          end_date: m.endDate?.slice(0, 10) ?? null,
          volume_24h: Number(m.volume24hr ?? 0),
          best_bid: book.bestBid,
          best_ask: book.bestAsk,
          spread: book.spread,
          spread_pct: book.spread / Math.max(0.005, (book.bestBid + book.bestAsk) / 2),
          days_left: daysLeft,
          icon: m.icon ?? null,
        });
      }
    }

    // Score: spread% × √days_left × log(1 + volume)
    // Rewards wide relative spread, long time decay window, and at least some flow
    candidates.sort((a, b) => {
      const sa = a.spread_pct * Math.sqrt(a.days_left) * Math.log(2 + a.volume_24h);
      const sb = b.spread_pct * Math.sqrt(b.days_left) * Math.log(2 + b.volume_24h);
      return sb - sa;
    });

    return new Response(JSON.stringify({ ok: true, candidates: candidates.slice(0, 20) }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("mm-candidates err", e);
    return new Response(JSON.stringify({ ok: false, error: String((e as any)?.message ?? e) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
