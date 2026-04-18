// Position-delta mirroring engine.
// For each (user, asset_id) pair:
//   1. Recompute target_shares from cumulative detected_trades (BUY +size, SELL -size).
//   2. desired_mirror = target_shares * config.mirror_ratio
//   3. delta = desired_mirror - current mirror_shares
//   4. If |delta * current_price| >= $1 and within caps, place a marketable
//      FOK order (BUY if delta>0, SELL if delta<0) and update mirror_shares.
//
// Designed to be triggered by pg_cron every N minutes, or manually.
import "npm:tslib@2.6.2";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { ClobClient, Side, OrderType } from "npm:@polymarket/clob-client@4.21.0";
import { Wallet } from "npm:ethers@5.7.2";

const POLY_PROXY_SIG = 1;
const CLOB_HOST = "https://clob.polymarket.com";
const CHAIN_ID = 137;
const MIN_USDC = 1;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const POLY_PRIVATE_KEY = Deno.env.get("POLY_PRIVATE_KEY")!;
const POLY_FUNDER_ADDRESS = Deno.env.get("POLY_FUNDER_ADDRESS")!;

async function fetchMidPrice(assetId: string): Promise<number | null> {
  try {
    const r = await fetch(`${CLOB_HOST}/midpoint?token_id=${assetId}`);
    if (!r.ok) return null;
    const j = await r.json();
    const m = Number(j?.mid ?? j?.midpoint);
    return Number.isFinite(m) && m > 0 ? m : null;
  } catch {
    return null;
  }
}

async function getOrCreateCreds(admin: any, userId: string) {
  const { data: existing } = await admin
    .from("poly_credentials")
    .select("api_key, api_secret, api_passphrase")
    .eq("user_id", userId)
    .maybeSingle();
  if (existing) {
    return { key: existing.api_key, secret: existing.api_secret, passphrase: existing.api_passphrase };
  }
  const signer = new Wallet(POLY_PRIVATE_KEY);
  const bootstrap = new ClobClient(CLOB_HOST, CHAIN_ID, signer);
  const creds = await bootstrap.createOrDeriveApiKey();
  await admin.from("poly_credentials").upsert(
    { user_id: userId, api_key: creds.key, api_secret: creds.secret, api_passphrase: creds.passphrase },
    { onConflict: "user_id" },
  );
  return creds;
}

async function reconcileUser(admin: any, userId: string) {
  const result: any = { user_id: userId, scanned: 0, orders_placed: 0, skipped: [], errors: [] };

  const { data: cfg } = await admin
    .from("config")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();
  if (!cfg) return { ...result, skipped: ["no config"] };
  if (cfg.mirror_mode !== "position") return { ...result, skipped: ["mirror_mode != position"] };
  if (!cfg.target_wallet) return { ...result, skipped: ["no target_wallet"] };

  const ratio = Number(cfg.mirror_ratio ?? 0);
  if (!(ratio > 0)) return { ...result, skipped: ["mirror_ratio <= 0"] };

  // 1. Recompute target_shares per asset from cumulative fills.
  const { data: trades } = await admin
    .from("detected_trades")
    .select("asset_id, side, size, price, market_id, market_question, outcome")
    .eq("user_id", userId);

  const agg = new Map<string, {
    shares: number; lastPrice: number; market_id: any; market_question: any; outcome: any;
  }>();
  for (const t of trades ?? []) {
    const key = String(t.asset_id);
    const sz = Number(t.size ?? 0);
    if (!sz) continue;
    const sign = String(t.side).toUpperCase() === "BUY" ? 1 : -1;
    const cur = agg.get(key) ?? {
      shares: 0, lastPrice: Number(t.price ?? 0),
      market_id: t.market_id, market_question: t.market_question, outcome: t.outcome,
    };
    cur.shares += sign * sz;
    if (t.price) cur.lastPrice = Number(t.price);
    agg.set(key, cur);
  }

  // Daily-cap budget tracking
  const today = new Date().toISOString().slice(0, 10);
  let spent = cfg.spent_day === today ? Number(cfg.usdc_spent_today ?? 0) : 0;
  const dailyCap = Number(cfg.daily_usdc_limit ?? 0);
  const perTradeCap = Number(cfg.max_usdc_per_trade ?? 0);

  let client: ClobClient | null = null;
  const ensureClient = async () => {
    if (client) return client;
    const creds = await getOrCreateCreds(admin, userId);
    const signer = new Wallet(POLY_PRIVATE_KEY);
    client = new ClobClient(CLOB_HOST, CHAIN_ID, signer, creds, POLY_PROXY_SIG, POLY_FUNDER_ADDRESS);
    return client;
  };

  for (const [assetId, info] of agg.entries()) {
    result.scanned++;
    const targetShares = info.shares;
    const desiredMirror = targetShares * ratio;

    const { data: pos } = await admin
      .from("positions")
      .select("mirror_shares")
      .eq("user_id", userId)
      .eq("asset_id", assetId)
      .maybeSingle();
    const currentMirror = Number(pos?.mirror_shares ?? 0);
    const delta = desiredMirror - currentMirror;

    // Refresh price (best estimate of marketable cost)
    const mid = await fetchMidPrice(assetId);
    const price = mid ?? info.lastPrice;
    const usdcDelta = Math.abs(delta) * price;

    // Persist target snapshot regardless of whether we trade
    await admin.from("positions").upsert({
      user_id: userId,
      asset_id: assetId,
      market_id: info.market_id,
      market_question: info.market_question,
      outcome: info.outcome,
      target_shares: targetShares,
      mirror_shares: currentMirror,
      last_target_price: price,
      last_reconciled_at: new Date().toISOString(),
    }, { onConflict: "user_id,asset_id" });

    if (usdcDelta < MIN_USDC) {
      result.skipped.push({ assetId, reason: `delta $${usdcDelta.toFixed(3)} < $1` });
      continue;
    }
    if (!cfg.auto_execute) {
      result.skipped.push({ assetId, reason: "auto_execute off — delta logged only" });
      continue;
    }

    // Cap to per-trade max
    let orderUsdc = Math.min(usdcDelta, perTradeCap);
    if (spent + orderUsdc > dailyCap) {
      orderUsdc = Math.max(0, dailyCap - spent);
    }
    if (orderUsdc < MIN_USDC) {
      result.skipped.push({ assetId, reason: "would breach daily cap" });
      continue;
    }
    const orderSize = orderUsdc / price;
    const side = delta > 0 ? Side.BUY : Side.SELL;

    // SELL needs existing inventory — clamp to what we hold
    if (side === Side.SELL && orderSize > currentMirror) {
      const cappedSize = Math.max(0, currentMirror);
      if (cappedSize * price < MIN_USDC) {
        result.skipped.push({ assetId, reason: "no inventory to sell" });
        continue;
      }
    }

    try {
      const c = await ensureClient();
      const signed = await c.createOrder({
        tokenID: assetId,
        price,
        side,
        size: orderSize,
        feeRateBps: 0,
      });
      const resp: any = await c.postOrder(signed, OrderType.FOK);
      if (!resp?.success) {
        const msg = resp?.errorMsg || JSON.stringify(resp);
        result.errors.push({ assetId, error: msg });
        await admin.from("paper_orders").insert({
          user_id: userId,
          side: side === Side.BUY ? "BUY" : "SELL",
          asset_id: assetId,
          market_id: info.market_id,
          market_question: info.market_question,
          outcome: info.outcome,
          intended_price: price,
          intended_size: orderSize,
          intended_usdc: orderUsdc,
          status: "failed",
          note: "reconcile",
          error: msg,
        });
        continue;
      }

      const txHash = resp.transactionHash ?? resp.transactionsHashes?.[0] ?? null;
      const matched = resp.status === "matched" || !!txHash;
      const filledShares = matched ? orderSize : 0;
      const newMirror = currentMirror + (side === Side.BUY ? filledShares : -filledShares);

      await admin.from("positions").update({
        mirror_shares: newMirror,
        last_reconciled_at: new Date().toISOString(),
      }).eq("user_id", userId).eq("asset_id", assetId);

      await admin.from("paper_orders").insert({
        user_id: userId,
        side: side === Side.BUY ? "BUY" : "SELL",
        asset_id: assetId,
        market_id: info.market_id,
        market_question: info.market_question,
        outcome: info.outcome,
        intended_price: price,
        intended_size: orderSize,
        intended_usdc: orderUsdc,
        status: matched ? "filled" : "submitted",
        executed_tx_hash: txHash,
        executed_at: new Date().toISOString(),
        note: "reconcile",
      });

      spent += orderUsdc;
      result.orders_placed++;
    } catch (e: any) {
      result.errors.push({ assetId, error: String(e?.message ?? e) });
    }
  }

  await admin.from("config").update({
    usdc_spent_today: spent,
    spent_day: today,
  }).eq("user_id", userId);

  return result;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE);
    const body = await req.json().catch(() => ({}));

    let userIds: string[] = [];
    if (body.user_id) {
      userIds = [body.user_id];
    } else {
      // Cron-mode: reconcile every user with mirror_mode = 'position'
      const { data } = await admin
        .from("config")
        .select("user_id")
        .eq("mirror_mode", "position");
      userIds = (data ?? []).map((r: any) => r.user_id);
    }

    const results = [];
    for (const uid of userIds) {
      try {
        results.push(await reconcileUser(admin, uid));
      } catch (e: any) {
        results.push({ user_id: uid, error: String(e?.message ?? e) });
      }
    }

    return new Response(JSON.stringify({ ok: true, results }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("reconcile-positions err", e);
    return new Response(JSON.stringify({ ok: false, error: String((e as any)?.message ?? e) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
