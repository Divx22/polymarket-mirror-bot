// Market-maker bot cycle.
// Per active mm_markets row for the user:
//   1. Fetch the order book (best bid / best ask).
//   2. Compute target bid = best_bid + 1 tick (capped < mid).
//      Compute target ask = best_ask - 1 tick (capped > mid).
//      Skip if existing spread is too tight (< min_existing_spread_ticks).
//   3. Cancel any of our open orders on this asset that aren't at the target prices.
//   4. Detect fills: compare prior open orders vs current open orders → infer
//      filled shares, update inventory + spread_captured_usdc.
//   5. Post fresh BUY @ target_bid (if inventory < cap) and SELL @ target_ask
//      (if inventory > 0). Order type GTC so they sit on the book.
//   6. Persist totals; respect global capital cap.
//
// Designed to be run by pg_cron every 30 seconds.
import "npm:tslib@2.6.2";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { ClobClient, Side, OrderType } from "npm:@polymarket/clob-client@4.21.0";
import { Wallet } from "npm:ethers@5.7.2";

const POLY_PROXY_SIG = 1;
const CLOB_HOST = "https://clob.polymarket.com";
const CHAIN_ID = 137;
const TICK = 0.001; // Polymarket tick size for cheap markets

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const POLY_PRIVATE_KEY = Deno.env.get("POLY_PRIVATE_KEY")!;
const POLY_FUNDER_ADDRESS = Deno.env.get("POLY_FUNDER_ADDRESS")!;

async function getBook(assetId: string) {
  const r = await fetch(`${CLOB_HOST}/book?token_id=${assetId}`);
  if (!r.ok) return null;
  const j = await r.json();
  const bids = (j.bids ?? []).map((b: any) => Number(b.price)).filter((n: number) => n > 0);
  const asks = (j.asks ?? []).map((a: any) => Number(a.price)).filter((n: number) => n > 0);
  if (!bids.length || !asks.length) return null;
  return { bestBid: Math.max(...bids), bestAsk: Math.min(...asks) };
}

async function getOrCreateCreds(admin: any, userId: string) {
  const { data: existing } = await admin
    .from("poly_credentials")
    .select("api_key, api_secret, api_passphrase")
    .eq("user_id", userId)
    .maybeSingle();
  if (existing) return { key: existing.api_key, secret: existing.api_secret, passphrase: existing.api_passphrase };
  const signer = new Wallet(POLY_PRIVATE_KEY);
  const bootstrap = new ClobClient(CLOB_HOST, CHAIN_ID, signer);
  const creds = await bootstrap.createOrDeriveApiKey();
  await admin.from("poly_credentials").upsert(
    { user_id: userId, api_key: creds.key, api_secret: creds.secret, api_passphrase: creds.passphrase },
    { onConflict: "user_id" },
  );
  return creds;
}

function roundTick(p: number) {
  return Math.round(p / TICK) * TICK;
}

async function runForUser(admin: any, userId: string) {
  const log: any = {
    user_id: userId, markets_processed: 0, orders_placed: 0, orders_cancelled: 0,
    fills_detected: 0, total_capital_at_risk_usdc: 0, notes: { skipped: [], errors: [] },
  };

  const { data: cfg } = await admin
    .from("mm_config").select("*").eq("user_id", userId).maybeSingle();
  if (!cfg || !cfg.enabled) {
    log.notes.skipped.push("mm disabled");
    return log;
  }

  const { data: markets } = await admin
    .from("mm_markets").select("*").eq("user_id", userId).eq("active", true);
  if (!markets?.length) {
    log.notes.skipped.push("no active markets");
    return log;
  }

  const { data: openOrders } = await admin
    .from("mm_open_orders").select("*").eq("user_id", userId);
  const openByAsset = new Map<string, any[]>();
  for (const o of openOrders ?? []) {
    const arr = openByAsset.get(String(o.asset_id)) ?? [];
    arr.push(o);
    openByAsset.set(String(o.asset_id), arr);
  }

  const creds = await getOrCreateCreds(admin, userId);
  const signer = new Wallet(POLY_PRIVATE_KEY);
  const client = new ClobClient(CLOB_HOST, CHAIN_ID, signer, creds, POLY_PROXY_SIG, POLY_FUNDER_ADDRESS);

  // Fetch current open orders from Polymarket so we can detect fills
  let polyOpenIds = new Set<string>();
  try {
    const polyOpen: any = await client.getOpenOrders();
    const list = Array.isArray(polyOpen) ? polyOpen : (polyOpen?.data ?? []);
    polyOpenIds = new Set(list.map((o: any) => String(o.id ?? o.orderID ?? o.order_id)));
  } catch (e) {
    log.notes.errors.push({ stage: "getOpenOrders", error: String((e as any)?.message ?? e) });
  }

  let totalCapital = 0;

  for (const mkt of markets) {
    log.markets_processed++;
    const assetId = String(mkt.asset_id);
    const sizeUsdc = Number(mkt.size_usdc_override ?? cfg.default_size_usdc);
    const maxInv = Number(mkt.max_inventory_usdc_override ?? cfg.default_max_inventory_usdc);
    const offsetTicks = Number(mkt.spread_offset_ticks_override ?? cfg.default_spread_offset_ticks);
    const minExistingSpread = TICK * Number(cfg.default_min_existing_spread_ticks);

    const book = await getBook(assetId);
    if (!book) {
      log.notes.skipped.push({ assetId, reason: "no book" });
      await admin.from("mm_markets").update({
        last_cycle_at: new Date().toISOString(),
        last_error: "no order book returned",
      }).eq("id", mkt.id);
      continue;
    }

    const mid = (book.bestBid + book.bestAsk) / 2;
    if (book.bestAsk - book.bestBid < minExistingSpread) {
      log.notes.skipped.push({ assetId, reason: `spread ${(book.bestAsk - book.bestBid).toFixed(4)} too tight` });
      await admin.from("mm_markets").update({
        last_book_best_bid: book.bestBid, last_book_best_ask: book.bestAsk,
        last_cycle_at: new Date().toISOString(), last_error: null,
      }).eq("id", mkt.id);
      continue;
    }

    const targetBid = Math.min(roundTick(book.bestBid + offsetTicks * TICK), mid - TICK);
    const targetAsk = Math.max(roundTick(book.bestAsk - offsetTicks * TICK), mid + TICK);

    // ---- Detect fills from disappeared open orders
    const prior = openByAsset.get(assetId) ?? [];
    let invDelta = 0;
    let spreadCaptured = 0;
    let inv = Number(mkt.inventory_shares ?? 0);
    let avg = Number(mkt.inventory_avg_price ?? 0);
    for (const o of prior) {
      if (!polyOpenIds.has(String(o.poly_order_id))) {
        // Assume fully filled (worst case overcounts; cycle-level reconcile via /positions could refine)
        const filledShares = Number(o.size);
        log.fills_detected++;
        if (o.side === "BUY") {
          const newInv = inv + filledShares;
          avg = newInv > 0 ? (inv * avg + filledShares * Number(o.price)) / newInv : 0;
          inv = newInv;
          invDelta += filledShares;
        } else {
          const sellPrice = Number(o.price);
          spreadCaptured += filledShares * (sellPrice - avg);
          inv = Math.max(0, inv - filledShares);
        }
        await admin.from("mm_open_orders").delete().eq("id", o.id);
      }
    }

    // ---- Cancel any remaining open orders that aren't at target price
    for (const o of prior) {
      if (!polyOpenIds.has(String(o.poly_order_id))) continue; // already gone
      const targetPrice = o.side === "BUY" ? targetBid : targetAsk;
      if (Math.abs(Number(o.price) - targetPrice) < TICK / 2) continue; // already correct
      try {
        await client.cancelOrder({ orderID: o.poly_order_id });
        await admin.from("mm_open_orders").delete().eq("id", o.id);
        log.orders_cancelled++;
      } catch (e) {
        log.notes.errors.push({ assetId, stage: "cancel", error: String((e as any)?.message ?? e) });
      }
    }

    const invUsdc = inv * mid;

    // ---- Decide what to post
    const stillHaveBid = (openByAsset.get(assetId) ?? []).some(
      (o) => o.side === "BUY" && polyOpenIds.has(String(o.poly_order_id)) &&
        Math.abs(Number(o.price) - targetBid) < TICK / 2,
    );
    const stillHaveAsk = (openByAsset.get(assetId) ?? []).some(
      (o) => o.side === "SELL" && polyOpenIds.has(String(o.poly_order_id)) &&
        Math.abs(Number(o.price) - targetAsk) < TICK / 2,
    );

    // Post BUY if inventory headroom AND under global cap
    if (!stillHaveBid && invUsdc < maxInv && totalCapital + sizeUsdc <= Number(cfg.total_capital_cap_usdc)) {
      const shares = sizeUsdc / targetBid;
      try {
        const signed = await client.createOrder({ tokenID: assetId, price: targetBid, side: Side.BUY, size: shares, feeRateBps: 0 });
        const resp: any = await client.postOrder(signed, OrderType.GTC);
        if (resp?.success && resp?.orderID) {
          await admin.from("mm_open_orders").insert({
            user_id: userId, asset_id: assetId, poly_order_id: String(resp.orderID),
            side: "BUY", price: targetBid, size: shares,
          });
          totalCapital += sizeUsdc;
          log.orders_placed++;
        } else {
          log.notes.errors.push({ assetId, stage: "postBid", error: resp?.errorMsg ?? JSON.stringify(resp) });
        }
      } catch (e) {
        log.notes.errors.push({ assetId, stage: "postBid", error: String((e as any)?.message ?? e) });
      }
    }

    // Post SELL if we have inventory
    if (!stillHaveAsk && inv > 0) {
      const sellShares = Math.min(inv, sizeUsdc / targetAsk);
      if (sellShares * targetAsk >= 1) {
        try {
          const signed = await client.createOrder({ tokenID: assetId, price: targetAsk, side: Side.SELL, size: sellShares, feeRateBps: 0 });
          const resp: any = await client.postOrder(signed, OrderType.GTC);
          if (resp?.success && resp?.orderID) {
            await admin.from("mm_open_orders").insert({
              user_id: userId, asset_id: assetId, poly_order_id: String(resp.orderID),
              side: "SELL", price: targetAsk, size: sellShares,
            });
            log.orders_placed++;
          } else {
            log.notes.errors.push({ assetId, stage: "postAsk", error: resp?.errorMsg ?? JSON.stringify(resp) });
          }
        } catch (e) {
          log.notes.errors.push({ assetId, stage: "postAsk", error: String((e as any)?.message ?? e) });
        }
      }
    }

    await admin.from("mm_markets").update({
      inventory_shares: inv,
      inventory_avg_price: avg,
      spread_captured_usdc: Number(mkt.spread_captured_usdc ?? 0) + spreadCaptured,
      last_bid_price: targetBid,
      last_ask_price: targetAsk,
      last_book_best_bid: book.bestBid,
      last_book_best_ask: book.bestAsk,
      last_cycle_at: new Date().toISOString(),
      last_error: null,
    }).eq("id", mkt.id);
  }

  log.total_capital_at_risk_usdc = totalCapital;
  await admin.from("mm_cycles").insert(log);
  return log;
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
      const { data } = await admin.from("mm_config").select("user_id").eq("enabled", true);
      userIds = (data ?? []).map((r: any) => r.user_id);
    }

    const results = [];
    for (const uid of userIds) {
      try { results.push(await runForUser(admin, uid)); }
      catch (e) { results.push({ user_id: uid, error: String((e as any)?.message ?? e) }); }
    }

    return new Response(JSON.stringify({ ok: true, results }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("mm-cycle err", e);
    return new Response(JSON.stringify({ ok: false, error: String((e as any)?.message ?? e) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
