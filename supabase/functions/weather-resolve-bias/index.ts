// Resolves forecast snapshots whose event_time has passed:
//   1. Find unresolved snapshots with event_time <= now
//   2. Group by station_code, fetch actual observed daily max from METAR
//   3. For each snapshot, compute error_c = forecast - actual and insert into forecast_bias
//   4. Mark snapshot resolved
// This is what populates forecast_bias so getBias() in weather-refresh-market
// has data to actually correct against.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

type Snapshot = {
  id: string;
  user_id: string;
  market_id: string;
  station_code: string | null;
  model_name: string;
  forecast_temp_c: number;
  forecast_lead_hours: number;
  event_time: string;
};

type Market = {
  id: string;
  city: string;
  latitude: number;
  longitude: number;
  event_time: string;
  resolution_lat: number | null;
  resolution_lon: number | null;
  resolution_station_code: string | null;
};

type Station = { city: string; station_code: string; timezone: string };

function localYMD(d: Date, timezone: string): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
  });
  const parts = fmt.formatToParts(d);
  const y = parts.find((p) => p.type === "year")!.value;
  const mo = parts.find((p) => p.type === "month")!.value;
  const da = parts.find((p) => p.type === "day")!.value;
  return `${y}-${mo}-${da}`;
}

// METAR observations from aviationweather.gov. Pulls last `hours` hours of obs.
async function fetchMetar(stationCode: string, hours: number): Promise<{ time: string; tempC: number }[]> {
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

function metarMaxForLocalDay(
  obs: { time: string; tempC: number }[], timezone: string, localDay: string,
): number | null {
  let max = -Infinity;
  for (const o of obs) {
    if (localYMD(new Date(o.time), timezone) === localDay && o.tempC > max) max = o.tempC;
  }
  return Number.isFinite(max) ? max : null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } },
    );

    const { data: userData } = await supabase.auth.getUser();
    if (!userData?.user) {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const userId = userData.user.id;

    const nowIso = new Date().toISOString();
    // Pull unresolved snapshots whose event has passed
    const { data: snaps } = await supabase
      .from("forecast_snapshots")
      .select("id, user_id, market_id, station_code, model_name, forecast_temp_c, forecast_lead_hours, event_time")
      .eq("user_id", userId)
      .eq("resolved", false)
      .lt("event_time", nowIso)
      .returns<Snapshot[]>();

    if (!snaps || snaps.length === 0) {
      return new Response(JSON.stringify({ resolved: 0, skipped: 0, reason: "no unresolved snapshots" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Group by market to fetch each market once
    const byMarket = new Map<string, Snapshot[]>();
    for (const s of snaps) {
      const arr = byMarket.get(s.market_id) ?? [];
      arr.push(s);
      byMarket.set(s.market_id, arr);
    }

    const marketIds = Array.from(byMarket.keys());
    const { data: marketsData } = await supabase
      .from("weather_markets")
      .select("id, city, latitude, longitude, event_time, resolution_lat, resolution_lon, resolution_station_code")
      .in("id", marketIds)
      .returns<Market[]>();
    const marketsMap = new Map((marketsData ?? []).map((m) => [m.id, m]));

    const cities = Array.from(new Set((marketsData ?? []).map((m) => m.city)));
    const { data: stationsData } = await supabase
      .from("stations")
      .select("city, station_code, timezone")
      .in("city", cities)
      .returns<Station[]>();
    const stationsByCity = new Map((stationsData ?? []).map((s) => [s.city.toLowerCase(), s]));

    let resolved = 0;
    let skipped = 0;
    const errors: { market_id: string; reason: string }[] = [];

    for (const [marketId, group] of byMarket.entries()) {
      const m = marketsMap.get(marketId);
      if (!m) { skipped += group.length; continue; }
      const stationFromCity = stationsByCity.get(m.city.toLowerCase());
      // Prefer per-market override station, fall back to city default
      const stationCode = m.resolution_station_code ?? stationFromCity?.station_code ?? null;
      const timezone = stationFromCity?.timezone ?? "UTC";
      if (!stationCode) {
        skipped += group.length;
        errors.push({ market_id: marketId, reason: "no station code" });
        continue;
      }

      const localDay = localYMD(new Date(m.event_time), timezone);
      // Pull a generous window of METAR obs covering the full event day in local time.
      // Event might be a day or two old now, so request 72h.
      const obs = await fetchMetar(stationCode, 72);
      const actualMax = metarMaxForLocalDay(obs, timezone, localDay);
      if (actualMax == null) {
        skipped += group.length;
        errors.push({ market_id: marketId, reason: "no METAR observations for event day" });
        continue;
      }

      // Build bias rows + collect snapshot ids to mark resolved
      const biasRows = group.map((s) => ({
        station_code: stationCode,
        model_name: s.model_name,
        forecast_lead_hours: Math.round(Number(s.forecast_lead_hours)),
        forecast_temp_c: Number(s.forecast_temp_c),
        actual_temp_c: Number(actualMax.toFixed(2)),
        // error = forecast - actual. Positive = model ran HOT (predicted higher than reality).
        // getBias() in refresh-market subtracts mean error, so a hot model gets corrected DOWN.
        error_c: Number((Number(s.forecast_temp_c) - actualMax).toFixed(2)),
        valid_at: m.event_time,
      }));

      const { error: insErr } = await supabase.from("forecast_bias").insert(biasRows);
      if (insErr) {
        skipped += group.length;
        errors.push({ market_id: marketId, reason: insErr.message });
        continue;
      }

      const { error: upErr } = await supabase
        .from("forecast_snapshots")
        .update({ resolved: true })
        .in("id", group.map((s) => s.id));
      if (upErr) {
        // bias inserted but snapshot flag failed — still counts as resolved this run
        errors.push({ market_id: marketId, reason: `flag: ${upErr.message}` });
      }
      resolved += group.length;
    }

    return new Response(
      JSON.stringify({ resolved, skipped, total: snaps.length, errors }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : String(e) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
