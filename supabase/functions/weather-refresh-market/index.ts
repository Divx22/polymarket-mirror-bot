// Refreshes NOAA + ECMWF probability + Polymarket price for ONE market,
// computes a signal, and stores everything.
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
  temp_min_c: number | null;
  temp_max_c: number | null;
  precip_threshold_mm: number | null;
  event_time: string;
  polymarket_url: string | null;
  clob_token_id: string | null;
};

function pickHourly(times: string[], target: Date): number {
  // returns index of hour closest to target
  let best = 0;
  let bestDiff = Infinity;
  for (let i = 0; i < times.length; i++) {
    const d = Math.abs(new Date(times[i]).getTime() - target.getTime());
    if (d < bestDiff) {
      bestDiff = d;
      best = i;
    }
  }
  return best;
}

function probFromEnsemble(values: number[], predicate: (v: number) => boolean): number {
  if (!values.length) return 0;
  const hits = values.filter((v) => v != null && predicate(v)).length;
  return hits / values.length;
}

async function fetchOpenMeteo(
  model: "gfs_seamless" | "ecmwf_ifs025",
  lat: number,
  lon: number,
): Promise<{ time: string[]; t2m: number[]; precip: number[] }> {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&hourly=temperature_2m,precipitation&models=${model}&forecast_days=10&timezone=UTC`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`open-meteo ${model} ${r.status}`);
  const j = await r.json();
  return {
    time: j?.hourly?.time ?? [],
    t2m: j?.hourly?.temperature_2m ?? [],
    precip: j?.hourly?.precipitation ?? [],
  };
}

async function fetchEnsembleEcmwf(
  lat: number,
  lon: number,
): Promise<{ time: string[]; members: number[][]; precipMembers: number[][] }> {
  // ECMWF ensemble (51 members) for proper probability calculation
  const url =
    `https://ensemble-api.open-meteo.com/v1/ensemble?latitude=${lat}&longitude=${lon}` +
    `&hourly=temperature_2m,precipitation&models=ecmwf_ifs025&forecast_days=10&timezone=UTC`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`ecmwf-ensemble ${r.status}`);
  const j = await r.json();
  const time: string[] = j?.hourly?.time ?? [];
  const hourly = j?.hourly ?? {};
  const tempKeys = Object.keys(hourly).filter((k) => k.startsWith("temperature_2m"));
  const precipKeys = Object.keys(hourly).filter((k) => k.startsWith("precipitation"));
  // transpose member series → per-hour arrays
  const members: number[][] = time.map((_, i) => tempKeys.map((k) => hourly[k][i]));
  const precipMembers: number[][] = time.map((_, i) => precipKeys.map((k) => hourly[k][i]));
  return { time, members, precipMembers };
}

function computeProb(
  market: Market,
  hourly: { time: string[]; t2m?: number[]; precip?: number[] },
  ensemble?: { time: string[]; members: number[][]; precipMembers: number[][] },
): number {
  const target = new Date(market.event_time);
  const idxHourly = hourly.time.length ? pickHourly(hourly.time, target) : -1;

  if (market.condition_type === "temperature") {
    const lo = market.temp_min_c ?? -Infinity;
    const hi = market.temp_max_c ?? Infinity;
    const inRange = (v: number) => v >= lo && v <= hi;
    if (ensemble) {
      const idx = pickHourly(ensemble.time, target);
      return probFromEnsemble(ensemble.members[idx] ?? [], inRange);
    }
    // deterministic fallback: 1 if in-range, else estimate by distance (±2°C window)
    const v = hourly.t2m?.[idxHourly];
    if (v == null) return 0;
    if (inRange(v)) return 1;
    const dist = v < lo ? lo - v : v - hi;
    return Math.max(0, 1 - dist / 2);
  }

  if (market.condition_type === "rain") {
    const thr = market.precip_threshold_mm ?? 0.1;
    const wet = (v: number) => v >= thr;
    if (ensemble) {
      const idx = pickHourly(ensemble.time, target);
      return probFromEnsemble(ensemble.precipMembers[idx] ?? [], wet);
    }
    const v = hourly.precip?.[idxHourly];
    return v != null && wet(v) ? 1 : 0;
  }

  return 0;
}

async function fetchPolymarketPrice(
  url: string | null,
  tokenId: string | null,
): Promise<{ price: number | null; tokenId: string | null }> {
  let token = tokenId;
  if (!token && url) {
    // Try to derive slug from URL and resolve via gamma-api
    const m = url.match(/polymarket\.com\/event\/[^/]+\/([^/?#]+)/) ||
      url.match(/polymarket\.com\/market\/([^/?#]+)/);
    const slug = m?.[1];
    if (slug) {
      try {
        const r = await fetch(`https://gamma-api.polymarket.com/markets?slug=${slug}`);
        if (r.ok) {
          const j = await r.json();
          const market = Array.isArray(j) ? j[0] : j?.markets?.[0];
          const tokens = market?.clobTokenIds
            ? JSON.parse(market.clobTokenIds)
            : market?.outcomes_tokens ?? [];
          if (Array.isArray(tokens) && tokens.length) token = String(tokens[0]);
        }
      } catch (_) { /* ignore */ }
    }
  }
  if (!token) return { price: null, tokenId: null };
  try {
    const r = await fetch(`https://clob.polymarket.com/midpoint?token_id=${token}`);
    if (!r.ok) return { price: null, tokenId: token };
    const j = await r.json();
    const p = Number(j?.mid);
    return { price: Number.isFinite(p) ? p : null, tokenId: token };
  } catch {
    return { price: null, tokenId: token };
  }
}

function confidenceFor(agreement: number): "high" | "medium" | "low" {
  if (agreement > 0.85) return "high";
  if (agreement >= 0.7) return "medium";
  return "low";
}

function suggestedSize(edge: number, agreement: number): number {
  const abs = Math.abs(edge);
  if (abs < 0.07) return 0;
  let base = 0;
  if (abs < 0.1) base = 1;
  else if (abs < 0.15) base = 2;
  else base = 3;
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
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json().catch(() => ({}));
    const marketId = body?.market_id;
    if (!marketId) {
      return new Response(JSON.stringify({ error: "market_id required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: market, error: mErr } = await supabase
      .from("weather_markets")
      .select("*")
      .eq("id", marketId)
      .maybeSingle();
    if (mErr || !market) throw new Error(mErr?.message ?? "market not found");

    const m = market as Market;

    // 1) NOAA proxy via open-meteo GFS (deterministic)
    const noaa = await fetchOpenMeteo("gfs_seamless", m.latitude, m.longitude);
    const pNoaa = computeProb(m, noaa);

    // 2) ECMWF ensemble
    let pEcmwf = 0;
    try {
      const ens = await fetchEnsembleEcmwf(m.latitude, m.longitude);
      pEcmwf = computeProb(m, { time: [] }, ens);
    } catch {
      const ec = await fetchOpenMeteo("ecmwf_ifs025", m.latitude, m.longitude);
      pEcmwf = computeProb(m, ec);
    }

    // 3) Polymarket price
    const { price: pMarket, tokenId } = await fetchPolymarketPrice(
      m.polymarket_url,
      m.clob_token_id,
    );

    // 4) compute final
    const pFinal = 0.55 * pEcmwf + 0.45 * pNoaa;
    const agreement = 1 - Math.abs(pNoaa - pEcmwf);
    const edge = pMarket != null ? pFinal - pMarket : null;
    const size = edge != null ? suggestedSize(edge, agreement) : 0;
    const confidence = confidenceFor(agreement);

    // 5) persist
    const now = new Date().toISOString();
    await supabase.from("weather_forecasts").upsert(
      [
        { market_id: m.id, user_id: m.user_id, source: "NOAA", probability: pNoaa, last_updated: now },
        { market_id: m.id, user_id: m.user_id, source: "ECMWF", probability: pEcmwf, last_updated: now },
      ],
      { onConflict: "market_id,source" },
    );

    await supabase.from("weather_signals").insert({
      market_id: m.id,
      user_id: m.user_id,
      p_noaa: pNoaa,
      p_ecmwf: pEcmwf,
      p_final: pFinal,
      agreement,
      p_market: pMarket,
      edge,
      suggested_size_percent: size,
      confidence_level: confidence,
    });

    const updates: Record<string, unknown> = { updated_at: now };
    if (pMarket != null) updates.polymarket_price = pMarket;
    if (tokenId && tokenId !== m.clob_token_id) updates.clob_token_id = tokenId;
    await supabase.from("weather_markets").update(updates).eq("id", m.id);

    return new Response(
      JSON.stringify({
        ok: true,
        p_noaa: pNoaa,
        p_ecmwf: pEcmwf,
        p_final: pFinal,
        agreement,
        p_market: pMarket,
        edge,
        suggested_size_percent: size,
        confidence_level: confidence,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    return new Response(JSON.stringify({ error: String((e as Error).message ?? e) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
