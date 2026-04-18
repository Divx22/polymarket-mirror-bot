// Returns the target wallet's full open positions from Polymarket Data API,
// sorted by current USDC value descending. Used by the Target Portfolio panel.
import "npm:tslib@2.6.2";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const DATA_API = "https://data-api.polymarket.com";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

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
    if (!user) {
      return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: cfg } = await admin
      .from("config").select("target_wallet").eq("user_id", user.id).maybeSingle();
    const wallet = cfg?.target_wallet;
    if (!wallet) {
      return new Response(JSON.stringify({ ok: true, wallet: null, positions: [] }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const url = `${DATA_API}/positions?user=${wallet.toLowerCase()}&sizeThreshold=0.01&limit=500`;
    const r = await fetch(url);
    if (!r.ok) {
      return new Response(JSON.stringify({ ok: false, error: `polymarket ${r.status}` }), {
        status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const raw = await r.json();
    const positions = (Array.isArray(raw) ? raw : []).map((p: any) => ({
      asset: String(p.asset),
      conditionId: p.conditionId,
      title: p.title,
      outcome: p.outcome,
      size: Number(p.size ?? 0),
      avgPrice: Number(p.avgPrice ?? 0),
      curPrice: Number(p.curPrice ?? 0),
      currentValue: Number(p.currentValue ?? 0),
      cashPnl: Number(p.cashPnl ?? 0),
      percentPnl: Number(p.percentPnl ?? 0),
      initialValue: Number(p.initialValue ?? 0),
      redeemable: !!p.redeemable,
      endDate: p.endDate ?? null,
      icon: p.icon ?? null,
    })).sort((a: any, b: any) => b.currentValue - a.currentValue);

    return new Response(JSON.stringify({ ok: true, wallet, positions }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("target-portfolio err", e);
    return new Response(JSON.stringify({ ok: false, error: String((e as any)?.message ?? e) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
