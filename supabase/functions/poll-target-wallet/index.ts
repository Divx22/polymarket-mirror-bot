// Polls Polymarket Data API for the configured target wallet's recent trades
// and writes new ones into detected_trades + creates simulated paper_orders.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const DATA_API = "https://data-api.polymarket.com";
const CLOB_API = "https://clob.polymarket.com";
const POLYGONSCAN_API = "https://api.polygonscan.com/api";
const POLYGONSCAN_KEY = Deno.env.get("POLYGONSCAN_API_KEY") ?? "";

async function fetchTxInfo(txHash: string) {
  if (!POLYGONSCAN_KEY || !txHash) return null;
  try {
    const [rcptR, txR] = await Promise.all([
      fetch(`${POLYGONSCAN_API}?module=proxy&action=eth_getTransactionReceipt&txhash=${txHash}&apikey=${POLYGONSCAN_KEY}`),
      fetch(`${POLYGONSCAN_API}?module=proxy&action=eth_getTransactionByHash&txhash=${txHash}&apikey=${POLYGONSCAN_KEY}`),
    ]);
    const rcpt = (await rcptR.json())?.result ?? null;
    const tx = (await txR.json())?.result ?? null;
    if (!rcpt && !tx) return null;
    return {
      block_number: rcpt?.blockNumber ? parseInt(rcpt.blockNumber, 16) : null,
      gas_used: rcpt?.gasUsed ? parseInt(rcpt.gasUsed, 16) : null,
      status: rcpt?.status === "0x1" ? "success" : rcpt?.status ? "failed" : null,
      from: tx?.from ?? null,
      to: tx?.to ?? null,
    };
  } catch (e) {
    console.error("polygonscan err", e);
    return null;
  }
}

type Trade = {
  transactionHash: string;
  timestamp: number; // unix seconds
  side: "BUY" | "SELL";
  size: number | string;
  price: number | string;
  asset: string; // CTF token id
  conditionId?: string;
  title?: string;
  outcome?: string;
  outcomeIndex?: number;
};

const GOLDSKY_URL =
  "https://api.goldsky.com/api/public/project_cl6mb8i9h0003e201j6li0diw/subgraphs/orderbook-subgraph/0.0.1/gn";

// Fetch decoded fills from Goldsky (low-latency on-chain index).
// Includes events where wallet is maker OR taker.
async function fetchGoldskyFills(wallet: string) {
  const q = `{
    asMaker: orderFilledEvents(first: 50, orderBy: timestamp, orderDirection: desc, where: {maker: "${wallet}"}) {
      id transactionHash timestamp maker taker makerAssetId takerAssetId makerAmountFilled takerAmountFilled
    }
    asTaker: orderFilledEvents(first: 50, orderBy: timestamp, orderDirection: desc, where: {taker: "${wallet}"}) {
      id transactionHash timestamp maker taker makerAssetId takerAssetId makerAmountFilled takerAmountFilled
    }
  }`;
  const r = await fetch(GOLDSKY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: q }),
  });
  if (!r.ok) throw new Error(`goldsky ${r.status}: ${await r.text()}`);
  const j = await r.json();
  if (j.errors) throw new Error(`goldsky errors: ${JSON.stringify(j.errors)}`);
  return [...(j.data?.asMaker ?? []), ...(j.data?.asTaker ?? [])];
}

// Cache for asset_id -> { conditionId, title, outcome }
const marketMetaCache = new Map<string, any>();
async function fetchMarketMeta(assetId: string) {
  if (marketMetaCache.has(assetId)) return marketMetaCache.get(assetId);
  let meta = { conditionId: null as string | null, title: null as string | null, outcome: null as string | null };
  try {
    const r = await fetch(
      `https://gamma-api.polymarket.com/markets?clob_token_ids=${assetId}`,
    );
    if (r.ok) {
      const arr = await r.json();
      const m = Array.isArray(arr) ? arr[0] : null;
      if (m) {
        meta.conditionId = m.conditionId ?? null;
        meta.title = m.question ?? null;
        // outcomes & clobTokenIds are JSON-encoded strings on gamma
        try {
          const outs = typeof m.outcomes === "string" ? JSON.parse(m.outcomes) : m.outcomes;
          const tids = typeof m.clobTokenIds === "string" ? JSON.parse(m.clobTokenIds) : m.clobTokenIds;
          if (Array.isArray(outs) && Array.isArray(tids)) {
            const idx = tids.findIndex((t: any) => String(t) === String(assetId));
            if (idx >= 0) meta.outcome = outs[idx] ?? null;
          }
        } catch { /* ignore */ }
      }
    }
  } catch (e) {
    console.error("market meta err", e);
  }
  marketMetaCache.set(assetId, meta);
  return meta;
}

// Cache: order_id -> { original_size, original_usdc }
const orderMetaCache = new Map<string, { size: number; usdc: number } | null>();

// Try to fetch the original posted order size from Polymarket Data API.
// Returns null when the order isn't found (AMM/sweep matches, very old orders, etc).
async function fetchOrderMeta(orderId: string, fallbackPrice: number) {
  if (!orderId) return null;
  if (orderMetaCache.has(orderId)) return orderMetaCache.get(orderId) ?? null;
  try {
    const r = await fetch(`https://data-api.polymarket.com/order/${orderId}`);
    if (!r.ok) {
      orderMetaCache.set(orderId, null);
      return null;
    }
    const j = await r.json();
    // Polymarket order shape: { size, price, ... } where size is in shares
    const size = Number(j.size ?? j.original_size ?? 0);
    const price = Number(j.price ?? fallbackPrice);
    if (!Number.isFinite(size) || size <= 0) {
      orderMetaCache.set(orderId, null);
      return null;
    }
    const meta = { size, usdc: size * price };
    orderMetaCache.set(orderId, meta);
    return meta;
  } catch (e) {
    console.error("fetchOrderMeta err", orderId, e);
    orderMetaCache.set(orderId, null);
    return null;
  }
}

// Polymarket Data API trades, indexed by tx_hash for quick lookup of order_id.
async function fetchPolyTradesByTx(wallet: string) {
  const map = new Map<string, any[]>(); // tx_hash -> trades[]
  try {
    const r = await fetch(`https://data-api.polymarket.com/trades?user=${wallet}&limit=100`);
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

// Convert a Goldsky fill to a normalized Trade for the wallet.
// USDC asset id is "0". If wallet is maker selling tokens for USDC -> SELL.
// If wallet is maker buying tokens with USDC -> BUY. Same logic mirrored for taker.
function normalizeFill(f: any, wallet: string) {
  const isMaker = f.maker.toLowerCase() === wallet;
  const myGives = isMaker ? f.makerAssetId : f.takerAssetId;
  const myGivesAmt = isMaker ? f.makerAmountFilled : f.takerAmountFilled;
  const myGets = isMaker ? f.takerAssetId : f.makerAssetId;
  const myGetsAmt = isMaker ? f.takerAmountFilled : f.makerAmountFilled;

  // USDC is asset "0", 6 decimals. Outcome shares are 6 decimals too on Polygon CTF.
  const USDC = "0";
  let side: "BUY" | "SELL";
  let asset: string;
  let shares: number;
  let usdc: number;

  if (myGives === USDC && myGets !== USDC) {
    side = "BUY";
    asset = myGets;
    shares = Number(myGetsAmt) / 1e6;
    usdc = Number(myGivesAmt) / 1e6;
  } else if (myGets === USDC && myGives !== USDC) {
    side = "SELL";
    asset = myGives;
    shares = Number(myGivesAmt) / 1e6;
    usdc = Number(myGetsAmt) / 1e6;
  } else {
    return null; // token-for-token swap, ignore
  }
  const price = shares > 0 ? usdc / shares : 0;
  return {
    transactionHash: f.transactionHash,
    timestamp: Number(f.timestamp),
    side,
    size: shares,
    price,
    asset,
    _usdc: usdc,
    _eventId: f.id,
  };
}

async function fetchTrades(wallet: string) {
  const fills = await fetchGoldskyFills(wallet);
  // Dedupe by event id (asMaker/asTaker may overlap if wallet trades with itself)
  const seen = new Set<string>();
  const norm = [];
  for (const f of fills) {
    if (seen.has(f.id)) continue;
    seen.add(f.id);
    const n = normalizeFill(f, wallet);
    if (n) norm.push(n);
  }
  // Enrich with market metadata
  for (const t of norm) {
    const meta = await fetchMarketMeta(t.asset);
    (t as any).conditionId = meta.conditionId;
    (t as any).title = meta.title;
    (t as any).outcome = meta.outcome;
  }
  return norm;
}

async function fetchMidpoint(tokenId: string): Promise<number | null> {
  try {
    const r = await fetch(`${CLOB_API}/midpoint?token_id=${tokenId}`);
    if (!r.ok) return null;
    const j = await r.json();
    const p = parseFloat(j.mid ?? j.midpoint ?? "");
    return Number.isFinite(p) ? p : null;
  } catch {
    return null;
  }
}

async function processForUser(
  admin: ReturnType<typeof createClient>,
  cfg: any,
) {
  const wallet = cfg.target_wallet?.toLowerCase();
  if (!wallet) return { skipped: "no wallet" };

  const trades = await fetchTrades(wallet);
  const lastSeenTs = Number(cfg.last_seen_ts ?? 0);

  // Sort ascending so we insert in chronological order
  trades.sort((a, b) => Number(a.timestamp) - Number(b.timestamp));

  let inserted = 0;
  let maxTs = lastSeenTs;

  for (const t of trades) {
    const ts = Number(t.timestamp);
    if (ts <= lastSeenTs) continue;

    const side = String(t.side).toUpperCase();
    const size = Number(t.size);
    const price = Number(t.price);
    const usdc = Number((t as any)._usdc ?? size * price);

    const onchain = await fetchTxInfo(t.transactionHash);

    const { data: detIns, error: detErr } = await admin
      .from("detected_trades")
      .insert({
        user_id: cfg.user_id,
        tx_hash: t.transactionHash,
        trade_ts: ts,
        side,
        market_id: t.conditionId ?? null,
        market_question: t.title ?? null,
        outcome: t.outcome ?? null,
        asset_id: t.asset,
        price,
        size,
        usdc_size: usdc,
        raw: { ...t, onchain } as any,
      })
      .select()
      .single();

    if (detErr) {
      // duplicate (unique violation) — skip silently
      if (!String(detErr.message).includes("duplicate")) {
        console.error("insert detected_trade err", detErr);
      }
      continue;
    }
    inserted++;

    // Snapshot current mid-price for the paper order
    const mid = await fetchMidpoint(t.asset);
    const intendedPrice = mid ?? price;
    const intendedSize = size; // 1:1 mirror
    const intendedUsdc = intendedSize * intendedPrice;

    const { data: paperIns } = await admin.from("paper_orders").insert({
      user_id: cfg.user_id,
      detected_trade_id: detIns.id,
      side,
      asset_id: t.asset,
      market_id: t.conditionId ?? null,
      market_question: t.title ?? null,
      outcome: t.outcome ?? null,
      intended_price: intendedPrice,
      intended_size: intendedSize,
      intended_usdc: intendedUsdc,
      status: "simulated",
      note: mid == null ? "midpoint unavailable; used target's fill price" : null,
    }).select().single();

    // Auto-execute if enabled and within caps
    if (cfg.auto_execute && paperIns?.id) {
      const today = new Date().toISOString().slice(0, 10);
      const spent = cfg.spent_day === today ? Number(cfg.usdc_spent_today ?? 0) : 0;
      const withinPerTrade = intendedUsdc <= Number(cfg.max_usdc_per_trade ?? 0);
      const withinDaily = spent + intendedUsdc <= Number(cfg.daily_usdc_limit ?? 0);
      if (withinPerTrade && withinDaily) {
        try {
          const r = await fetch(`${SUPABASE_URL}/functions/v1/execute-order`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${SERVICE_ROLE}`,
            },
            body: JSON.stringify({ paper_order_id: paperIns.id, user_id: cfg.user_id }),
          });
          const j = await r.json().catch(() => ({}));
          if (!r.ok) console.error("auto-execute failed", j);
        } catch (e) {
          console.error("auto-execute exception", e);
        }
      } else {
        await admin.from("paper_orders").update({
          note: `Auto-execute skipped: ${!withinPerTrade ? "exceeds per-trade cap" : "exceeds daily cap"}`,
        }).eq("id", paperIns.id);
      }
    }

    // Cache market metadata
    await admin.from("markets_cache").upsert({
      asset_id: t.asset,
      market_id: t.conditionId ?? null,
      question: t.title ?? null,
      outcome: t.outcome ?? null,
      data: t as any,
      cached_at: new Date().toISOString(),
    });

    if (ts > maxTs) maxTs = ts;
  }

  await admin
    .from("config")
    .update({
      last_seen_ts: maxTs,
      last_polled_at: new Date().toISOString(),
    })
    .eq("user_id", cfg.user_id);

  // Keep only the 25 most recent trades & orders to avoid clutter
  const { data: keepTrades } = await admin
    .from("detected_trades")
    .select("id")
    .eq("user_id", cfg.user_id)
    .order("trade_ts", { ascending: false })
    .limit(25);
  const keepIds = (keepTrades ?? []).map((r: any) => r.id);
  if (keepIds.length > 0) {
    await admin
      .from("detected_trades")
      .delete()
      .eq("user_id", cfg.user_id)
      .not("id", "in", `(${keepIds.join(",")})`);
  }

  const { data: keepOrders } = await admin
    .from("paper_orders")
    .select("id")
    .eq("user_id", cfg.user_id)
    .order("created_at", { ascending: false })
    .limit(25);
  const keepOrderIds = (keepOrders ?? []).map((r: any) => r.id);
  if (keepOrderIds.length > 0) {
    await admin
      .from("paper_orders")
      .delete()
      .eq("user_id", cfg.user_id)
      .not("id", "in", `(${keepOrderIds.join(",")})`);
  }

  return { wallet, inserted, total: trades.length };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE);
  const url = new URL(req.url);
  const userIdParam = url.searchParams.get("user_id");

  try {
    let configsQuery = admin
      .from("config")
      .select("*")
      .not("target_wallet", "is", null);

    if (userIdParam) {
      configsQuery = configsQuery.eq("user_id", userIdParam);
    } else {
      configsQuery = configsQuery.eq("enabled", true);
    }

    const { data: configs, error } = await configsQuery;
    if (error) throw error;

    const results = [];
    for (const cfg of configs ?? []) {
      try {
        results.push(await processForUser(admin, cfg));
      } catch (e) {
        console.error("processForUser err", cfg.user_id, e);
        results.push({ user_id: cfg.user_id, error: String(e) });
      }
    }

    return new Response(JSON.stringify({ ok: true, results }), {
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
