// Parses a Polymarket URL and auto-fills all weather-market fields.
// Returns: { question, city, lat, lon, condition_type, temp_min_c, temp_max_c,
//   precip_threshold_mm, event_time (ISO), polymarket_url, polymarket_price,
//   clob_token_id, condition_range, missing: string[] }
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const fToC = (f: number) => ((f - 32) * 5) / 9;

function extractSlug(url: string): string | null {
  const m = url.match(/polymarket\.com\/event\/[^/]+\/([^/?#]+)/) ||
    url.match(/polymarket\.com\/event\/([^/?#]+)/) ||
    url.match(/polymarket\.com\/market\/([^/?#]+)/);
  return m?.[1] ?? null;
}

async function fetchGamma(slug: string): Promise<any | null> {
  // try market by slug first, then event by slug
  for (const path of [
    `https://gamma-api.polymarket.com/markets?slug=${slug}`,
    `https://gamma-api.polymarket.com/events?slug=${slug}`,
  ]) {
    try {
      const r = await fetch(path);
      if (!r.ok) continue;
      const j = await r.json();
      const arr = Array.isArray(j) ? j : (j?.markets ?? j?.events ?? []);
      if (arr?.length) return arr[0];
    } catch { /* skip */ }
  }
  return null;
}

function parseQuestion(q: string): {
  city: string | null;
  condition_type: "temperature" | "rain" | "other";
  temp_min_c: number | null;
  temp_max_c: number | null;
  precip_threshold_mm: number | null;
  event_time: string | null;
} {
  const lower = q.toLowerCase();
  let condition_type: "temperature" | "rain" | "other" = "other";
  if (/\b(high|low|temperature|temp|°[fc]|degrees)\b/i.test(q)) condition_type = "temperature";
  else if (/\b(rain|precip|snow|shower)\b/i.test(q)) condition_type = "rain";

  // City — try common patterns: "in <City>", "<City> high/low", or known cities
  const KNOWN: Record<string, string> = {
    nyc: "New York", "new york": "New York", manhattan: "New York",
    la: "Los Angeles", "los angeles": "Los Angeles",
    sf: "San Francisco", "san francisco": "San Francisco",
    chicago: "Chicago", boston: "Boston", miami: "Miami", seattle: "Seattle",
    toronto: "Toronto", london: "London", paris: "Paris", tokyo: "Tokyo",
    berlin: "Berlin", madrid: "Madrid", rome: "Rome", sydney: "Sydney",
    dubai: "Dubai", "hong kong": "Hong Kong", singapore: "Singapore",
    austin: "Austin", denver: "Denver", phoenix: "Phoenix", dallas: "Dallas",
    houston: "Houston", philadelphia: "Philadelphia", atlanta: "Atlanta",
    minneapolis: "Minneapolis", "washington dc": "Washington DC", dc: "Washington DC",
  };
  let city: string | null = null;
  for (const k of Object.keys(KNOWN)) {
    const re = new RegExp(`\\b${k.replace(/ /g, "\\s+")}\\b`, "i");
    if (re.test(lower)) { city = KNOWN[k]; break; }
  }
  if (!city) {
    const m = q.match(/\bin\s+([A-Z][A-Za-z .'-]+?)(?:\s+on\b|\s+be\b|\?|$)/);
    if (m) city = m[1].trim();
  }

  // Temperature range: "60–65°F", "60-65 F", "20-22C"
  let temp_min_c: number | null = null;
  let temp_max_c: number | null = null;
  if (condition_type === "temperature") {
    const m = q.match(/(-?\d+(?:\.\d+)?)\s*[–-]\s*(-?\d+(?:\.\d+)?)\s*°?\s*([FfCc])/);
    if (m) {
      const a = parseFloat(m[1]); const b = parseFloat(m[2]);
      const unit = m[3].toUpperCase();
      const lo = Math.min(a, b); const hi = Math.max(a, b);
      temp_min_c = unit === "F" ? fToC(lo) : lo;
      temp_max_c = unit === "F" ? fToC(hi) : hi;
    } else {
      // single value with above/below
      const single = q.match(/(above|below|over|under|at least|at most)\s+(-?\d+(?:\.\d+)?)\s*°?\s*([FfCc])/i);
      if (single) {
        const v = parseFloat(single[2]);
        const c = single[3].toUpperCase() === "F" ? fToC(v) : v;
        const dir = single[1].toLowerCase();
        if (/above|over|at least/.test(dir)) temp_min_c = c;
        else { temp_max_c = c; }
      }
    }
  }

  // Precip
  let precip_threshold_mm: number | null = null;
  if (condition_type === "rain") precip_threshold_mm = 0.1;

  // Date — "Apr 25", "April 25", "Apr 25, 2026", "2026-04-25"
  let event_time: string | null = null;
  const isoMatch = q.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (isoMatch) {
    event_time = new Date(`${isoMatch[1]}T18:00:00Z`).toISOString();
  } else {
    const months = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"];
    const re = new RegExp(`\\b(${months.join("|")})[a-z]*\\s+(\\d{1,2})(?:,\\s*(\\d{4}))?\\b`, "i");
    const m = q.match(re);
    if (m) {
      const monthIdx = months.indexOf(m[1].toLowerCase().slice(0,3));
      const day = parseInt(m[2], 10);
      const now = new Date();
      let year = m[3] ? parseInt(m[3], 10) : now.getUTCFullYear();
      // if date already passed this year, roll forward
      const candidate = new Date(Date.UTC(year, monthIdx, day, 18, 0, 0));
      if (!m[3] && candidate.getTime() < now.getTime() - 24*60*60*1000) {
        year += 1;
      }
      event_time = new Date(Date.UTC(year, monthIdx, day, 18, 0, 0)).toISOString();
    }
  }

  return { city, condition_type, temp_min_c, temp_max_c, precip_threshold_mm, event_time };
}

async function geocode(city: string): Promise<{ lat: number; lon: number } | null> {
  try {
    const r = await fetch(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=en&format=json`,
    );
    if (!r.ok) return null;
    const j = await r.json();
    const hit = j?.results?.[0];
    if (!hit) return null;
    return { lat: Number(hit.latitude), lon: Number(hit.longitude) };
  } catch { return null; }
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
    const url: string = (body?.url ?? "").trim();
    if (!url || !/polymarket\.com/.test(url)) {
      return new Response(JSON.stringify({ error: "Provide a valid Polymarket URL" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const slug = extractSlug(url);
    let question = "";
    let tokenId: string | null = null;
    let condition_id: string | null = null;
    if (slug) {
      const m = await fetchGamma(slug);
      if (m) {
        question = m?.question ?? m?.title ?? "";
        condition_id = m?.conditionId ?? null;
        try {
          const tokens = m?.clobTokenIds ? JSON.parse(m.clobTokenIds) : (m?.markets?.[0]?.clobTokenIds ? JSON.parse(m.markets[0].clobTokenIds) : null);
          if (Array.isArray(tokens) && tokens.length) tokenId = String(tokens[0]);
        } catch { /* skip */ }
        // fall back: events have nested markets
        if (!tokenId && Array.isArray(m?.markets)) {
          for (const sub of m.markets) {
            try {
              const t = sub?.clobTokenIds ? JSON.parse(sub.clobTokenIds) : null;
              if (Array.isArray(t) && t.length) { tokenId = String(t[0]); break; }
            } catch { /* skip */ }
          }
          if (!question && m.markets[0]?.question) question = m.markets[0].question;
        }
      }
    }

    if (!question) {
      return new Response(JSON.stringify({ error: "Could not fetch market question from Polymarket. Check the URL." }), {
        status: 422, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const parsed = parseQuestion(question);
    let lat: number | null = null;
    let lon: number | null = null;
    if (parsed.city) {
      const g = await geocode(parsed.city);
      if (g) { lat = g.lat; lon = g.lon; }
    }

    const price = tokenId ? await fetchPrice(tokenId) : null;

    const condition_range =
      parsed.condition_type === "temperature"
        ? `${parsed.temp_min_c?.toFixed(1) ?? "?"}–${parsed.temp_max_c?.toFixed(1) ?? "?"}°C`
        : parsed.condition_type === "rain"
          ? `rain ≥ ${parsed.precip_threshold_mm}mm`
          : "—";

    const missing: string[] = [];
    if (!parsed.city) missing.push("city");
    if (lat == null || lon == null) missing.push("coordinates");
    if (parsed.condition_type === "temperature" && (parsed.temp_min_c == null || parsed.temp_max_c == null)) missing.push("temperature_range");
    if (!parsed.event_time) missing.push("event_time");

    return new Response(JSON.stringify({
      question,
      city: parsed.city,
      latitude: lat,
      longitude: lon,
      condition_type: parsed.condition_type,
      temp_min_c: parsed.temp_min_c,
      temp_max_c: parsed.temp_max_c,
      precip_threshold_mm: parsed.precip_threshold_mm,
      event_time: parsed.event_time,
      polymarket_url: url,
      polymarket_price: price,
      clob_token_id: tokenId,
      condition_id,
      condition_range,
      missing,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String((e as Error).message ?? e) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
