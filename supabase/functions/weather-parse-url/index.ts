// Parses a Polymarket EVENT URL with discrete temperature outcomes.
// Returns: { question, city, lat, lon, condition_type, event_time, polymarket_url,
//   event_slug, outcomes: [{label, bucket_min_c, bucket_max_c, sub_market_question,
//   clob_token_id, condition_id, polymarket_price}], missing }
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const fToC = (f: number) => ((f - 32) * 5) / 9;

function extractSlug(url: string): { slug: string | null; isEvent: boolean } {
  let m = url.match(/polymarket\.com\/event\/([^/?#]+)(?:\/([^/?#]+))?/);
  if (m) return { slug: m[2] ?? m[1], isEvent: !m[2] };
  m = url.match(/polymarket\.com\/market\/([^/?#]+)/);
  if (m) return { slug: m[1], isEvent: false };
  return { slug: null, isEvent: false };
}

async function fetchEvent(slug: string): Promise<any | null> {
  for (const path of [
    `https://gamma-api.polymarket.com/events?slug=${slug}`,
    `https://gamma-api.polymarket.com/markets?slug=${slug}`,
  ]) {
    try {
      const r = await fetch(path);
      if (!r.ok) continue;
      const j = await r.json();
      const arr = Array.isArray(j) ? j : (j?.events ?? j?.markets ?? []);
      if (arr?.length) return arr[0];
    } catch { /* skip */ }
  }
  return null;
}

const KNOWN_CITIES: Record<string, string> = {
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

function detectCity(text: string): string | null {
  const lower = text.toLowerCase();
  for (const k of Object.keys(KNOWN_CITIES)) {
    if (new RegExp(`\\b${k.replace(/ /g, "\\s+")}\\b`, "i").test(lower)) {
      return KNOWN_CITIES[k];
    }
  }
  const m = text.match(/\bin\s+([A-Z][A-Za-z .'-]+?)(?:\s+on\b|\s+be\b|\?|$)/);
  return m ? m[1].trim() : null;
}

function detectDate(text: string): string | null {
  const iso = text.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (iso) return new Date(`${iso[1]}T18:00:00Z`).toISOString();
  const months = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"];
  const re = new RegExp(`\\b(${months.join("|")})[a-z]*\\s+(\\d{1,2})(?:,\\s*(\\d{4}))?\\b`, "i");
  const m = text.match(re);
  if (!m) return null;
  const monthIdx = months.indexOf(m[1].toLowerCase().slice(0,3));
  const day = parseInt(m[2], 10);
  const now = new Date();
  let year = m[3] ? parseInt(m[3], 10) : now.getUTCFullYear();
  const candidate = new Date(Date.UTC(year, monthIdx, day, 18, 0, 0));
  if (!m[3] && candidate.getTime() < now.getTime() - 24*60*60*1000) year += 1;
  return new Date(Date.UTC(year, monthIdx, day, 18, 0, 0)).toISOString();
}

// Parse a sub-market question/title into a temperature bucket.
// Examples: "3°C", "1°C or below", "10°F", "Above 100°F", "Between 60 and 65°F"
function parseBucket(label: string): { min: number | null; max: number | null } {
  const s = label.replace(/–/g, "-");
  // Range "60-65 F" or "60–65°C"
  let m = s.match(/(-?\d+(?:\.\d+)?)\s*-\s*(-?\d+(?:\.\d+)?)\s*°?\s*([FCfc])/);
  if (m) {
    const a = parseFloat(m[1]); const b = parseFloat(m[2]);
    const unit = m[3].toUpperCase();
    const lo = Math.min(a, b); const hi = Math.max(a, b);
    return {
      min: unit === "F" ? fToC(lo) : lo,
      max: unit === "F" ? fToC(hi) : hi,
    };
  }
  // "or below" / "or less" / "below"
  m = s.match(/(-?\d+(?:\.\d+)?)\s*°?\s*([FCfc])?\s*(?:or\s+)?(below|less|under|or lower)/i);
  if (m) {
    const v = parseFloat(m[1]);
    const unit = (m[2] ?? "C").toUpperCase();
    return { min: null, max: unit === "F" ? fToC(v) : v };
  }
  // "or above" / "or more" / "above"
  m = s.match(/(-?\d+(?:\.\d+)?)\s*°?\s*([FCfc])?\s*(?:or\s+)?(above|more|over|or higher)/i);
  if (m) {
    const v = parseFloat(m[1]);
    const unit = (m[2] ?? "C").toUpperCase();
    return { min: unit === "F" ? fToC(v) : v, max: null };
  }
  // "Above 100°F" / "Below 50°C"
  m = s.match(/\b(above|over|>=?|greater than)\s+(-?\d+(?:\.\d+)?)\s*°?\s*([FCfc])?/i);
  if (m) {
    const v = parseFloat(m[2]);
    const unit = (m[3] ?? "C").toUpperCase();
    return { min: unit === "F" ? fToC(v) : v, max: null };
  }
  m = s.match(/\b(below|under|<=?|less than)\s+(-?\d+(?:\.\d+)?)\s*°?\s*([FCfc])?/i);
  if (m) {
    const v = parseFloat(m[2]);
    const unit = (m[3] ?? "C").toUpperCase();
    return { min: null, max: unit === "F" ? fToC(v) : v };
  }
  // single discrete: "3°C" or "73°F" → bucket of width 1 unit centered on value
  m = s.match(/(-?\d+(?:\.\d+)?)\s*°?\s*([FCfc])/);
  if (m) {
    const v = parseFloat(m[1]);
    const unit = m[2].toUpperCase();
    const c = unit === "F" ? fToC(v) : v;
    const half = unit === "F" ? fToC(v + 0.5) - c : 0.5;
    return { min: c - half, max: c + half };
  }
  return { min: null, max: null };
}

async function geocode(city: string): Promise<{ lat: number; lon: number } | null> {
  try {
    const r = await fetch(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=en&format=json`,
    );
    if (!r.ok) return null;
    const j = await r.json();
    const hit = j?.results?.[0];
    return hit ? { lat: Number(hit.latitude), lon: Number(hit.longitude) } : null;
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

function tokensFromMarket(m: any): string[] {
  try {
    if (m?.clobTokenIds) {
      const t = JSON.parse(m.clobTokenIds);
      if (Array.isArray(t)) return t.map(String);
    }
  } catch { /* ignore */ }
  return [];
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

    const { slug } = extractSlug(url);
    if (!slug) {
      return new Response(JSON.stringify({ error: "Could not extract slug from URL" }), {
        status: 422, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const ev = await fetchEvent(slug);
    if (!ev) {
      return new Response(JSON.stringify({ error: "Could not fetch event from Polymarket. Check the URL." }), {
        status: 422, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const eventTitle = ev?.title ?? ev?.question ?? "";
    const subMarkets: any[] = Array.isArray(ev?.markets) ? ev.markets : [ev];

    // Build outcomes from sub-markets (one YES token per °C bucket)
    const outcomes = await Promise.all(
      subMarkets.map(async (sm, i) => {
        const label = sm?.groupItemTitle ?? sm?.outcomes?.[0] ?? sm?.question ?? sm?.title ?? `Outcome ${i+1}`;
        const tokens = tokensFromMarket(sm);
        const tokenId = tokens[0] ?? null;
        const bucket = parseBucket(String(label) + " " + String(sm?.question ?? ""));
        const price = tokenId ? await fetchPrice(tokenId) : null;
        return {
          label: String(label),
          sub_market_question: sm?.question ?? null,
          clob_token_id: tokenId,
          condition_id: sm?.conditionId ?? null,
          bucket_min_c: bucket.min,
          bucket_max_c: bucket.max,
          polymarket_price: price,
          display_order: i,
        };
      })
    );

    const text = `${eventTitle} ${subMarkets.map((m: any) => m?.question ?? "").join(" ")}`;
    const city = detectCity(text);
    const event_time = detectDate(text);
    let lat: number | null = null;
    let lon: number | null = null;
    if (city) {
      const g = await geocode(city);
      if (g) { lat = g.lat; lon = g.lon; }
    }

    const condition_type = /rain|precip|snow/i.test(text) ? "rain" : "temperature_discrete";

    const missing: string[] = [];
    if (!city) missing.push("city");
    if (lat == null || lon == null) missing.push("coordinates");
    if (!event_time) missing.push("event_time");
    if (!outcomes.length) missing.push("outcomes");

    return new Response(JSON.stringify({
      question: eventTitle,
      city,
      latitude: lat,
      longitude: lon,
      condition_type,
      event_time,
      polymarket_url: url,
      event_slug: slug,
      outcomes,
      missing,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String((e as Error).message ?? e) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
