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

// Fetch real holdings from Polymarket — single source of truth for inventory.
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
  } catch (_) { /* swallow — fallback is empty map */ }
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

  const { data: markets } = await admin
    .from("mm_markets").select("*").eq("user_id", userId).eq("active", true);

  // Always refresh book snapshots so the UI shows live bid/ask
  // even when the bot is disabled or the market gets skipped below.
  if (markets?.length) {
    await Promise.all(markets.map(async (mk: any) => {
      const b = await getBook(String(mk.asset_id));
      if (b) {
        await admin.from("mm_markets").update({
          last_book_best_bid: b.bestBid,
          last_book_best_ask: b.bestAsk,
          last_cycle_at: new Date().toISOString(),
          last_error: null,
        }).eq("id", mk.id);
        // mutate in-memory so the loop below doesn't re-fetch unnecessarily
        mk.last_book_best_bid = b.bestBid;
        mk.last_book_best_ask = b.bestAsk;
      } else {
        await admin.from("mm_markets").update({
          last_cycle_at: new Date().toISOString(),
          last_error: "no order book returned",
        }).eq("id", mk.id);
      }
    }));
  }

  if (!cfg || !cfg.enabled) {
    log.notes.skipped.push("mm disabled");
    return log;
  }
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

  // ===== Single source of truth: real Polymarket positions =====
  const polyPositions = await getPolyPositions();

  // Re-fetch open orders from Polymarket so we know what to cancel/keep
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
    const quoteMode = String(cfg.quote_mode ?? "join");

    let targetBid: number;
    let targetAsk: number;
    const bookSpread = book.bestAsk - book.bestBid;
    // Hybrid: inside-quote when book is wide enough, else fall back to JOIN
    // so we always have a legal price to post (1-tick books have no price between).
    if (quoteMode === "inside" && bookSpread >= minExistingSpread) {
      targetBid = Math.min(roundTick(book.bestBid + offsetTicks * TICK), mid - TICK);
      targetAsk = Math.max(roundTick(book.bestAsk - offsetTicks * TICK), mid + TICK);
    } else if (quoteMode === "passive") {
      targetBid = roundTick(Math.max(TICK, book.bestBid - TICK));
      targetAsk = roundTick(book.bestAsk + TICK);
    } else {
      // join mode (also fallback for inside on tight books)
      targetBid = roundTick(book.bestBid);
      targetAsk = roundTick(book.bestAsk);
    }

    // ===== TRUTH-FROM-POLYMARKET inventory sync =====
    // Use real Polymarket position as authoritative inventory & avg price.
    // Detect fills by comparing prior DB inventory to current real inventory.
    const prior = openByAsset.get(assetId) ?? [];
    const polyPos = polyPositions.get(assetId) ?? { shares: 0, avgPrice: 0 };
    const dbPriorInv = Number(mkt.inventory_shares ?? 0);
    const dbPriorAvg = Number(mkt.inventory_avg_price ?? 0);
    const inv = polyPos.shares;
    const avg = polyPos.avgPrice || dbPriorAvg;

    // Infer fill direction from delta. Buy fills = inventory grew, Sell fills = shrunk.
    let spreadCaptured = 0;
    const delta = inv - dbPriorInv;
    if (Math.abs(delta) > 0.0001) {
      log.fills_detected++;
      if (delta > 0) {
        // BUY filled — best estimate of fill price is our last targetBid
        await admin.from("mm_fills").insert({
          user_id: userId, asset_id: assetId,
          market_question: mkt.market_question, outcome: mkt.outcome,
          side: "BUY", price: targetBid, shares: delta, usdc_value: delta * targetBid,
          poly_order_id: null,
        });
      } else {
        const soldShares = -delta;
        // SELL filled — fill price ≈ our last targetAsk; capture spread = (ask − avg) × shares
        const fillPrice = targetAsk;
        spreadCaptured = soldShares * (fillPrice - dbPriorAvg);
        await admin.from("mm_fills").insert({
          user_id: userId, asset_id: assetId,
          market_question: mkt.market_question, outcome: mkt.outcome,
          side: "SELL", price: fillPrice, shares: soldShares, usdc_value: soldShares * fillPrice,
          poly_order_id: null,
        });
      }
    }

    // Clean up DB rows for orders no longer open on Polymarket
    for (const o of prior) {
      if (!polyOpenIds.has(String(o.poly_order_id))) {
        await admin.from("mm_open_orders").delete().eq("id", o.id);
      }
    }

    // Pre-compute the sell ladder
    const ladderRungs = Math.max(1, Number(cfg.sell_ladder_rungs ?? 4));
    const ladderSpacing = Math.max(1, Number(cfg.sell_ladder_spacing_ticks ?? 2));
    const ladderPrices: number[] = [];
    for (let i = 0; i < ladderRungs; i++) {
      const p = roundTick(targetAsk + i * ladderSpacing * TICK);
      if (p < 1) ladderPrices.push(p);
    }
    const isOnLadder = (price: number) =>
      ladderPrices.some((lp) => Math.abs(lp - price) < TICK / 2);

    // Cancel any remaining open orders not at a valid target
    for (const o of prior) {
      if (!polyOpenIds.has(String(o.poly_order_id))) continue;
      const ok = o.side === "BUY"
        ? Math.abs(Number(o.price) - targetBid) < TICK / 2
        : isOnLadder(Number(o.price));
      if (ok) continue;
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
    const existingAsks = (openByAsset.get(assetId) ?? []).filter(
      (o) => o.side === "SELL" && polyOpenIds.has(String(o.poly_order_id)),
    );
    const haveAskAt = (price: number) =>
      existingAsks.some((o) => Math.abs(Number(o.price) - price) < TICK / 2);

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

    // Post laddered SELLs: split inventory equally across rungs, skip rungs we already have
    if (inv > 0 && ladderPrices.length > 0) {
      const sharesPerRung = inv / ladderPrices.length;
      for (const rungPrice of ladderPrices) {
        if (haveAskAt(rungPrice)) continue;
        if (sharesPerRung * rungPrice < 1) continue; // below Polymarket $1 min
        try {
          const signed = await client.createOrder({ tokenID: assetId, price: rungPrice, side: Side.SELL, size: sharesPerRung, feeRateBps: 0 });
          const resp: any = await client.postOrder(signed, OrderType.GTC);
          if (resp?.success && resp?.orderID) {
            await admin.from("mm_open_orders").insert({
              user_id: userId, asset_id: assetId, poly_order_id: String(resp.orderID),
              side: "SELL", price: rungPrice, size: sharesPerRung,
            });
            log.orders_placed++;
          } else {
            log.notes.errors.push({ assetId, stage: "postAsk", price: rungPrice, error: resp?.errorMsg ?? JSON.stringify(resp) });
          }
        } catch (e) {
          log.notes.errors.push({ assetId, stage: "postAsk", price: rungPrice, error: String((e as any)?.message ?? e) });
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
