// Executes a paper_order as a real GTC limit order on Polymarket CLOB.
// Uses the user's Polymarket proxy wallet (signatureType = POLY_PROXY).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { ClobClient, Side, OrderType } from "npm:@polymarket/clob-client@4.21.0";
// Polymarket signature types: EOA=0, POLY_PROXY=1, POLY_GNOSIS_SAFE=2
const POLY_PROXY_SIG = 1;
import { Wallet } from "npm:ethers@5.7.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const POLY_PRIVATE_KEY = Deno.env.get("POLY_PRIVATE_KEY")!;
const POLY_FUNDER_ADDRESS = Deno.env.get("POLY_FUNDER_ADDRESS")!;
const CLOB_HOST = "https://clob.polymarket.com";
const CHAIN_ID = 137;

async function getOrCreateCreds(admin: ReturnType<typeof createClient>, userId: string) {
  const { data: existing } = await admin
    .from("poly_credentials")
    .select("api_key, api_secret, api_passphrase")
    .eq("user_id", userId)
    .maybeSingle();
  if (existing) {
    return {
      key: existing.api_key as string,
      secret: existing.api_secret as string,
      passphrase: existing.api_passphrase as string,
    };
  }
  const signer = new Wallet(POLY_PRIVATE_KEY);
  const bootstrap = new ClobClient(CLOB_HOST, CHAIN_ID, signer);
  const creds = await bootstrap.createOrDeriveApiKey();
  await admin.from("poly_credentials").upsert({
    user_id: userId,
    api_key: creds.key,
    api_secret: creds.secret,
    api_passphrase: creds.passphrase,
  } as any, { onConflict: "user_id" } as any);
  return creds;
}

async function execute(admin: ReturnType<typeof createClient>, userId: string, paperOrderId: string) {
  const { data: order, error: oErr } = await admin
    .from("paper_orders")
    .select("*")
    .eq("id", paperOrderId)
    .eq("user_id", userId)
    .maybeSingle();
  if (oErr || !order) throw new Error("paper order not found");
  if (order.status !== "simulated") throw new Error(`order status is ${order.status}, not simulated`);

  const { data: cfg } = await admin
    .from("config")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();
  if (!cfg) throw new Error("config not found");

  // Reset daily spend if new day
  const today = new Date().toISOString().slice(0, 10);
  let spent = Number(cfg.usdc_spent_today ?? 0);
  if (cfg.spent_day !== today) spent = 0;

  const intendedUsdc = Number(order.intended_usdc ?? 0);
  if (intendedUsdc > Number(cfg.max_usdc_per_trade)) {
    throw new Error(`trade $${intendedUsdc.toFixed(2)} exceeds per-trade cap $${cfg.max_usdc_per_trade}`);
  }
  if (spent + intendedUsdc > Number(cfg.daily_usdc_limit)) {
    throw new Error(`would exceed daily cap ($${spent.toFixed(2)} + $${intendedUsdc.toFixed(2)} > $${cfg.daily_usdc_limit})`);
  }

  const creds = await getOrCreateCreds(admin, userId);
  const signer = new Wallet(POLY_PRIVATE_KEY);
  const client = new ClobClient(
    CLOB_HOST,
    CHAIN_ID,
    signer,
    creds,
    POLY_PROXY_SIG,
    POLY_FUNDER_ADDRESS,
  );

  const side = String(order.side).toUpperCase() === "BUY" ? Side.BUY : Side.SELL;
  const price = Number(order.intended_price);
  const size = Number(order.intended_size);

  const signed = await client.createOrder({
    tokenID: order.asset_id,
    price,
    side,
    size,
    feeRateBps: 0,
  });
  const resp: any = await client.postOrder(signed, OrderType.GTC);

  if (!resp?.success) {
    const msg = resp?.errorMsg || JSON.stringify(resp);
    await admin.from("paper_orders").update({
      status: "failed",
      error: msg,
      executed_at: new Date().toISOString(),
    }).eq("id", paperOrderId);
    throw new Error(msg);
  }

  const txHash = resp.transactionHash ?? resp.transactionsHashes?.[0] ?? null;
  const status = resp.status === "matched" || txHash ? "filled" : "submitted";

  await admin.from("paper_orders").update({
    status,
    executed_tx_hash: txHash,
    executed_at: new Date().toISOString(),
    error: null,
  }).eq("id", paperOrderId);

  await admin.from("config").update({
    usdc_spent_today: spent + intendedUsdc,
    spent_day: today,
  }).eq("user_id", userId);

  return { ok: true, status, txHash, orderId: resp.orderID };
}

async function paperOrderFromDetected(
  admin: ReturnType<typeof createClient>,
  userId: string,
  detectedTradeId: string,
): Promise<string> {
  // Re-use existing simulated paper order if already created
  const { data: existing } = await admin
    .from("paper_orders")
    .select("id, status")
    .eq("user_id", userId)
    .eq("detected_trade_id", detectedTradeId)
    .maybeSingle();
  if (existing) {
    if (existing.status !== "simulated") {
      throw new Error(`already ${existing.status}`);
    }
    return existing.id as string;
  }

  const { data: trade, error } = await admin
    .from("detected_trades")
    .select("*")
    .eq("id", detectedTradeId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error || !trade) throw new Error("detected trade not found");

  const { data: cfg } = await admin
    .from("config")
    .select("max_usdc_per_trade")
    .eq("user_id", userId)
    .maybeSingle();
  const cap = Number(cfg?.max_usdc_per_trade ?? 5);
  const fullUsdc = Number(trade.usdc_size ?? 0);
  const price = Number(trade.price ?? 0);
  if (!price) throw new Error("trade has no price");
  // Scale down to cap if needed
  const intendedUsdc = Math.min(fullUsdc || cap, cap);
  const intendedSize = intendedUsdc / price;

  const { data: inserted, error: iErr } = await admin
    .from("paper_orders")
    .insert({
      user_id: userId,
      detected_trade_id: detectedTradeId,
      side: trade.side,
      asset_id: trade.asset_id,
      market_id: trade.market_id,
      market_question: trade.market_question,
      outcome: trade.outcome,
      intended_price: price,
      intended_size: intendedSize,
      intended_usdc: intendedUsdc,
      status: "simulated",
      note: "manual mirror",
    })
    .select("id")
    .single();
  if (iErr) throw iErr;
  return inserted.id as string;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const body = await req.json().catch(() => ({}));
    let paperOrderId: string | undefined = body.paper_order_id;
    const detectedTradeId: string | undefined = body.detected_trade_id;
    if (!paperOrderId && !detectedTradeId) {
      throw new Error("paper_order_id or detected_trade_id required");
    }

    let userId: string | undefined = body.user_id;
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE);

    // If called from client (has Authorization), derive user from JWT
    const authHeader = req.headers.get("Authorization") ?? "";
    if (authHeader && !userId) {
      const userClient = createClient(SUPABASE_URL, ANON, {
        global: { headers: { Authorization: authHeader } },
      });
      const { data: { user } } = await userClient.auth.getUser();
      if (!user) throw new Error("unauthorized");
      userId = user.id;
    }
    if (!userId) throw new Error("user_id required (or auth token)");

    if (!paperOrderId && detectedTradeId) {
      paperOrderId = await paperOrderFromDetected(admin, userId, detectedTradeId);
    }

    const result = await execute(admin, userId, paperOrderId!);
    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("execute-order err", e);
    return new Response(JSON.stringify({ ok: false, error: String((e as any)?.message ?? e) }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
