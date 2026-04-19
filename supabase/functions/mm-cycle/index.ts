// Market-maker bot cycle — dual mode: FLIP + INVENTORY HOLD.
//
// Per active mm_markets row:
//   1. Refresh book snapshot (best bid/ask) so the UI is live.
//   2. Sync real Polymarket inventory; detect fills via delta vs DB.
//   3. On a BUY fill: split shares → flip_bucket (flip_pct%) + inventory_bucket (inventory_pct%).
//      Update inventory_avg_cost (weighted) using only inventory_bucket additions.
//   4. On a SELL fill: drain flip_bucket first (flip profit = +1 tick × shares),
//      then inventory_bucket (inventory profit = (sell − avg_cost) × shares).
//   5. Cancel any of our open orders not at a current target (bid, flip ask, or inventory ladder).
//   6. Repost:
//        - BUY at target_bid (size_usdc) — UNLESS inventory_bucket value ≥ max_inventory_per_market_usdc.
//          BUYs continue even while inventory is held; only paused when cap hit.
//        - FLIP SELL at target_bid + 1 tick covering flip_bucket_shares.
//        - INVENTORY LADDER SELLs at max(avg_cost, best_ask) + ladder_ticks,
//          split per inventory_ladder_pcts.
//   7. Immediate intra-cycle repost: after fill detection we recompute open orders so a
//      partial-fill remainder is reposted in the same cycle.
//
// pg_cron triggers this every 30 s.

import "npm:tslib@2.6.2";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { ClobClient, Side, OrderType } from "npm:@polymarket/clob-client@4.21.0";
import { Wallet } from "npm:ethers@5.7.2";

const POLY_PROXY_SIG = 1;
const CLOB_HOST = "https://clob.polymarket.com";
const CHAIN_ID = 137;
const TICK = 0.001;

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

async function getPolyPositions(): Promise<Map<string, { shares: number; avgPrice: number }>> {
  const map = new Map<string, { shares: number; avgPrice: number }>();
  try {
    const r = await fetch(`https://data-api.polymarket.com/positions?user=${POLY_FUNDER_ADDRESS}&limit=500`);
    if (!r.ok) return map;
    const list: any[] = await r.json();
    for (const p of list) {
      map.set(String(p.asset), {
        shares: Number(p.size ?? 0),
        avgPrice: Number(p.avgPrice ?? 0),
      });
    }
  } catch (_) { /* swallow */ }
  return map;
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

const roundTick = (p: number) => Math.round(p / TICK) * TICK;
const eqPrice = (a: number, b: number) => Math.abs(a - b) < TICK / 2;

async function fetchPolyOpenIds(client: any, log: any): Promise<Set<string>> {
  try {
    const polyOpen: any = await client.getOpenOrders();
    const list = Array.isArray(polyOpen) ? polyOpen : (polyOpen?.data ?? []);
    return new Set(list.map((o: any) => String(o.id ?? o.orderID ?? o.order_id)));
  } catch (e) {
    log.notes.errors.push({ stage: "getOpenOrders", error: String((e as any)?.message ?? e) });
    return new Set();
  }
}

async function runForUser(admin: any, userId: string) {
  const log: any = {
    user_id: userId, markets_processed: 0, orders_placed: 0, orders_cancelled: 0,
    fills_detected: 0, total_capital_at_risk_usdc: 0, notes: { skipped: [], errors: [] },
  };

  const { data: cfg } = await admin.from("mm_config").select("*").eq("user_id", userId).maybeSingle();
  const { data: markets } = await admin.from("mm_markets").select("*").eq("user_id", userId).eq("active", true);

  // Always refresh book so UI shows live bid/ask even if disabled
  if (markets?.length) {
    await Promise.all(markets.map(async (mk: any) => {
      const b = await getBook(String(mk.asset_id));
      if (b) {
        await admin.from("mm_markets").update({
          last_book_best_bid: b.bestBid, last_book_best_ask: b.bestAsk,
          last_cycle_at: new Date().toISOString(), last_error: null,
        }).eq("id", mk.id);
        mk.last_book_best_bid = b.bestBid;
        mk.last_book_best_ask = b.bestAsk;
      } else {
        await admin.from("mm_markets").update({
          last_cycle_at: new Date().toISOString(), last_error: "no order book returned",
        }).eq("id", mk.id);
      }
    }));
  }

  if (!cfg || !cfg.enabled) { log.notes.skipped.push("mm disabled"); return log; }
  if (!markets?.length) { log.notes.skipped.push("no active markets"); return log; }

  const creds = await getOrCreateCreds(admin, userId);
  const signer = new Wallet(POLY_PRIVATE_KEY);
  const client = new ClobClient(CLOB_HOST, CHAIN_ID, signer, creds, POLY_PROXY_SIG, POLY_FUNDER_ADDRESS);

  const polyPositions = await getPolyPositions();
  let polyOpenIds = await fetchPolyOpenIds(client, log);

  // ===== GEO-BLOCK PRE-FLIGHT =====
  // If our IP is geo-restricted, posting will fail. Cancelling would still succeed,
  // leaving us flat with no resting orders. Detect early and skip the entire
  // cancel/repost phase so existing orders stay alive on Polymarket.
  let geoBlocked = false;
  try {
    // Cheap probe: createOrder is local signing only; postOrder is the network call.
    // We sign a tiny throwaway order at an impossible price and try to post; we
    // immediately cancel if it somehow lands. Cheaper alternative: hit a lightweight
    // authenticated endpoint. Use getOpenOrders result as the signal — if it threw
    // earlier, errors will already be logged with a "region" / "restricted" message.
    const recentErrs = log.notes.errors.map((e: any) => String(e.error ?? "").toLowerCase());
    if (recentErrs.some((s: string) => s.includes("region") || s.includes("restricted") || s.includes("geo") || s.includes("blocked"))) {
      geoBlocked = true;
    }
  } catch (_) { /* ignore */ }

  if (geoBlocked) {
    log.notes.skipped.push("GEO-BLOCKED: skipping all cancels/reposts to preserve existing orders");
    log.notes.geo_blocked = true;
    await admin.from("mm_cycles").insert(log);
    return log;
  }

  // Index our DB-tracked open orders by asset
  const { data: openOrders } = await admin.from("mm_open_orders").select("*").eq("user_id", userId);
  const openByAsset = new Map<string, any[]>();
  for (const o of openOrders ?? []) {
    const arr = openByAsset.get(String(o.asset_id)) ?? [];
    arr.push(o);
    openByAsset.set(String(o.asset_id), arr);
  }

  let totalCapital = 0;
  const flipPctDefault = Number(cfg.flip_pct ?? 70);
  const invPctDefault = Number(cfg.inventory_pct ?? 30);
  const ladderPcts: number[] = (cfg.inventory_ladder_pcts ?? [25, 25, 50]).map(Number);
  const ladderTicks: number[] = (cfg.inventory_ladder_ticks ?? [2, 3, 5]).map(Number);

  for (const mkt of markets) {
    log.markets_processed++;
    const assetId = String(mkt.asset_id);
    const sizeUsdc = Number(mkt.size_usdc_override ?? cfg.default_size_usdc);
    const flipPct = Number(mkt.flip_pct_override ?? flipPctDefault) / 100;
    const invPct = Number(mkt.inventory_pct_override ?? invPctDefault) / 100;
    const maxInvPerMarketUsdc = Number(
      mkt.max_inventory_per_market_usdc_override ?? cfg.max_inventory_per_market_usdc ?? 50,
    );

    const book = await getBook(assetId);
    if (!book) {
      log.notes.skipped.push({ assetId, reason: "no book" });
      continue;
    }

    const targetBid = roundTick(book.bestBid);
    const flipAskPrice = roundTick(targetBid + TICK); // +1 tick flip exit

    // ===== FILL DETECTION =====
    const polyPos = polyPositions.get(assetId) ?? { shares: 0, avgPrice: 0 };
    const dbPriorInv = Number(mkt.inventory_shares ?? 0);
    let flipBucket = Number(mkt.flip_bucket_shares ?? 0);
    let invBucket = Number(mkt.inventory_bucket_shares ?? 0);
    let invAvgCost = Number(mkt.inventory_avg_cost ?? 0);
    let flipProfit = Number(mkt.flip_profit_usdc ?? 0);
    let invProfit = Number(mkt.inventory_profit_usdc ?? 0);

    const totalShares = polyPos.shares;
    const delta = totalShares - dbPriorInv;

    if (Math.abs(delta) > 0.0001) {
      log.fills_detected++;
      if (delta > 0) {
        // BUY fill — split into flip + inventory buckets
        const flipShare = delta * flipPct;
        const invShare = delta - flipShare;
        const fillPrice = targetBid; // best estimate
        // Update weighted avg cost using ONLY the inventory portion
        if (invShare > 0) {
          const newInv = invBucket + invShare;
          invAvgCost = newInv > 0
            ? (invAvgCost * invBucket + fillPrice * invShare) / newInv
            : 0;
          invBucket = newInv;
        }
        flipBucket += flipShare;
        await admin.from("mm_fills").insert([
          flipShare > 0 && {
            user_id: userId, asset_id: assetId, market_question: mkt.market_question,
            outcome: mkt.outcome, side: "BUY", price: fillPrice,
            shares: flipShare, usdc_value: flipShare * fillPrice,
            poly_order_id: null, category: "flip",
          },
          invShare > 0 && {
            user_id: userId, asset_id: assetId, market_question: mkt.market_question,
            outcome: mkt.outcome, side: "BUY", price: fillPrice,
            shares: invShare, usdc_value: invShare * fillPrice,
            poly_order_id: null, category: "inventory",
          },
        ].filter(Boolean));
      } else {
        // SELL fill — drain flip first, then inventory
        let toSell = -delta;
        const flipAsk = flipAskPrice;
        const fromFlip = Math.min(toSell, flipBucket);
        if (fromFlip > 0) {
          // Flip profit = (flip ask − target bid) × shares = ~1 tick
          flipProfit += fromFlip * (flipAsk - targetBid);
          flipBucket -= fromFlip;
          toSell -= fromFlip;
          await admin.from("mm_fills").insert({
            user_id: userId, asset_id: assetId, market_question: mkt.market_question,
            outcome: mkt.outcome, side: "SELL", price: flipAsk,
            shares: fromFlip, usdc_value: fromFlip * flipAsk,
            poly_order_id: null, category: "flip",
          });
        }
        if (toSell > 0 && invBucket > 0) {
          const fromInv = Math.min(toSell, invBucket);
          // Best-effort exit price = max(avg_cost, best_ask) — matches our ladder anchor
          const exitPrice = Math.max(invAvgCost, book.bestAsk);
          invProfit += fromInv * (exitPrice - invAvgCost);
          invBucket -= fromInv;
          if (invBucket <= 1e-9) invAvgCost = 0;
          await admin.from("mm_fills").insert({
            user_id: userId, asset_id: assetId, market_question: mkt.market_question,
            outcome: mkt.outcome, side: "SELL", price: exitPrice,
            shares: fromInv, usdc_value: fromInv * exitPrice,
            poly_order_id: null, category: "inventory",
          });
        }
      }
    }

    // Reconcile bucket sums against real total (handles drift from manual trades)
    const bucketSum = flipBucket + invBucket;
    if (Math.abs(bucketSum - totalShares) > 0.5 && totalShares > 0) {
      // Snap inventory bucket to absorb drift; keep flip bucket as-is if possible
      invBucket = Math.max(0, totalShares - flipBucket);
      if (invBucket > 0 && invAvgCost === 0) invAvgCost = polyPos.avgPrice || targetBid;
    } else if (totalShares <= 1e-9) {
      flipBucket = 0; invBucket = 0; invAvgCost = 0;
    }

    // ===== TARGETS =====
    // Inventory ladder anchored at max(avg_cost, best_ask)
    const ladderAnchor = Math.max(invAvgCost || 0, book.bestAsk);
    const ladderPrices: { price: number; pctShares: number }[] = ladderTicks.map((t, i) => ({
      price: roundTick(ladderAnchor + t * TICK),
      pctShares: (ladderPcts[i] ?? 0) / 100,
    })).filter((r) => r.price < 1 && r.pctShares > 0);

    const isFlipAsk = (price: number) => eqPrice(price, flipAskPrice);
    const isLadderAsk = (price: number) => ladderPrices.some((lp) => eqPrice(lp.price, price));
    const isTargetBid = (price: number) => eqPrice(price, targetBid);

    // ===== CANCEL stale orders (skipped if geo-blocked) =====
    const prior = openByAsset.get(assetId) ?? [];
    if (geoBlocked) {
      log.notes.skipped.push({ assetId, reason: "geo-blocked, skipping cancels" });
    } else {
      for (const o of prior) {
        if (!polyOpenIds.has(String(o.poly_order_id))) {
          await admin.from("mm_open_orders").delete().eq("id", o.id);
          continue;
        }
        const keep = o.side === "BUY"
          ? isTargetBid(Number(o.price))
          : (isFlipAsk(Number(o.price)) || isLadderAsk(Number(o.price)));
        if (keep) continue;
        try {
          await client.cancelOrder({ orderID: o.poly_order_id });
          await admin.from("mm_open_orders").delete().eq("id", o.id);
          log.orders_cancelled++;
        } catch (e) {
          const msg = String((e as any)?.message ?? e);
          log.notes.errors.push({ assetId, stage: "cancel", error: msg });
          if (/region|restricted|geo|blocked/i.test(msg)) {
            geoBlocked = true;
            log.notes.geo_blocked = true;
            log.notes.skipped.push("GEO-BLOCKED mid-cycle: aborting further cancels");
            break;
          }
        }
      }
    }

    // Re-pull live open orders for accurate "what's still on book" — supports immediate
    // intra-cycle repost of partial-fill remainders.
    if (cfg.repost_partial_fills) {
      polyOpenIds = await fetchPolyOpenIds(client, log);
    }
    const { data: liveOpen } = await admin.from("mm_open_orders")
      .select("*").eq("user_id", userId).eq("asset_id", assetId);
    const liveOnPoly = (liveOpen ?? []).filter((o: any) => polyOpenIds.has(String(o.poly_order_id)));

    const haveBidAt = (price: number) => liveOnPoly.some((o: any) => o.side === "BUY" && eqPrice(Number(o.price), price));
    const haveAskAt = (price: number) => liveOnPoly.some((o: any) => o.side === "SELL" && eqPrice(Number(o.price), price));

    // ===== POST BUY =====
    // Inventory cap = inventory_bucket value (the held portion), NOT total shares.
    // BUYs continue even while flip orders are working — only paused when held inventory caps out.
    const invBucketUsdc = invBucket * (invAvgCost || targetBid);
    const underInvCap = invBucketUsdc < maxInvPerMarketUsdc;
    const underGlobalCap = totalCapital + sizeUsdc <= Number(cfg.total_capital_cap_usdc);

    if (!haveBidAt(targetBid) && underInvCap && underGlobalCap && targetBid > 0) {
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
    } else if (!underInvCap) {
      log.notes.skipped.push({ assetId, reason: `inv cap reached (${invBucketUsdc.toFixed(2)}/${maxInvPerMarketUsdc})` });
    }

    // ===== POST FLIP SELL =====
    if (flipBucket > 0 && !haveAskAt(flipAskPrice) && flipBucket * flipAskPrice >= 1) {
      try {
        const signed = await client.createOrder({ tokenID: assetId, price: flipAskPrice, side: Side.SELL, size: flipBucket, feeRateBps: 0 });
        const resp: any = await client.postOrder(signed, OrderType.GTC);
        if (resp?.success && resp?.orderID) {
          await admin.from("mm_open_orders").insert({
            user_id: userId, asset_id: assetId, poly_order_id: String(resp.orderID),
            side: "SELL", price: flipAskPrice, size: flipBucket,
          });
          log.orders_placed++;
        } else {
          log.notes.errors.push({ assetId, stage: "postFlipAsk", error: resp?.errorMsg ?? JSON.stringify(resp) });
        }
      } catch (e) {
        log.notes.errors.push({ assetId, stage: "postFlipAsk", error: String((e as any)?.message ?? e) });
      }
    }

    // ===== POST INVENTORY LADDER SELLS =====
    if (invBucket > 0 && ladderPrices.length > 0) {
      for (const rung of ladderPrices) {
        const rungShares = invBucket * rung.pctShares;
        if (rungShares <= 0) continue;
        if (haveAskAt(rung.price)) continue;
        if (rungShares * rung.price < 1) continue;
        try {
          const signed = await client.createOrder({ tokenID: assetId, price: rung.price, side: Side.SELL, size: rungShares, feeRateBps: 0 });
          const resp: any = await client.postOrder(signed, OrderType.GTC);
          if (resp?.success && resp?.orderID) {
            await admin.from("mm_open_orders").insert({
              user_id: userId, asset_id: assetId, poly_order_id: String(resp.orderID),
              side: "SELL", price: rung.price, size: rungShares,
            });
            log.orders_placed++;
          } else {
            log.notes.errors.push({ assetId, stage: "postInvAsk", price: rung.price, error: resp?.errorMsg ?? JSON.stringify(resp) });
          }
        } catch (e) {
          log.notes.errors.push({ assetId, stage: "postInvAsk", price: rung.price, error: String((e as any)?.message ?? e) });
        }
      }
    }

    await admin.from("mm_markets").update({
      inventory_shares: totalShares,
      inventory_avg_price: polyPos.avgPrice || invAvgCost,
      flip_bucket_shares: flipBucket,
      inventory_bucket_shares: invBucket,
      inventory_avg_cost: invAvgCost,
      flip_profit_usdc: flipProfit,
      inventory_profit_usdc: invProfit,
      last_bid_price: targetBid,
      last_ask_price: flipAskPrice,
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
