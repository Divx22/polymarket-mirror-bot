// Kill switch: cancel ALL the user's open mm orders and disable mm_config.enabled.
import "npm:tslib@2.6.2";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { ClobClient } from "npm:@polymarket/clob-client@4.21.0";
import { Wallet } from "npm:ethers@5.7.2";

const POLY_PROXY_SIG = 1;
const CLOB_HOST = "https://clob.polymarket.com";
const CHAIN_ID = 137;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const POLY_PRIVATE_KEY = Deno.env.get("POLY_PRIVATE_KEY")!;
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
    if (!user) {
      return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    await admin.from("mm_config").update({ enabled: false }).eq("user_id", user.id);

    const { data: orders } = await admin
      .from("mm_open_orders").select("*").eq("user_id", user.id);

    let cancelled = 0;
    if (orders?.length) {
      const { data: creds } = await admin
        .from("poly_credentials")
        .select("api_key, api_secret, api_passphrase")
        .eq("user_id", user.id).maybeSingle();
      if (creds) {
        const signer = new Wallet(POLY_PRIVATE_KEY);
        const c = new ClobClient(
          CLOB_HOST, CHAIN_ID, signer,
          { key: creds.api_key, secret: creds.api_secret, passphrase: creds.api_passphrase },
          POLY_PROXY_SIG, POLY_FUNDER_ADDRESS,
        );
        for (const o of orders) {
          try { await c.cancelOrder({ orderID: o.poly_order_id }); cancelled++; } catch { /* ignore */ }
        }
      }
      await admin.from("mm_open_orders").delete().eq("user_id", user.id);
    }

    return new Response(JSON.stringify({ ok: true, cancelled, disabled: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("mm-kill err", e);
    return new Response(JSON.stringify({ ok: false, error: String((e as any)?.message ?? e) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
