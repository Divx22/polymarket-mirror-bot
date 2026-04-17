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

async function fetchTrades(wallet: string): Promise<Trade[]> {
  const url = `${DATA_API}/trades?user=${wallet}&limit=50`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`data-api ${r.status}: ${await r.text()}`);
  const data = await r.json();
  return Array.isArray(data) ? data : data.data ?? [];
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
    const usdc = size * price;

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
        raw: t as any,
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

    await admin.from("paper_orders").insert({
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
    });

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
