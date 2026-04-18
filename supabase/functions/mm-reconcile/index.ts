// One-shot: compare mm_markets.inventory_shares vs actual Polymarket holdings.
import "npm:tslib@2.6.2";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const POLY_FUNDER_ADDRESS = Deno.env.get("POLY_FUNDER_ADDRESS")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const jwt = authHeader.replace("Bearer ", "");
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE);
    const { data: userData } = await admin.auth.getUser(jwt);
    const user = userData?.user;
    if (!user) return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });

    // Fetch real holdings from Polymarket
    const r = await fetch(`https://data-api.polymarket.com/positions?user=${POLY_FUNDER_ADDRESS}&limit=500`);
    const polyPositions: any[] = await r.json();
    const polyByAsset = new Map<string, any>();
    for (const p of polyPositions) polyByAsset.set(String(p.asset), p);

    // Fetch DB inventory
    const { data: mm } = await admin
      .from("mm_markets").select("asset_id, market_question, outcome, inventory_shares, inventory_avg_price")
      .eq("user_id", user.id);

    const comparison = (mm ?? []).map((row: any) => {
      const poly = polyByAsset.get(String(row.asset_id));
      const polyShares = poly?.size ?? 0;
      const polyAvg = poly?.avgPrice ?? 0;
      const dbShares = Number(row.inventory_shares);
      const diff = polyShares - dbShares;
      return {
        market: row.market_question,
        outcome: row.outcome,
        db_shares: dbShares,
        poly_shares: polyShares,
        diff,
        in_sync: Math.abs(diff) < 1,
        db_avg: Number(row.inventory_avg_price),
        poly_avg: polyAvg,
      };
    });

    const out_of_sync = comparison.filter((c: any) => !c.in_sync);
    return new Response(JSON.stringify({
      ok: true,
      funder: POLY_FUNDER_ADDRESS,
      total_db_markets: comparison.length,
      total_out_of_sync: out_of_sync.length,
      comparison,
    }, null, 2), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String((e as any)?.message ?? e) }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
