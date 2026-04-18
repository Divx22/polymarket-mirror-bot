// Add a market to the user's mm_markets list.
// Accepts either:
//   - { asset_id: "<token id>" }
//   - { url: "https://polymarket.com/event/<slug>" or /market/<slug> }
//   - { slug: "<slug>" }
// Resolves to canonical token id + metadata via the Gamma API and inserts.
import "npm:tslib@2.6.2";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GAMMA = "https://gamma-api.polymarket.com";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function extractSlug(url: string): string | null {
  try {
    const u = new URL(url);
    const parts = u.pathname.split("/").filter(Boolean);
    // /event/<slug> or /market/<slug>
    if (parts.length >= 2 && (parts[0] === "event" || parts[0] === "market")) return parts[1];
    return parts[parts.length - 1] ?? null;
  } catch {
    return null;
  }
}

async function fetchMarketBySlug(slug: string): Promise<any | null> {
  const r = await fetch(`${GAMMA}/markets?slug=${encodeURIComponent(slug)}&limit=1`);
  if (!r.ok) return null;
  const arr = await r.json();
  if (Array.isArray(arr) && arr.length) return arr[0];
  // Try events endpoint for multi-market events
  const r2 = await fetch(`${GAMMA}/events?slug=${encodeURIComponent(slug)}&limit=1`);
  if (r2.ok) {
    const ev = await r2.json();
    const m = ev?.[0]?.markets?.[0];
    if (m) return m;
  }
  return null;
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
    let market: any | null = null;
    let chosenTokenId: string | null = null;
    let chosenOutcome: string | null = null;

    if (body.asset_id) {
      market = await fetchMarketByTokenId(String(body.asset_id));
      chosenTokenId = String(body.asset_id);
    } else {
      const slug = body.slug ?? (body.url ? extractSlug(String(body.url)) : null);
      if (!slug) {
        return new Response(JSON.stringify({ ok: false, error: "Provide url, slug, or asset_id" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      market = await fetchMarketBySlug(slug);
    }

    if (!market) {
      return new Response(JSON.stringify({ ok: false, error: "Market not found on Polymarket" }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let tokens: any[] = [];
    try { tokens = typeof market.clobTokenIds === "string" ? JSON.parse(market.clobTokenIds) : (market.clobTokenIds ?? []); } catch { tokens = []; }
    let outcomes: any[] = [];
    try { outcomes = typeof market.outcomes === "string" ? JSON.parse(market.outcomes) : (market.outcomes ?? []); } catch { outcomes = []; }

    if (!chosenTokenId) {
      // default to first outcome (Yes)
      chosenTokenId = String(tokens[0] ?? "");
      chosenOutcome = outcomes[0] ?? "Yes";
    } else {
      const idx = tokens.findIndex((t: any) => String(t) === chosenTokenId);
      chosenOutcome = idx >= 0 ? (outcomes[idx] ?? null) : null;
    }
    if (!chosenTokenId) {
      return new Response(JSON.stringify({ ok: false, error: "Market has no token id" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const row = {
      user_id: user.id,
      asset_id: chosenTokenId,
      condition_id: market.conditionId ?? null,
      market_question: market.question ?? null,
      outcome: chosenOutcome,
      end_date: market.endDate ? String(market.endDate).slice(0, 10) : null,
      active: true,
    };

    const { error } = await admin
      .from("mm_markets")
      .upsert(row, { onConflict: "user_id,asset_id" });

    if (error) throw error;

    return new Response(JSON.stringify({ ok: true, market: row }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("mm-add-market err", e);
    return new Response(JSON.stringify({ ok: false, error: String((e as any)?.message ?? e) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
