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

    // Pull ~80 active markets sorted by volume descending
    const url = `${GAMMA}/markets?active=true&closed=false&order=volume24hr&ascending=false&limit=80`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`gamma ${r.status}`);
    const markets = await r.json();

    const minEnd = new Date(Date.now() + minDays * 86400000);
    // Exclude obviously news-driven / event-shock topics
    const NEWS_REGEX = /\b(war|peace|ceasefire|invasion|attack|nuclear|missile|coup|regime|alien|ufo|impeach|assassin|hostage|fed|rate cut|cpi|inflation|election|primary|debate|trump|biden|putin|xi|israel|iran|gaza|ukraine|russia|china|hamas|taiwan)\b/i;
    const candidates: any[] = [];

    for (const m of markets) {
      if (candidates.length >= 25) break;
      const endDate = m.endDate ? new Date(m.endDate) : null;
      if (!endDate || endDate < minEnd) continue;
      const q: string = String(m.question ?? "");
      if (NEWS_REGEX.test(q)) continue;
      let tokens: any[] = [];
      try { tokens = typeof m.clobTokenIds === "string" ? JSON.parse(m.clobTokenIds) : (m.clobTokenIds ?? []); } catch { continue; }
      let outcomes: any[] = [];
      try { outcomes = typeof m.outcomes === "string" ? JSON.parse(m.outcomes) : (m.outcomes ?? []); } catch { outcomes = []; }
      if (!tokens.length) continue;

      // Use first outcome (Yes side) for candidate scoring
      const tokenId = String(tokens[0]);
      if (existingSet.has(tokenId)) continue;
      const book = await getBestBidAsk(tokenId);
      if (!book) continue;
      // Stricter: mid-priced (0.20–0.80) and spread >= 2 cents
      const mid = (book.bestBid + book.bestAsk) / 2;
      if (mid < 0.20 || mid > 0.80) continue;
      if (book.spread < 0.02) continue;
      if (book.bestBid <= 0 || book.bestAsk >= 1) continue;

      candidates.push({
        asset_id: tokenId,
        condition_id: m.conditionId,
        market_question: m.question,
        outcome: outcomes[0] ?? "Yes",
        end_date: m.endDate?.slice(0, 10) ?? null,
        volume_24h: Number(m.volume24hr ?? 0),
        best_bid: book.bestBid,
        best_ask: book.bestAsk,
        spread: book.spread,
        spread_pct: book.spread / mid,
        icon: m.icon ?? null,
      });
    }

    // Score: spread × log(volume) — reward both wide spread and active flow
    candidates.sort((a, b) => {
      const sa = a.spread * Math.log(1 + a.volume_24h);
      const sb = b.spread * Math.log(1 + b.volume_24h);
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
