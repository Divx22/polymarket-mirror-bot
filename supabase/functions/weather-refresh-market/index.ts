// Refresh probabilities + prices for ALL outcomes of a discrete-temperature market.
// Distribution model: ECMWF 51-member ensemble histogram; NOAA used for agreement check.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

type Market = {
  id: string;
  user_id: string;
  latitude: number;
  longitude: number;
  condition_type: string;
  event_time: string;
};

type Outcome = {
  id: string;
  label: string;
  bucket_min_c: number | null;
  bucket_max_c: number | null;
  clob_token_id: string | null;
  display_order: number;
};

function pickHourly(times: string[], target: Date): number {
  let best = 0; let bestDiff = Infinity;
  for (let i = 0; i < times.length; i++) {
    const d = Math.abs(new Date(times[i]).getTime() - target.getTime());
    if (d < bestDiff) { bestDiff = d; best = i; }
  }
  return best;
}

async function fetchEnsemble(lat: number, lon: number) {
  const url =
    `https://ensemble-api.open-meteo.com/v1/ensemble?latitude=${lat}&longitude=${lon}` +
    `&hourly=temperature_2m&models=ecmwf_ifs025&forecast_days=10&timezone=UTC`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`ecmwf-ensemble ${r.status}`);
  const j = await r.json();
  const time: string[] = j?.hourly?.time ?? [];
  const hourly = j?.hourly ?? {};
  const tempKeys = Object.keys(hourly).filter((k) => k.startsWith("temperature_2m"));
  const members: number[][] = time.map((_, i) => tempKeys.map((k) => hourly[k][i]));
  return { time, members };
}

async function fetchGfs(lat: number, lon: number) {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&hourly=temperature_2m&models=gfs_seamless&forecast_days=10&timezone=UTC`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`gfs ${r.status}`);
  const j = await r.json();
  return { time: j?.hourly?.time ?? [], temp: j?.hourly?.temperature_2m ?? [] };
}

// For "highest temperature on day X" markets, take the daily MAX across hours,
// not the value at a single hour. Window = 24h around event_time.
function dailyMaxIndices(times: string[], target: Date): number[] {
  const dayMs = 24 * 60 * 60 * 1000;
  const out: number[] = [];
  const t = target.getTime();
  for (let i = 0; i < times.length; i++) {
    const d = new Date(times[i]).getTime();
    if (d >= t - dayMs / 2 && d <= t + dayMs / 2) out.push(i);
  }
  return out;
}

// Per-member daily max temp → returns array of length = #members
function memberDailyMax(members: number[][], idxs: number[]): number[] {
  if (!members.length || !idxs.length) return [];
  const numMembers = members[0].length;
  const result = new Array(numMembers).fill(-Infinity);
  for (const i of idxs) {
    const row = members[i];
    for (let m = 0; m < numMembers; m++) {
      const v = row[m];
      if (v != null && v > result[m]) result[m] = v;
    }
  }
  return result.filter((v) => Number.isFinite(v));
}

function probInBucket(values: number[], min: number | null, max: number | null): number {
  if (!values.length) return 0;
  const lo = min ?? -Infinity;
  const hi = max ?? Infinity;
  const hits = values.filter((v) => v >= lo && v <= hi).length;
  return hits / values.length;
}

async function fetchPrice(tokenId: string): Promise<number | null> {
  try {
    const r = await fetch(`https://clob.polymarket.com/midpoint?token_id=${tokenId}`);
    if (!r.ok) return null;
    const j = await r.json();
    const p = Number(j?.mid);
    return Number.isFinite(p) ? p : null;
  } catch { return null; }
}

function confidenceFor(agreement: number): "high" | "medium" | "low" {
  if (agreement > 0.85) return "high";
  if (agreement >= 0.7) return "medium";
  return "low";
}

function suggestedSize(edge: number, agreement: number): number {
  const abs = Math.abs(edge);
  if (abs < 0.07) return 0;
  let base = 1;
  if (abs >= 0.15) base = 3;
  else if (abs >= 0.1) base = 2;
  return Number((base * agreement).toFixed(2));
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const auth = req.headers.get("Authorization") ?? "";
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: auth } } },
    );
    const { data: userRes } = await supabase.auth.getUser();
    if (!userRes?.user) {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json().catch(() => ({}));
    const marketId = body?.market_id;
    if (!marketId) {
      return new Response(JSON.stringify({ error: "market_id required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: market, error: mErr } = await supabase
      .from("weather_markets").select("*").eq("id", marketId).maybeSingle();
    if (mErr || !market) throw new Error(mErr?.message ?? "market not found");
    const m = market as Market;

    const { data: outs, error: oErr } = await supabase
      .from("weather_outcomes").select("*").eq("market_id", m.id).order("display_order");
    if (oErr) throw new Error(oErr.message);
    const outcomes = (outs ?? []) as Outcome[];
    if (!outcomes.length) throw new Error("no outcomes for this market");

    const target = new Date(m.event_time);

    // Fetch ensemble + GFS
    const [ens, gfs] = await Promise.all([
      fetchEnsemble(m.latitude, m.longitude),
      fetchGfs(m.latitude, m.longitude).catch(() => ({ time: [] as string[], temp: [] as number[] })),
    ]);

    // For "highest temp on day" markets, use daily-max distribution
    const ensIdxs = dailyMaxIndices(ens.time, target);
    const ensValues = memberDailyMax(ens.members, ensIdxs);

    // GFS deterministic daily max
    const gfsIdxs = dailyMaxIndices(gfs.time, target);
    let gfsMax: number | null = null;
    if (gfsIdxs.length) {
      gfsMax = -Infinity;
      for (const i of gfsIdxs) {
        const v = gfs.temp[i];
        if (v != null && v > gfsMax) gfsMax = v;
      }
      if (!Number.isFinite(gfsMax)) gfsMax = null;
    }

    // Compute distributions
    // IMPORTANT: P_model = ECMWF ensemble only. GFS is a single deterministic
    // scenario, not a probability distribution — using it to *blend* probabilities
    // artificially inflates confidence. Instead we use GFS-vs-ECMWF agreement
    // purely as a confidence signal (see `agreement` below).
    const enriched = await Promise.all(
      outcomes.map(async (o) => {
        const pEcmwf = probInBucket(ensValues, o.bucket_min_c, o.bucket_max_c);
        const pNoaa = gfsMax != null
          ? ((gfsMax >= (o.bucket_min_c ?? -Infinity) && gfsMax <= (o.bucket_max_c ?? Infinity)) ? 1 : 0)
          : pEcmwf;
        const pModel = pEcmwf; // ECMWF only — no blending
        const price = o.clob_token_id ? await fetchPrice(o.clob_token_id) : null;
        const edge = price != null ? pModel - price : null;
        return { o, pEcmwf, pNoaa, pModel, price, edge };
      })
    );

    // Normalize ECMWF probabilities to sum to 1 across outcomes (handles bucket overlap/gaps)
    const sumEc = enriched.reduce((s, x) => s + x.pEcmwf, 0);
    if (sumEc > 0) {
      for (const x of enriched) {
        x.pEcmwf = x.pEcmwf / sumEc;
        x.pModel = x.pEcmwf;
      }
    }
    // Recompute edges with normalized probs
    for (const x of enriched) {
      x.edge = x.price != null ? x.pModel - x.price : null;
    }

    // Agreement: 1 - sum of |p_ecmwf - p_noaa| / 2 (total variation distance)
    // For NOAA-as-binary, build a normalized noaa distribution
    const sumNoaa = enriched.reduce((s, x) => s + x.pNoaa, 0);
    if (sumNoaa > 0) {
      for (const x of enriched) x.pNoaa = x.pNoaa / sumNoaa;
    }
    const tvd = enriched.reduce((s, x) => s + Math.abs(x.pEcmwf - x.pNoaa), 0) / 2;
    const agreement = Math.max(0, 1 - tvd);
    const confidence = confidenceFor(agreement);

    // Persist per-outcome updates + suggested sizes
    let bestEdge = -Infinity;
    let bestLabel: string | null = null;
    let bestSize = 0;
    const distribution: any[] = [];

    for (const x of enriched) {
      const size = x.edge != null ? suggestedSize(x.edge, agreement) : 0;
      await supabase.from("weather_outcomes").update({
        p_ecmwf: x.pEcmwf,
        p_noaa: x.pNoaa,
        p_model: x.pModel,
        polymarket_price: x.price,
        edge: x.edge,
        suggested_size_percent: size,
      }).eq("id", x.o.id);

      distribution.push({
        label: x.o.label,
        p_model: x.pModel,
        p_market: x.price,
        edge: x.edge,
        suggested_size_percent: size,
      });

      if (x.edge != null && x.edge > bestEdge) {
        bestEdge = x.edge;
        bestLabel = x.o.label;
        bestSize = size;
      }
    }

    await supabase.from("weather_signals").insert({
      market_id: m.id,
      user_id: m.user_id,
      agreement,
      confidence_level: confidence,
      best_outcome_label: bestLabel,
      best_edge: Number.isFinite(bestEdge) ? bestEdge : null,
      best_suggested_size_percent: bestSize,
      distribution,
    });

    await supabase.from("weather_markets").update({ updated_at: new Date().toISOString() }).eq("id", m.id);

    return new Response(JSON.stringify({
      ok: true,
      agreement,
      confidence_level: confidence,
      best_outcome_label: bestLabel,
      best_edge: Number.isFinite(bestEdge) ? bestEdge : null,
      best_suggested_size_percent: bestSize,
      distribution,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String((e as Error).message ?? e) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
