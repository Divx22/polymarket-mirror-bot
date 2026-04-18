// Backfill order_id, original size & partial-fill flag for existing detected_trades
// by querying the Polymarket Data API.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

async function fetchOrderMeta(orderId: string, fallbackPrice: number) {
  try {
    const r = await fetch(`https://data-api.polymarket.com/order/${orderId}`);
    if (!r.ok) return null;
    const j = await r.json();
    const size = Number(j.size ?? j.original_size ?? 0);
    const price = Number(j.price ?? fallbackPrice);
    if (!Number.isFinite(size) || size <= 0) return null;
    return { size, usdc: size * price };
  } catch {
    return null;
  }
}

async function fetchPolyTradesByTx(wallet: string) {
  const map = new Map<string, any[]>();
  try {
    const r = await fetch(
      `https://data-api.polymarket.com/trades?user=${wallet}&limit=500`,
    );
    if (!r.ok) return map;
    const arr = await r.json();
    if (!Array.isArray(arr)) return map;
    for (const t of arr) {
      const tx = String(t.transactionHash ?? t.transaction_hash ?? "").toLowerCase();
      if (!tx) continue;
      if (!map.has(tx)) map.set(tx, []);
      map.get(tx)!.push(t);
    }
  } catch (e) {
    console.error("fetchPolyTradesByTx err", e);
  }
  return map;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE);

  // Auth: require a logged-in user; backfill only their rows
  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.replace("Bearer ", "");
  const { data: userData } = await admin.auth.getUser(token);
  const user = userData?.user;
  if (!user) {
    return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const { data: cfg } = await admin
      .from("config")
      .select("target_wallet")
      .eq("user_id", user.id)
      .maybeSingle();
    const wallet = cfg?.target_wallet?.toLowerCase();
    if (!wallet) {
      return new Response(JSON.stringify({ ok: true, updated: 0, note: "no wallet set" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: rows } = await admin
      .from("detected_trades")
      .select("id, tx_hash, asset_id, side, price, size")
      .eq("user_id", user.id)
      .is("order_id", null);

    const polyByTx = await fetchPolyTradesByTx(wallet);
    let updated = 0;

    for (const r of rows ?? []) {
      const candidates = polyByTx.get(String(r.tx_hash).toLowerCase()) ?? [];
      const match = candidates.find(
        (c: any) =>
          String(c.asset ?? c.token_id ?? c.tokenId ?? "") === String(r.asset_id) &&
          String(c.side ?? "").toUpperCase() === String(r.side).toUpperCase(),
      ) ?? candidates[0] ?? null;
      const orderId: string | null =
        match?.order_id ?? match?.orderId ?? match?.orderHash ?? null;
      if (!orderId) continue;

      const meta = await fetchOrderMeta(orderId, Number(r.price ?? 0));
      const isPartial = meta ? meta.size > Number(r.size ?? 0) + 1e-6 : null;

      await admin
        .from("detected_trades")
        .update({
          order_id: orderId,
          order_original_size: meta?.size ?? null,
          order_original_usdc: meta?.usdc ?? null,
          is_partial_fill: isPartial,
        })
        .eq("id", r.id);
      updated++;
    }

    return new Response(JSON.stringify({ ok: true, updated, scanned: rows?.length ?? 0 }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error(e);
    return new Response(JSON.stringify({ ok: false, error: String(e) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
