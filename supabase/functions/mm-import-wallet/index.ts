// Import all currently-held markets from a Polymarket wallet into mm_markets.
// Body: { wallet: "0x..." }
// Uses Polymarket Data API positions endpoint to list active token holdings,
// then enriches with Gamma metadata and upserts each into mm_markets.
import "npm:tslib@2.6.2";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const DATA_API = "https://data-api.polymarket.com";
const GAMMA = "https://gamma-api.polymarket.com";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

async function fetchPositions(wallet: string): Promise<any[]> {
  const r = await fetch(`${DATA_API}/positions?user=${wallet}&sizeThreshold=1&limit=500`);
  if (!r.ok) throw new Error(`positions ${r.status}`);
  const arr = await r.json();
  return Array.isArray(arr) ? arr : [];
}

async function fetchMarketByTokenId(tokenId: string): Promise<any | null> {
  const r = await fetch(`${GAMMA}/markets?clob_token_ids=${tokenId}&limit=1`);
  if (!r.ok) return null;
  const arr = await r.json();
  return Array.isArray(arr) && arr.length ? arr[0] : null;
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

    const body = await req.json().catch(() => ({}));
    const wallet = String(body.wallet ?? "").trim().toLowerCase();
    const previewOnly = body.preview === true;
    const selectedTokenIds: string[] | null = Array.isArray(body.token_ids) && body.token_ids.length
      ? body.token_ids.map((x: any) => String(x))
      : null;
    if (!/^0x[a-f0-9]{40}$/.test(wallet)) {
      return new Response(JSON.stringify({ ok: false, error: "Provide a valid wallet address" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const positions = await fetchPositions(wallet);
    // Dedup by token id (filter to selected ones if provided)
    let tokenIds = Array.from(new Set(positions.map((p) => String(p.asset ?? p.token_id ?? "")).filter(Boolean)));
    if (selectedTokenIds) {
      const sel = new Set(selectedTokenIds);
      tokenIds = tokenIds.filter((t) => sel.has(t));
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const minExpiryMs = today.getTime() + 7 * 86400 * 1000;

    let added = 0;
    let skipped = 0;
    const errors: string[] = [];
    const previewItems: any[] = [];

    for (const tokenId of tokenIds) {
      try {
        const market = await fetchMarketByTokenId(tokenId);
        if (!market) { skipped++; continue; }
        // Skip if closed or expiring within 7 days
        const endMs = market.endDate ? Date.parse(market.endDate) : 0;
        if (endMs && endMs < minExpiryMs) { skipped++; continue; }
        if (market.closed === true || market.archived === true) { skipped++; continue; }

        let tokens: any[] = [];
        try { tokens = typeof market.clobTokenIds === "string" ? JSON.parse(market.clobTokenIds) : (market.clobTokenIds ?? []); } catch { tokens = []; }
        let outcomes: any[] = [];
        try { outcomes = typeof market.outcomes === "string" ? JSON.parse(market.outcomes) : (market.outcomes ?? []); } catch { outcomes = []; }
        const idx = tokens.findIndex((t: any) => String(t) === tokenId);
        const outcome = idx >= 0 ? (outcomes[idx] ?? null) : null;
        const endDate = market.endDate ? String(market.endDate).slice(0, 10) : null;

        if (previewOnly) {
          const pos = positions.find((p: any) => String(p.asset ?? p.token_id) === tokenId);
          previewItems.push({
            asset_id: tokenId,
            market_question: market.question ?? null,
            outcome,
            end_date: endDate,
            shares: Number(pos?.size ?? pos?.shares ?? 0),
            current_price: Number(pos?.curPrice ?? pos?.current_price ?? 0),
          });
          continue;
        }

        const row = {
          user_id: user.id,
          asset_id: tokenId,
          condition_id: market.conditionId ?? null,
          market_question: market.question ?? null,
          outcome,
          end_date: endDate,
          active: true,
        };
        const { error } = await admin.from("mm_markets").upsert(row, { onConflict: "user_id,asset_id" });
        if (error) { errors.push(error.message); skipped++; } else { added++; }
      } catch (e) {
        errors.push(String((e as any)?.message ?? e));
        skipped++;
      }
    }

    if (previewOnly) {
      return new Response(JSON.stringify({ ok: true, preview: previewItems }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ ok: true, found: tokenIds.length, added, skipped, errors: errors.slice(0, 5) }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("mm-import-wallet err", e);
    return new Response(JSON.stringify({ ok: false, error: String((e as any)?.message ?? e) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
