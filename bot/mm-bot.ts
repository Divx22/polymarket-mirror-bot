// Standalone market-maker bot — runs the same logic as the
// `mm-cycle` edge function but from a machine you control (e.g. a
// Hetzner Frankfurt VPS), so outbound traffic to Polymarket exits
// from a non-geoblocked IP.
//
// Run:  deno run --allow-net --allow-env mm-bot.ts
// Required env:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//   POLY_PRIVATE_KEY
//   POLY_FUNDER_ADDRESS
//   CYCLE_INTERVAL_SECONDS  (optional, default 30)
import "npm:tslib@2.6.2";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { ClobClient, Side, OrderType } from "npm:@polymarket/clob-client@4.21.0";
import { Wallet } from "npm:ethers@5.7.2";

const POLY_PROXY_SIG = 1;
const CLOB_HOST = "https://clob.polymarket.com";
const CHAIN_ID = 137;
const TICK = 0.001;

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const POLY_PRIVATE_KEY = Deno.env.get("POLY_PRIVATE_KEY")!;
const POLY_FUNDER_ADDRESS = Deno.env.get("POLY_FUNDER_ADDRESS")!;
const INTERVAL_S = Number(Deno.env.get("CYCLE_INTERVAL_SECONDS") ?? "30");

if (!SUPABASE_URL || !SERVICE_ROLE || !POLY_PRIVATE_KEY || !POLY_FUNDER_ADDRESS) {
  console.error("Missing required env vars. See header of file.");
  Deno.exit(1);
}

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

async function runForUser(admin: any, userId: string) {
  const log: any = {
    user_id: userId, markets_processed: 0, orders_placed: 0, orders_cancelled: 0,
    fills_detected: 0, total_capital_at_risk_usdc: 0, notes: { skipped: [], errors: [] },
  };

  const { data: cfg } = await admin.from("mm_config").select("*").eq("user_id", userId).maybeSingle();
  const { data: markets } = await admin.from("mm_markets").select("*").eq("user_id", userId).eq("active", true);

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

  const { data: openOrders } = await admin.from("mm_open_orders").select("*").eq("user_id", userId);
  const openByAsset = new Map<string, any[]>();
  for (const o of openOrders ?? []) {
    const arr = openByAsset.get(String(o.asset_id)) ?? [];
    arr.push(o);
    openByAsset.set(String(o.asset_id), arr);
  }

  const creds = await getOrCreateCreds(admin, userId);
  const signer = new Wallet(POLY_PRIVATE_KEY);
  const client = new ClobClient(CLOB_HOST, CHAIN_ID, signer, creds, POLY_PROXY_SIG, POLY_FUNDER_ADDRESS);

  const polyPositions = await getPolyPositions();

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
    if (!book) { log.notes.skipped.push({ assetId, reason: "no book" }); continue; }

    const mid = (book.bestBid + book.bestAsk) / 2;
    const quoteMode = String(cfg.quote_mode ?? "join");

    let targetBid: number, targetAsk: number;
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

    const prior = openByAsset.get(assetId) ?? [];
    const polyPos = polyPositions.get(assetId) ?? { shares: 0, avgPrice: 0 };
    const dbPriorInv = Number(mkt.inventory_shares ?? 0);
    const dbPriorAvg = Number(mkt.inventory_avg_price ?? 0);
    const inv = polyPos.shares;
    const avg = polyPos.avgPrice || dbPriorAvg;

    let spreadCaptured = 0;
    const delta = inv - dbPriorInv;
    if (Math.abs(delta) > 0.0001) {
      log.fills_detected++;
      if (delta > 0) {
        await admin.from("mm_fills").insert({
          user_id: userId, asset_id: assetId,
          market_question: mkt.market_question, outcome: mkt.outcome,
          side: "BUY", price: targetBid, shares: delta, usdc_value: delta * targetBid,
          poly_order_id: null,
        });
      } else {
        const soldShares = -delta;
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

    for (const o of prior) {
      if (!polyOpenIds.has(String(o.poly_order_id))) {
        await admin.from("mm_open_orders").delete().eq("id", o.id);
      }
    }

    // On tight 1-tick books: single sell at the join price for fast fills.
    // On wider books: build the configured sell ladder above targetAsk.
    const tightBook = bookSpread < 2 * TICK;
    const ladderRungs = tightBook ? 1 : Math.max(1, Number(cfg.sell_ladder_rungs ?? 4));
    const ladderSpacing = Math.max(1, Number(cfg.sell_ladder_spacing_ticks ?? 2));
    const ladderPrices: number[] = [];
    for (let i = 0; i < ladderRungs; i++) {
      const p = roundTick(targetAsk + i * ladderSpacing * TICK);
      if (p < 1) ladderPrices.push(p);
    }
    const isOnLadder = (price: number) =>
      ladderPrices.some((lp) => Math.abs(lp - price) < TICK / 2);

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
    const stillHaveBid = (openByAsset.get(assetId) ?? []).some(
      (o) => o.side === "BUY" && polyOpenIds.has(String(o.poly_order_id)) &&
        Math.abs(Number(o.price) - targetBid) < TICK / 2,
    );
    const existingAsks = (openByAsset.get(assetId) ?? []).filter(
      (o) => o.side === "SELL" && polyOpenIds.has(String(o.poly_order_id)),
    );
    const haveAskAt = (price: number) =>
      existingAsks.some((o) => Math.abs(Number(o.price) - price) < TICK / 2);

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

    if (inv > 0 && ladderPrices.length > 0) {
      const sharesPerRung = inv / ladderPrices.length;
      for (const rungPrice of ladderPrices) {
        if (haveAskAt(rungPrice)) continue;
        if (sharesPerRung * rungPrice < 1) continue;
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

async function cycle() {
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE);
  const { data } = await admin.from("mm_config").select("user_id").eq("enabled", true);
  const userIds = (data ?? []).map((r: any) => r.user_id);
  for (const uid of userIds) {
    try {
      const log = await runForUser(admin, uid);
      console.log(new Date().toISOString(), "user", uid,
        "markets", log.markets_processed,
        "placed", log.orders_placed,
        "cancelled", log.orders_cancelled,
        "fills", log.fills_detected,
        "errors", log.notes.errors.length);
    } catch (e) {
      console.error("cycle err", uid, e);
    }
  }
}

// Show egress IP once at startup so you can confirm Frankfurt
try {
  const ip = await (await fetch("https://api.ipify.org?format=json")).json();
  console.log("egress IP:", ip.ip);
} catch (_) { /* ignore */ }

console.log(`mm-bot started, interval=${INTERVAL_S}s`);
while (true) {
  const t0 = Date.now();
  try { await cycle(); } catch (e) { console.error("top-level err", e); }
  const elapsed = (Date.now() - t0) / 1000;
  const sleep = Math.max(1, INTERVAL_S - elapsed);
  await new Promise((r) => setTimeout(r, sleep * 1000));
}
