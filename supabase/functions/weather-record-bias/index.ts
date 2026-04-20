// Records yesterday's forecast-vs-actual error for each (station, model) pair
// to populate the forecast_bias table. Run nightly (e.g., 06:00 UTC).
// Actual = MAX METAR temp on yesterday's local-day at the station.
// Forecast = each model's predicted MAX for that same day, fetched as an
// archive query so we get what the model actually said yesterday.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function localYMD(d: Date, timezone: string): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
  });
  const p = fmt.formatToParts(d);
  return `${p.find((x) => x.type === "year")!.value}-${p.find((x) => x.type === "month")!.value}-${p.find((x) => x.type === "day")!.value}`;
}

async function fetchMetarMax(stationCode: string, ymd: string, timezone: string): Promise<number | null> {
  try {
    // 48h window covers any local-day in any timezone
    const r = await fetch(`https://aviationweather.gov/api/data/metar?ids=${stationCode}&format=json&hours=48`);
    if (!r.ok) return null;
    const arr: any[] = await r.json();
    let max = -Infinity;
    for (const m of arr ?? []) {
      const t = m?.reportTime;
      const v = Number(m?.temp);
      if (!t || !Number.isFinite(v)) continue;
      if (localYMD(new Date(t), timezone) === ymd && v > max) max = v;
    }
    return Number.isFinite(max) ? max : null;
  } catch { return null; }
}

async function fetchModelMax(
  lat: number, lon: number, timezone: string, ymd: string, model: string,
): Promise<number | null> {
  try {
    // past_days=2 includes yesterday in the standard forecast endpoint
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
      `&hourly=temperature_2m&models=${model}&past_days=2&forecast_days=1` +
      `&timezone=${encodeURIComponent(timezone)}`;
    const r = await fetch(url);
    if (!r.ok) return null;
    const j = await r.json();
    const times: string[] = j?.hourly?.time ?? [];
    const temps: number[] = j?.hourly?.temperature_2m ?? [];
    let max = -Infinity;
    for (let i = 0; i < times.length; i++) {
      if (times[i].startsWith(ymd) && temps[i] != null && temps[i] > max) max = temps[i];
    }
    return Number.isFinite(max) ? max : null;
  } catch { return null; }
}

const MODELS = ["ecmwf_ifs025", "ecmwf_aifs025", "gfs_seamless", "graphcast"];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    // Use service role — this is a system job, not user-scoped.
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: stations } = await supabase.from("stations").select("*");
    const list = (stations ?? []) as any[];
    let inserted = 0;
    const skipped: string[] = [];

    for (const s of list) {
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const ymd = localYMD(yesterday, s.timezone);
      const actual = await fetchMetarMax(s.station_code, ymd, s.timezone);
      if (actual == null) { skipped.push(`${s.station_code}: no METAR`); continue; }

      for (const model of MODELS) {
        const fc = await fetchModelMax(Number(s.latitude), Number(s.longitude), s.timezone, ymd, model);
        if (fc == null) continue;
        await supabase.from("forecast_bias").insert({
          station_code: s.station_code,
          model_name: model,
          forecast_lead_hours: 24, // approximate — yesterday's day-1 forecast
          forecast_temp_c: fc,
          actual_temp_c: actual,
          error_c: fc - actual, // positive = model was too hot
          valid_at: new Date(`${ymd}T12:00:00Z`).toISOString(),
        });
        inserted++;
      }
    }

    return new Response(JSON.stringify({ ok: true, stations: list.length, inserted, skipped }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String((e as Error).message ?? e) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
