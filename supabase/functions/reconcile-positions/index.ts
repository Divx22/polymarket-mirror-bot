// Position-delta mirroring engine — GROUND TRUTH version.
// Source of target's positions: Polymarket Data API /positions?user=<wallet>
// (replaces the old "sum detected_trades" approximation, which missed
// pre-poll history, redemptions, merges, and transfers).
//
// For each asset the target wallet holds:
//   desired_mirror = target.size * config.mirror_ratio
//   delta = desired_mirror - our mirror_shares
//   if |delta * curPrice| >= $1 and within caps → place marketable FOK order.
//
// Also sells down any mirror position whose target has dropped to 0.
import "npm:tslib@2.6.2";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { ClobClient, Side, OrderType } from "npm:@polymarket/clob-client@4.21.0";
import { Wallet } from "npm:ethers@5.7.2";

const POLY_PROXY_SIG = 1;
const CLOB_HOST = "https://clob.polymarket.com";
const DATA_API = "https://data-api.polymarket.com";
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

type TargetPosition = {
  asset: string;
  size: number;
  avgPrice: number;
  curPrice: number;
  currentValue: number;
  cashPnl: number;
  percentPnl: number;
  conditionId: string;
  title: string;
  outcome: string;
};

async function fetchTargetPositions(wallet: string): Promise<TargetPosition[]> {
  const url = `${DATA_API}/positions?user=${wallet.toLowerCase()}&sizeThreshold=0.01&limit=500`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`positions API ${r.status}`);
  const j = await r.json();
  return Array.isArray(j) ? j : [];
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

  // GROUND TRUTH: fetch target's actual open positions
  let targetPositions: TargetPosition[];
  try {
    targetPositions = await fetchTargetPositions(cfg.target_wallet);
  } catch (e: any) {
    return { ...result, errors: [{ stage: "fetchPositions", error: String(e?.message ?? e) }] };
  }

  const targetByAsset = new Map<string, TargetPosition>();
  for (const p of targetPositions) targetByAsset.set(String(p.asset), p);

  // Pull our existing mirror positions so we can also down-size the ones
  // the target has fully exited (and aren't in the API response anymore).
  const { data: existingMirror } = await admin
    .from("positions")
    .select("asset_id, mirror_shares, market_id, market_question, outcome, last_target_price")
    .eq("user_id", userId);

  // Union of assets we need to consider
  const assetSet = new Set<string>();
  for (const p of targetPositions) assetSet.add(String(p.asset));
  for (const row of existingMirror ?? []) {
    if (Math.abs(Number(row.mirror_shares ?? 0)) > 1e-6) assetSet.add(String(row.asset_id));
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

  for (const assetId of assetSet) {
    result.scanned++;
    const tp = targetByAsset.get(assetId);
    const targetShares = tp ? Number(tp.size) : 0;
    const desiredMirror = targetShares * ratio;

    const existing = (existingMirror ?? []).find((r: any) => String(r.asset_id) === assetId);
    const currentMirror = Number(existing?.mirror_shares ?? 0);
    const delta = desiredMirror - currentMirror;
    const price = tp?.curPrice ?? Number(existing?.last_target_price ?? 0) ?? 0;
    const usdcDelta = Math.abs(delta) * (price || 0);

    // Persist target snapshot regardless of whether we trade
    await admin.from("positions").upsert({
      user_id: userId,
      asset_id: assetId,
      market_id: tp?.conditionId ?? existing?.market_id ?? null,
      market_question: tp?.title ?? existing?.market_question ?? null,
      outcome: tp?.outcome ?? existing?.outcome ?? null,
      target_shares: targetShares,
      mirror_shares: currentMirror,
      last_target_price: price || null,
      last_reconciled_at: new Date().toISOString(),
    }, { onConflict: "user_id,asset_id" });

    if (!price || usdcDelta < MIN_USDC) {
      result.skipped.push({ assetId, reason: `delta $${usdcDelta.toFixed(3)} < $1` });
      continue;
    }
    if (!cfg.auto_execute) {
      result.skipped.push({ assetId, reason: "auto_execute off — delta logged only" });
      continue;
    }

    let orderUsdc = Math.min(usdcDelta, perTradeCap);
    if (spent + orderUsdc > dailyCap) {
      orderUsdc = Math.max(0, dailyCap - spent);
    }
    if (orderUsdc < MIN_USDC) {
      result.skipped.push({ assetId, reason: "would breach daily cap" });
      continue;
    }
    let orderSize = orderUsdc / price;
    const side = delta > 0 ? Side.BUY : Side.SELL;

    if (side === Side.SELL && orderSize > currentMirror) {
      orderSize = Math.max(0, currentMirror);
      orderUsdc = orderSize * price;
      if (orderUsdc < MIN_USDC) {
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
          market_id: tp?.conditionId ?? null,
          market_question: tp?.title ?? null,
          outcome: tp?.outcome ?? null,
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
        market_id: tp?.conditionId ?? null,
        market_question: tp?.title ?? null,
        outcome: tp?.outcome ?? null,
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
