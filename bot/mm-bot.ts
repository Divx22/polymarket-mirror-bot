// Standalone market-maker bot — mirrors the `mm-cycle` edge function so
// outbound traffic to Polymarket exits from a non-geoblocked IP.
// Run:  deno run --allow-net --allow-env mm-bot.ts
// Required env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
//               POLY_PRIVATE_KEY, POLY_FUNDER_ADDRESS, [CYCLE_INTERVAL_SECONDS=30]
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
  console.error("Missing required env vars."); Deno.exit(1);
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
      map.set(String(p.asset), { shares: Number(p.size ?? 0), avgPrice: Number(p.avgPrice ?? 0) });
    }
  } catch (_) { /* swallow */ }
  return map;
}

async function getOrCreateCreds(admin: any, userId: string) {
  const { data: existing } = await admin
    .from("poly_credentials").select("api_key, api_secret, api_passphrase").eq("user_id", userId).maybeSingle();
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
    if (!book) { log.notes.skipped.push({ assetId, reason: "no book" }); continue; }

    const targetBid = roundTick(book.bestBid);
    const flipAskPrice = roundTick(targetBid + TICK);

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
        const flipShare = delta * flipPct;
        const invShare = delta - flipShare;
        const fillPrice = targetBid;
        if (invShare > 0) {
          const newInv = invBucket + invShare;
          invAvgCost = newInv > 0 ? (invAvgCost * invBucket + fillPrice * invShare) / newInv : 0;
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
        let toSell = -delta;
        const fromFlip = Math.min(toSell, flipBucket);
        if (fromFlip > 0) {
          flipProfit += fromFlip * (flipAskPrice - targetBid);
          flipBucket -= fromFlip;
          toSell -= fromFlip;
          await admin.from("mm_fills").insert({
            user_id: userId, asset_id: assetId, market_question: mkt.market_question,
            outcome: mkt.outcome, side: "SELL", price: flipAskPrice,
            shares: fromFlip, usdc_value: fromFlip * flipAskPrice,
            poly_order_id: null, category: "flip",
          });
        }
        if (toSell > 0 && invBucket > 0) {
          const fromInv = Math.min(toSell, invBucket);
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

    const bucketSum = flipBucket + invBucket;
    if (Math.abs(bucketSum - totalShares) > 0.5 && totalShares > 0) {
      invBucket = Math.max(0, totalShares - flipBucket);
      if (invBucket > 0 && invAvgCost === 0) invAvgCost = polyPos.avgPrice || targetBid;
    } else if (totalShares <= 1e-9) {
      flipBucket = 0; invBucket = 0; invAvgCost = 0;
    }

    const ladderAnchor = Math.max(invAvgCost || 0, book.bestAsk);
    const ladderPrices: { price: number; pctShares: number }[] = ladderTicks.map((t, i) => ({
      price: roundTick(ladderAnchor + t * TICK),
      pctShares: (ladderPcts[i] ?? 0) / 100,
    })).filter((r) => r.price < 1 && r.pctShares > 0);

    const isFlipAsk = (price: number) => eqPrice(price, flipAskPrice);
    const isLadderAsk = (price: number) => ladderPrices.some((lp) => eqPrice(lp.price, price));
    const isTargetBid = (price: number) => eqPrice(price, targetBid);

    const prior = openByAsset.get(assetId) ?? [];
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
        log.notes.errors.push({ assetId, stage: "cancel", error: String((e as any)?.message ?? e) });
      }
    }

    if (cfg.repost_partial_fills) {
      polyOpenIds = await fetchPolyOpenIds(client, log);
    }
    const { data: liveOpen } = await admin.from("mm_open_orders")
      .select("*").eq("user_id", userId).eq("asset_id", assetId);
    const liveOnPoly = (liveOpen ?? []).filter((o: any) => polyOpenIds.has(String(o.poly_order_id)));

    const haveBidAt = (price: number) => liveOnPoly.some((o: any) => o.side === "BUY" && eqPrice(Number(o.price), price));
    const haveAskAt = (price: number) => liveOnPoly.some((o: any) => o.side === "SELL" && eqPrice(Number(o.price), price));

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
    } catch (e) { console.error("cycle err", uid, e); }
  }
}

try {
  const ip = await (await fetch("https://api.ipify.org?format=json")).json();
  console.log("egress IP:", ip.ip);
} catch (_) { /* ignore */ }

console.log(`mm-bot started (flip+inventory mode), interval=${INTERVAL_S}s`);
while (true) {
  const t0 = Date.now();
  try { await cycle(); } catch (e) { console.error("top-level err", e); }
  const elapsed = (Date.now() - t0) / 1000;
  const sleep = Math.max(1, INTERVAL_S - elapsed);
  await new Promise((r) => setTimeout(r, sleep * 1000));
}
