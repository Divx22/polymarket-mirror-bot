// Refresh probabilities + prices for ALL outcomes of a discrete-temperature market.
// Distribution model: BLENDED ENSEMBLE — ECMWF IFS + ECMWF AIFS (ML) + GFS GEFS + GraphCast (ML).
// US cities additionally pulled from official NOAA NWS API (api.weather.gov) — Polymarket's settlement source.
// Bias correction: subtracts mean recent forecast error per (station, model) before bucketing.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

type Market = {
  id: string;
  user_id: string;
  city: string;
  latitude: number;
  longitude: number;
  condition_type: string;
  event_time: string;
};

type Station = {
  city: string;
  station_name: string;
  station_code: string;
  latitude: number;
  longitude: number;
  timezone: string;
};

type Outcome = {
  id: string;
  label: string;
  bucket_min_c: number | null;
  bucket_max_c: number | null;
  clob_token_id: string | null;
  display_order: number;
};

function localYMD(d: Date, timezone: string): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
  });
  const parts = fmt.formatToParts(d);
  const y = parts.find((p) => p.type === "year")!.value;
  const m = parts.find((p) => p.type === "month")!.value;
  const day = parts.find((p) => p.type === "day")!.value;
  return `${y}-${m}-${day}`;
}

// ---------- Open-Meteo fetchers (timezone-aware) ----------
async function fetchOpenMeteoModel(
  baseUrl: string, lat: number, lon: number, timezone: string, model: string,
): Promise<{ time: string[]; temp: number[] }> {
  const url =
    `${baseUrl}?latitude=${lat}&longitude=${lon}` +
    `&hourly=temperature_2m&models=${model}&forecast_days=10` +
    `&timezone=${encodeURIComponent(timezone)}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${model} ${r.status}`);
  const j = await r.json();
  return { time: j?.hourly?.time ?? [], temp: j?.hourly?.temperature_2m ?? [] };
}

async function fetchEnsemble(
  lat: number, lon: number, timezone: string, model: string,
): Promise<{ time: string[]; members: number[][] }> {
  const url =
    `https://ensemble-api.open-meteo.com/v1/ensemble?latitude=${lat}&longitude=${lon}` +
    `&hourly=temperature_2m&models=${model}&forecast_days=10` +
    `&timezone=${encodeURIComponent(timezone)}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${model} ${r.status}`);
  const j = await r.json();
  const time: string[] = j?.hourly?.time ?? [];
  const hourly = j?.hourly ?? {};
  const tempKeys = Object.keys(hourly).filter((k) => k.startsWith("temperature_2m"));
  const members: number[][] = time.map((_, i) => tempKeys.map((k) => hourly[k][i]));
  return { time, members };
}

// ---------- NOAA NWS official API (US only, Polymarket's settlement source) ----------
async function fetchNwsHourly(lat: number, lon: number): Promise<{ validTime: string; tempC: number }[] | null> {
  try {
    const headers = { "User-Agent": "polymarket-edge-app (contact@example.com)", Accept: "application/geo+json" };
    const pointRes = await fetch(`https://api.weather.gov/points/${lat.toFixed(4)},${lon.toFixed(4)}`, { headers });
    if (!pointRes.ok) return null;
    const point = await pointRes.json();
    const forecastUrl = point?.properties?.forecastHourly;
    if (!forecastUrl) return null;
    const fRes = await fetch(forecastUrl, { headers });
    if (!fRes.ok) return null;
    const fJson = await fRes.json();
    const periods: any[] = fJson?.properties?.periods ?? [];
    return periods.map((p) => ({
      validTime: p.startTime as string,
      tempC: p.temperatureUnit === "F" ? ((Number(p.temperature) - 32) * 5) / 9 : Number(p.temperature),
    })).filter((x) => Number.isFinite(x.tempC));
  } catch { return null; }
}

function nwsDailyMaxForLocalDay(
  hours: { validTime: string; tempC: number }[], timezone: string, localDay: string,
): number | null {
  let max = -Infinity;
  for (const h of hours) {
    const ymd = localYMD(new Date(h.validTime), timezone);
    if (ymd === localDay && h.tempC > max) max = h.tempC;
  }
  return Number.isFinite(max) ? max : null;
}

// ---------- Bias correction ----------
async function getBias(
  supabase: ReturnType<typeof createClient>, stationCode: string | null, modelName: string,
): Promise<number> {
  if (!stationCode) return 0;
  const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
  const { data } = await supabase
    .from("forecast_bias")
    .select("error_c")
    .eq("station_code", stationCode)
    .eq("model_name", modelName)
    .gte("valid_at", since)
    .limit(500);
  const rows = (data ?? []) as { error_c: number }[];
  if (!rows.length) return 0;
  const mean = rows.reduce((s, r) => s + Number(r.error_c), 0) / rows.length;
  return Number.isFinite(mean) ? mean : 0;
}

// ---------- Helpers ----------
function localDayIndices(times: string[], localYmd: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < times.length; i++) if (times[i].startsWith(localYmd)) out.push(i);
  return out;
}

function memberDailyMax(members: number[][], idxs: number[], biasC: number): number[] {
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
  return result.filter((v) => Number.isFinite(v)).map((v) => v - biasC);
}

function deterministicDailyMax(times: string[], temps: number[], localYmd: string, biasC: number): number | null {
  let max = -Infinity;
  for (let i = 0; i < times.length; i++) {
    if (times[i].startsWith(localYmd) && temps[i] != null && temps[i] > max) max = temps[i];
  }
  return Number.isFinite(max) ? max - biasC : null;
}

function probInBucket(values: number[], min: number | null, max: number | null): number {
  if (!values.length) return 0;
  const lo = min ?? -Infinity;
  const hi = max ?? Infinity;
  return values.filter((v) => v >= lo && v <= hi).length / values.length;
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

// Order book — returns realistic fill prices, not midpoint.
// best_ask = price you'd pay to BUY YES; best_bid = price you'd receive to SELL.
// Edge calculation should use best_ask for BUY signals (you're hitting the ask).
async function fetchBook(tokenId: string): Promise<{ best_bid: number | null; best_ask: number | null; ask_size: number | null; bid_size: number | null } | null> {
  try {
    const r = await fetch(`https://clob.polymarket.com/book?token_id=${tokenId}`);
    if (!r.ok) return null;
    const j = await r.json();
    const asks: any[] = Array.isArray(j?.asks) ? j.asks : [];
    const bids: any[] = Array.isArray(j?.bids) ? j.bids : [];
    // Polymarket returns asks ascending? Sort defensively.
    const asksSorted = asks.map((a) => ({ p: Number(a.price), s: Number(a.size) }))
      .filter((a) => Number.isFinite(a.p)).sort((a, b) => a.p - b.p);
    const bidsSorted = bids.map((b) => ({ p: Number(b.price), s: Number(b.size) }))
      .filter((b) => Number.isFinite(b.p)).sort((a, b) => b.p - a.p);
    return {
      best_ask: asksSorted[0]?.p ?? null,
      ask_size: asksSorted[0]?.s ?? null,
      best_bid: bidsSorted[0]?.p ?? null,
      bid_size: bidsSorted[0]?.s ?? null,
    };
  } catch { return null; }
}

// METAR observations from aviationweather.gov (free, no key).
// Returns hourly temps for the last `hours` hours. Used to replace already-
// elapsed forecast hours with actual measurements when the event is today.
async function fetchMetar(stationCode: string | null, hours: number): Promise<{ time: string; tempC: number }[]> {
  if (!stationCode) return [];
  try {
    const url = `https://aviationweather.gov/api/data/metar?ids=${stationCode}&format=json&hours=${hours}`;
    const r = await fetch(url);
    if (!r.ok) return [];
    const arr: any[] = await r.json();
    return (arr ?? [])
      .map((m) => ({ time: m?.reportTime as string, tempC: Number(m?.temp) }))
      .filter((x) => x.time && Number.isFinite(x.tempC));
  } catch { return []; }
}

// Per-station per-hour MAX of METAR readings within the local day so far.
// Returns the OBSERVED max (already-happened) — we use this as a floor so
// the daily-max can never go BELOW what's already been measured.
function metarObservedMaxForLocalDay(
  metars: { time: string; tempC: number }[], timezone: string, localDay: string,
): number | null {
  let max = -Infinity;
  for (const m of metars) {
    if (localYMD(new Date(m.time), timezone) === localDay && m.tempC > max) max = m.tempC;
  }
  return Number.isFinite(max) ? max : null;
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

// US bounding box check (rough — covers contiguous + AK + HI)
function isUS(lat: number, lon: number): boolean {
  return (lat >= 24 && lat <= 50 && lon >= -125 && lon <= -66) ||
         (lat >= 50 && lat <= 72 && lon >= -170 && lon <= -130) ||
         (lat >= 18 && lat <= 23 && lon >= -161 && lon <= -154);
}

// ---------- NOAA NBM (National Blend of Models) — second US source ----------
// Independent of Open-Meteo. NWS gridpoints endpoint serves NBM-blended hourly
// temps for any US lat/lon. Free, no key.
async function fetchNbmHourly(lat: number, lon: number): Promise<{ validTime: string; tempC: number }[] | null> {
  try {
    const headers = { "User-Agent": "polymarket-edge-app (contact@example.com)", Accept: "application/geo+json" };
    const pointRes = await fetch(`https://api.weather.gov/points/${lat.toFixed(4)},${lon.toFixed(4)}`, { headers });
    if (!pointRes.ok) return null;
    const point = await pointRes.json();
    const gridUrl: string | undefined = point?.properties?.forecastGridData;
    if (!gridUrl) return null;
    const gRes = await fetch(gridUrl, { headers });
    if (!gRes.ok) return null;
    const gJson = await gRes.json();
    // temperature.values is an array of { validTime: "2024-...T18:00:00+00:00/PT1H", value: <celsius> }
    const values: any[] = gJson?.properties?.temperature?.values ?? [];
    const out: { validTime: string; tempC: number }[] = [];
    for (const v of values) {
      const vt: string = v?.validTime ?? "";
      const [start, durStr] = vt.split("/");
      if (!start) continue;
      const tempC = Number(v?.value);
      if (!Number.isFinite(tempC)) continue;
      // Expand interval into hourly samples (PT1H, PT3H, etc.)
      const hours = (() => {
        const m = /PT(\d+)H/.exec(durStr ?? "PT1H");
        return m ? Math.max(1, Math.min(24, parseInt(m[1], 10))) : 1;
      })();
      const startMs = Date.parse(start);
      for (let i = 0; i < hours; i++) {
        out.push({ validTime: new Date(startMs + i * 3600 * 1000).toISOString(), tempC });
      }
    }
    return out;
  } catch { return null; }
}

// ---------- Visual Crossing — global sanity-check oracle ----------
// Free tier: 1000 records/day. Returns hourly temps for next 10 days.
async function fetchVisualCrossing(lat: number, lon: number, localDay: string): Promise<number | null> {
  const key = Deno.env.get("VISUAL_CROSSING_API_KEY");
  if (!key) return null;
  try {
    const url = `https://weather.visualcrossing.com/VisualCrossingWebServices/rest/services/timeline/${lat},${lon}/${localDay}/${localDay}?unitGroup=metric&include=days&elements=tempmax&key=${key}&contentType=json`;
    const r = await fetch(url);
    if (!r.ok) return null;
    const j = await r.json();
    const tmax = Number(j?.days?.[0]?.tempmax);
    return Number.isFinite(tmax) ? tmax : null;
  } catch { return null; }
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

    const { data: stationRow } = await supabase
      .from("stations").select("*").ilike("city", m.city).maybeSingle();
    const station: Station | null = (stationRow as Station | null) ?? null;

    // Per-market resolution station override takes precedence over the city default.
    // This lets users target the EXACT station Polymarket settles on
    // (e.g. NYC-Central Park vs NYC-LaGuardia) instead of the city's airport.
    const overrideCode = (market as any).resolution_station_code as string | null;
    const overrideLat = (market as any).resolution_lat as number | null;
    const overrideLon = (market as any).resolution_lon as number | null;
    const hasOverride = overrideCode && overrideLat != null && overrideLon != null;

    const lat = hasOverride ? Number(overrideLat) : (station?.latitude ?? m.latitude);
    const lon = hasOverride ? Number(overrideLon) : (station?.longitude ?? m.longitude);
    const timezone = station?.timezone ?? "UTC";
    const stationCode = hasOverride ? overrideCode : (station?.station_code ?? null);
    const localDay = localYMD(new Date(m.event_time), timezone);
    const usMarket = isUS(Number(lat), Number(lon));

    // Pre-fetch bias offsets (mean error over last 14d) per (station, model).
    // We SUBTRACT this from forecasts so a model that's been running 1.5°C hot
    // on this station gets calibrated down by 1.5°C before we bucket probabilities.
    const [biasEcmwf, biasAifs, biasGfs, biasGraphcast, biasNws] = await Promise.all([
      getBias(supabase, stationCode, "ecmwf_ifs025"),
      getBias(supabase, stationCode, "ecmwf_aifs025"),
      getBias(supabase, stationCode, "gfs_seamless"),
      getBias(supabase, stationCode, "graphcast"),
      getBias(supabase, stationCode, "nws"),
    ]);

    // Fetch all forecasts in parallel. Each .catch(null) so a single model
    // outage doesn't kill the whole refresh. METAR pulled for any station
    // (works globally — ICAO codes); only used if event is today/tomorrow.
    const eventLocalDay = localDay;
    const todayLocal = localYMD(new Date(), timezone);
    const useMetar = eventLocalDay <= todayLocal; // event is today or in the past
    const [ecmwfEns, gefs, ifsDet, aifsDet, graphcastDet, nwsHours, nbmHours, vcMax, metars] = await Promise.all([
      fetchEnsemble(lat, lon, timezone, "ecmwf_ifs025").catch(() => null),
      fetchEnsemble(lat, lon, timezone, "gfs025").catch(() => null),
      fetchOpenMeteoModel("https://api.open-meteo.com/v1/forecast", lat, lon, timezone, "ecmwf_ifs025").catch(() => null),
      fetchOpenMeteoModel("https://api.open-meteo.com/v1/forecast", lat, lon, timezone, "ecmwf_aifs025").catch(() => null),
      fetchOpenMeteoModel("https://api.open-meteo.com/v1/forecast", lat, lon, timezone, "graphcast").catch(() => null),
      usMarket ? fetchNwsHourly(Number(lat), Number(lon)) : Promise.resolve(null),
      usMarket ? fetchNbmHourly(Number(lat), Number(lon)).catch(() => null) : Promise.resolve(null),
      fetchVisualCrossing(Number(lat), Number(lon), localDay).catch(() => null),
      useMetar ? fetchMetar(stationCode, 30) : Promise.resolve([] as { time: string; tempC: number }[]),
    ]);

    // METAR floor: max temp observed so far today at the station. The daily
    // max can NEVER be lower than this — it's already happened. Massive
    // variance reduction late in the day.
    const metarFloor = useMetar ? metarObservedMaxForLocalDay(metars, timezone, localDay) : null;
    const applyFloor = (vals: number[]) =>
      metarFloor != null ? vals.map((v) => Math.max(v, metarFloor)) : vals;

    const ensembleValues: number[] = [];
    if (ecmwfEns) {
      const idxs = localDayIndices(ecmwfEns.time, localDay);
      ensembleValues.push(...applyFloor(memberDailyMax(ecmwfEns.members, idxs, biasEcmwf)));
    }
    if (gefs) {
      const idxs = localDayIndices(gefs.time, localDay);
      ensembleValues.push(...applyFloor(memberDailyMax(gefs.members, idxs, biasGfs)));
    }
    const aifsMax = aifsDet ? deterministicDailyMax(aifsDet.time, aifsDet.temp, localDay, biasAifs) : null;
    if (aifsMax != null) ensembleValues.push(metarFloor != null ? Math.max(aifsMax, metarFloor) : aifsMax);
    const graphcastMax = graphcastDet ? deterministicDailyMax(graphcastDet.time, graphcastDet.temp, localDay, biasGraphcast) : null;
    if (graphcastMax != null) ensembleValues.push(metarFloor != null ? Math.max(graphcastMax, metarFloor) : graphcastMax);

    const ifsMaxRaw = ifsDet ? deterministicDailyMax(ifsDet.time, ifsDet.temp, localDay, biasEcmwf) : null;
    const ifsMax = ifsMaxRaw != null && metarFloor != null ? Math.max(ifsMaxRaw, metarFloor) : ifsMaxRaw;
    const nwsMaxRaw = nwsHours && stationCode ? (() => {
      const v = nwsDailyMaxForLocalDay(nwsHours, timezone, localDay);
      return v != null ? v - biasNws : null;
    })() : null;
    const nwsMax = nwsMaxRaw != null && metarFloor != null ? Math.max(nwsMaxRaw, metarFloor) : nwsMaxRaw;

    // NBM (second independent US source): take daily max from gridpoint hourly temps.
    const nbmMaxRaw = nbmHours
      ? (() => {
          let max = -Infinity;
          for (const h of nbmHours) {
            if (localYMD(new Date(h.validTime), timezone) === localDay && h.tempC > max) max = h.tempC;
          }
          return Number.isFinite(max) ? max : null;
        })()
      : null;
    const nbmMax = nbmMaxRaw != null && metarFloor != null ? Math.max(nbmMaxRaw, metarFloor) : nbmMaxRaw;

    // Visual Crossing global oracle (already a daily max).
    const vcDailyMax = vcMax != null && metarFloor != null ? Math.max(vcMax, metarFloor) : vcMax;

    // Provider-disagreement detection: compare reference (NWS or IFS) to the
    // independent providers (NBM + VC). If any disagrees by >2°C, flag it —
    // signals correlated-failure risk in our primary pipe.
    const DISAGREEMENT_THRESHOLD_C = 2.0;
    const refForDisagreement = nwsMax ?? ifsMax;
    const disagreements: { source: string; delta_c: number; value_c: number }[] = [];
    if (refForDisagreement != null) {
      if (nbmMax != null && Math.abs(nbmMax - refForDisagreement) > DISAGREEMENT_THRESHOLD_C) {
        disagreements.push({ source: "nbm", delta_c: Number((nbmMax - refForDisagreement).toFixed(2)), value_c: Number(nbmMax.toFixed(2)) });
      }
      if (vcDailyMax != null && Math.abs(vcDailyMax - refForDisagreement) > DISAGREEMENT_THRESHOLD_C) {
        disagreements.push({ source: "visual_crossing", delta_c: Number((vcDailyMax - refForDisagreement).toFixed(2)), value_c: Number(vcDailyMax.toFixed(2)) });
      }
    }
    const providerDisagreement = disagreements.length > 0;

    // For agreement: NWS (US) is the gold standard since it's literally the
    // settlement source. For non-US, fall back to deterministic IFS.
    const referenceMax = nwsMax ?? ifsMax;

    const enriched = await Promise.all(
      outcomes.map(async (o) => {
        const pModelRaw = probInBucket(ensembleValues, o.bucket_min_c, o.bucket_max_c);
        const pRef = referenceMax != null
          ? ((referenceMax >= (o.bucket_min_c ?? -Infinity) && referenceMax <= (o.bucket_max_c ?? Infinity)) ? 1 : 0)
          : pModelRaw;
        // Use order book best_ask as the realistic BUY price (you can't fill
        // at midpoint if the spread is wide). Fall back to midpoint if book
        // unavailable.
        const [book, mid] = o.clob_token_id
          ? await Promise.all([fetchBook(o.clob_token_id), fetchPrice(o.clob_token_id)])
          : [null, null];
        const askPrice = book?.best_ask ?? mid;
        const bidPrice = book?.best_bid ?? mid;
        return {
          o, pEcmwf: pModelRaw, pNoaa: pRef, pModel: pModelRaw,
          price: askPrice, midpoint: mid, bid: bidPrice, ask: book?.best_ask ?? null,
          ask_size: book?.ask_size ?? null, bid_size: book?.bid_size ?? null,
          edge: null as number | null,
        };
      })
    );

    // Normalize ensemble probabilities to sum to 1
    const sumEc = enriched.reduce((s, x) => s + x.pEcmwf, 0);
    if (sumEc > 0) {
      for (const x of enriched) {
        x.pEcmwf = x.pEcmwf / sumEc;
        x.pModel = x.pEcmwf;
      }
    }
    for (const x of enriched) {
      x.edge = x.price != null ? x.pModel - x.price : null;
    }

    const sumNoaa = enriched.reduce((s, x) => s + x.pNoaa, 0);
    if (sumNoaa > 0) for (const x of enriched) x.pNoaa = x.pNoaa / sumNoaa;
    const tvd = enriched.reduce((s, x) => s + Math.abs(x.pEcmwf - x.pNoaa), 0) / 2;
    const agreement = Math.max(0, 1 - tvd);
    const confidence = confidenceFor(agreement);

    let bestAdjEdge = -Infinity;
    let bestLabel: string | null = null;
    let bestSize = 0;
    let bestPModel = 0;
    let bestPrice: number | null = null;
    let bestRawEdge: number | null = null;
    const distribution: any[] = [];

    // Favorite detection
    let mktFav: { label: string; price: number } | null = null;
    let modelFav: { label: string; prob: number } | null = null;
    for (const x of enriched) {
      if (x.price != null && (mktFav == null || x.price > mktFav.price)) {
        mktFav = { label: x.o.label, price: x.price };
      }
      if (modelFav == null || x.pModel > modelFav.prob) {
        modelFav = { label: x.o.label, prob: x.pModel };
      }
    }
    const favoriteMismatch = !!(mktFav && modelFav && mktFav.label !== modelFav.label);

    for (const x of enriched) {
      const adjEdge = x.edge != null ? x.edge * agreement : null;
      const size = adjEdge != null ? suggestedSize(adjEdge, agreement) : 0;
      await supabase.from("weather_outcomes").update({
        p_ecmwf: x.pEcmwf,
        p_noaa: x.pNoaa,
        p_model: x.pModel,
        polymarket_price: x.price,
        edge: adjEdge,
        suggested_size_percent: size,
      }).eq("id", x.o.id);

      distribution.push({
        label: x.o.label,
        p_model: x.pModel,
        p_market: x.price,        // realistic ASK price used for edge
        p_midpoint: x.midpoint,
        best_bid: x.bid,
        best_ask: x.ask,
        ask_size: x.ask_size,
        bid_size: x.bid_size,
        edge: adjEdge,
        raw_edge: x.edge,
        suggested_size_percent: size,
      });

      if (adjEdge != null && adjEdge > bestAdjEdge) {
        bestAdjEdge = adjEdge;
        bestLabel = x.o.label;
        bestSize = size;
        bestPModel = x.pModel;
        bestPrice = x.price;
        bestRawEdge = x.edge;
      }
    }

    const verifyFlag =
      bestPModel > 0.8 && bestPrice != null && bestPrice < 0.3
        ? "Model >80% but market <30% — verify resolution window, station, and forecast freshness before sizing up."
        : null;

    const sourcesUsed = {
      ecmwf_ens: !!ecmwfEns,
      gefs: !!gefs,
      ecmwf_aifs: aifsMax != null,
      graphcast: graphcastMax != null,
      nws: nwsMax != null,
      nbm: nbmMax != null,
      visual_crossing: vcDailyMax != null,
      reference_max_c: refForDisagreement,
      nbm_max_c: nbmMax,
      visual_crossing_max_c: vcDailyMax,
      provider_disagreement: providerDisagreement,
      disagreements,
      metar_floor_c: metarFloor,
      metar_observation_count: metars?.length ?? 0,
      ensemble_member_count: ensembleValues.length,
      uses_order_book: enriched.some((x) => x.ask != null),
    };

    await supabase.from("weather_signals").insert({
      market_id: m.id,
      user_id: m.user_id,
      agreement,
      confidence_level: confidence,
      best_outcome_label: bestLabel,
      best_edge: Number.isFinite(bestAdjEdge) ? bestAdjEdge : null,
      best_suggested_size_percent: bestSize,
      market_favorite_label: mktFav?.label ?? null,
      market_favorite_price: mktFav?.price ?? null,
      model_favorite_label: modelFav?.label ?? null,
      model_favorite_prob: modelFav?.prob ?? null,
      favorite_mismatch: favoriteMismatch,
      distribution: {
        outcomes: distribution,
        verify_flag: verifyFlag,
        best_raw_edge: bestRawEdge,
        sources: sourcesUsed,
      },
    });

    // Pull event-level 24h volume from Polymarket gamma (best-effort)
    let eventVolume24h: number | null = null;
    try {
      const slug = (m as any).polymarket_event_slug;
      if (slug) {
        const r = await fetch(`https://gamma-api.polymarket.com/events?slug=${encodeURIComponent(slug)}`);
        if (r.ok) {
          const arr = await r.json();
          const ev = Array.isArray(arr) ? arr[0] : arr;
          const v = Number(ev?.volume24hr ?? ev?.volume_24hr ?? 0);
          if (Number.isFinite(v) && v > 0) eventVolume24h = v;
        }
      }
    } catch { /* ignore */ }

    await supabase.from("weather_markets").update({
      updated_at: new Date().toISOString(),
      ...(eventVolume24h != null ? { event_volume_24h: eventVolume24h } : {}),
    }).eq("id", m.id);

    // ----- Forecast snapshots for bias learning -----
    // Capture each model's predicted daily-max for this market's event_time,
    // along with how many hours in advance the prediction was made. Later,
    // weather-resolve-bias compares snapshot.forecast_temp_c vs the actual
    // observed METAR daily max and inserts the error into forecast_bias.
    try {
      const leadHoursRaw = (Date.parse(m.event_time) - Date.now()) / 3600000;
      // Only snapshot when the prediction is meaningfully in the future
      // (>=1h lead). Past or near-past predictions aren't useful bias signal.
      if (leadHoursRaw >= 1) {
        const lead = Number(leadHoursRaw.toFixed(2));
        const snapshots: any[] = [];
        const push = (model: string, val: number | null) => {
          if (val == null || !Number.isFinite(val)) return;
          snapshots.push({
            user_id: m.user_id,
            market_id: m.id,
            station_code: stationCode,
            model_name: model,
            forecast_temp_c: Number(val.toFixed(2)),
            forecast_lead_hours: lead,
            event_time: m.event_time,
          });
        };
        // ifsMax/aifsMax/etc. are post-bias-corrected. We want the RAW
        // forecast (pre-correction) so the bias we measure later isn't
        // double-counted. Re-compute raw daily max here from the same
        // already-fetched data.
        const ifsRaw = ifsDet ? deterministicDailyMax(ifsDet.time, ifsDet.temp, localDay, 0) : null;
        const aifsRaw = aifsDet ? deterministicDailyMax(aifsDet.time, aifsDet.temp, localDay, 0) : null;
        const graphcastRaw = graphcastDet ? deterministicDailyMax(graphcastDet.time, graphcastDet.temp, localDay, 0) : null;
        const gefsMembersRaw = gefs ? memberDailyMax(gefs.members, localDayIndices(gefs.time, localDay), 0) : [];
        const gefsMeanRaw = gefsMembersRaw.length
          ? gefsMembersRaw.reduce((a, b) => a + b, 0) / gefsMembersRaw.length
          : null;
        const nwsRaw = nwsHours ? nwsDailyMaxForLocalDay(nwsHours, timezone, localDay) : null;
        const nbmRaw = nbmHours ? (() => {
          let max = -Infinity;
          for (const h of nbmHours) {
            if (localYMD(new Date(h.validTime), timezone) === localDay && h.tempC > max) max = h.tempC;
          }
          return Number.isFinite(max) ? max : null;
        })() : null;
        push("ecmwf_ifs025", ifsRaw);
        push("ecmwf_aifs025", aifsRaw);
        push("graphcast", graphcastRaw);
        push("gfs_seamless", gefsMeanRaw);
        push("nws", nwsRaw);
        push("nbm", nbmRaw);
        if (snapshots.length) {
          await supabase.from("forecast_snapshots").insert(snapshots);
        }
      }
    } catch (e) {
      console.warn("snapshot-log failed (non-fatal):", (e as Error).message);
    }

    // ----- Paper-trade auto-logging for calibration -----
    // For every outcome with positive edge, log one paper entry per UTC day.
    // Categorized as 'qualified' (the >=7% best pick) or 'sub_threshold' (everything else).
    // Closing price stays NULL until weather-clv-backfill runs after event_time.
    // The unique partial index (user_id, weather_outcome_id, day) silently dedupes.
    try {
      const MIN_EDGE = 0.07;
      const paperRows = enriched
        .filter((x) => x.edge != null && x.edge > 0 && x.price != null)
        .map((x) => {
          const isQualified = (x.edge as number) >= MIN_EDGE && x.o.label === bestLabel;
          return {
            user_id: m.user_id,
            detected_trade_id: null,
            weather_market_id: m.id,
            weather_outcome_id: x.o.id,
            asset_id: x.o.clob_token_id ?? `outcome:${x.o.id}`,
            side: "BUY",
            entry_price: x.price,
            closing_price: null,
            clv_cents: null,
            edge_at_entry: x.edge,
            p_model_at_entry: x.pModel,
            kind: isQualified ? "qualified" : "sub_threshold",
            event_time: m.event_time,
            source: "paper_auto",
            notes: { agreement, confidence_level: confidence },
          };
        });
      if (paperRows.length) {
        // onConflict via the partial unique index — ignore duplicates for the day
        await supabase.from("clv_scores").upsert(paperRows, {
          onConflict: "user_id,weather_outcome_id",
          ignoreDuplicates: true,
        });
      }
    } catch (e) {
      console.warn("paper-log failed (non-fatal):", (e as Error).message);
    }

    return new Response(JSON.stringify({
      ok: true,
      agreement,
      confidence_level: confidence,
      best_outcome_label: bestLabel,
      best_edge: Number.isFinite(bestAdjEdge) ? bestAdjEdge : null,
      best_raw_edge: bestRawEdge,
      best_suggested_size_percent: bestSize,
      verify_flag: verifyFlag,
      distribution,
      sources: sourcesUsed,
      station: station
        ? { code: station.station_code, name: station.station_name, timezone, local_day: localDay }
        : { code: null, name: null, timezone, local_day: localDay, warning: `No station mapped for "${m.city}"` },
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String((e as Error).message ?? e) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
