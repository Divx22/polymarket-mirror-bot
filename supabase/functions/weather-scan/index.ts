// Weather Scanner: discovers active weather markets via Polymarket Gamma API,
// upserts them + their outcomes, deactivates expired ones, and caps the working set.
// User runs this manually OR via UI auto-refresh; per-market refresh re-runs the model.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const MAX_OUTCOMES = 50;
const fToC = (f: number) => ((f - 32) * 5) / 9;

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
  seoul: "Seoul", "mexico city": "Mexico City", moscow: "Moscow",
  istanbul: "Istanbul", mumbai: "Mumbai", delhi: "Delhi", beijing: "Beijing",
  shanghai: "Shanghai", "rio de janeiro": "Rio de Janeiro",
  "buenos aires": "Buenos Aires", "sao paulo": "Sao Paulo",
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
  const monthIdx = months.indexOf(m[1].toLowerCase().slice(0, 3));
  const day = parseInt(m[2], 10);
  const now = new Date();
  let year = m[3] ? parseInt(m[3], 10) : now.getUTCFullYear();
  const candidate = new Date(Date.UTC(year, monthIdx, day, 18, 0, 0));
  if (!m[3] && candidate.getTime() < now.getTime() - 24 * 60 * 60 * 1000) year += 1;
  return new Date(Date.UTC(year, monthIdx, day, 18, 0, 0)).toISOString();
}

function parseBucket(label: string): { min: number | null; max: number | null } {
  const s = label.replace(/–/g, "-");
  let m = s.match(/(-?\d+(?:\.\d+)?)\s*-\s*(-?\d+(?:\.\d+)?)\s*°?\s*([FCfc])/);
  if (m) {
    const a = parseFloat(m[1]); const b = parseFloat(m[2]);
    const unit = m[3].toUpperCase();
    const lo = Math.min(a, b); const hi = Math.max(a, b);
    return { min: unit === "F" ? fToC(lo) : lo, max: unit === "F" ? fToC(hi) : hi };
  }
  m = s.match(/(-?\d+(?:\.\d+)?)\s*°?\s*([FCfc])?\s*(?:or\s+)?(below|less|under|or lower)/i);
  if (m) {
    const v = parseFloat(m[1]); const unit = (m[2] ?? "C").toUpperCase();
    return { min: null, max: unit === "F" ? fToC(v) : v };
  }
  m = s.match(/(-?\d+(?:\.\d+)?)\s*°?\s*([FCfc])?\s*(?:or\s+)?(above|more|over|or higher)/i);
  if (m) {
    const v = parseFloat(m[1]); const unit = (m[2] ?? "C").toUpperCase();
    return { min: unit === "F" ? fToC(v) : v, max: null };
  }
  m = s.match(/\b(above|over|>=?|greater than)\s+(-?\d+(?:\.\d+)?)\s*°?\s*([FCfc])?/i);
  if (m) {
    const v = parseFloat(m[2]); const unit = (m[3] ?? "C").toUpperCase();
    return { min: unit === "F" ? fToC(v) : v, max: null };
  }
  m = s.match(/\b(below|under|<=?|less than)\s+(-?\d+(?:\.\d+)?)\s*°?\s*([FCfc])?/i);
  if (m) {
    const v = parseFloat(m[2]); const unit = (m[3] ?? "C").toUpperCase();
    return { min: null, max: unit === "F" ? fToC(v) : v };
  }
  m = s.match(/(-?\d+(?:\.\d+)?)\s*°?\s*([FCfc])/);
  if (m) {
    const v = parseFloat(m[1]); const unit = m[2].toUpperCase();
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

// Discover weather events from Gamma API. Tag-based + keyword backfill.
async function discoverEvents(): Promise<any[]> {
  const seen = new Map<string, any>();
  const candidates = [
    "https://gamma-api.polymarket.com/events?tag_slug=weather&closed=false&active=true&limit=100",
    "https://gamma-api.polymarket.com/events?tag=weather&closed=false&active=true&limit=100",
    "https://gamma-api.polymarket.com/events?tag_slug=climate&closed=false&active=true&limit=50",
  ];
  for (const url of candidates) {
    try {
      const r = await fetch(url);
      if (!r.ok) continue;
      const j = await r.json();
      const arr = Array.isArray(j) ? j : (j?.events ?? []);
      for (const ev of arr) {
        if (ev?.id && !seen.has(String(ev.id))) seen.set(String(ev.id), ev);
      }
    } catch { /* skip */ }
  }
  // Keyword fallback
  for (const q of ["temperature", "highest temp", "rain", "snow"]) {
    try {
      const r = await fetch(
        `https://gamma-api.polymarket.com/events?closed=false&active=true&limit=50&query=${encodeURIComponent(q)}`,
      );
      if (!r.ok) continue;
      const j = await r.json();
      const arr = Array.isArray(j) ? j : (j?.events ?? []);
      for (const ev of arr) {
        const title = String(ev?.title ?? "").toLowerCase();
        if (/temperature|temp|°|rain|snow|weather|hot|cold|degree/.test(title)) {
          if (ev?.id && !seen.has(String(ev.id))) seen.set(String(ev.id), ev);
        }
      }
    } catch { /* skip */ }
  }
  return Array.from(seen.values());
}

type EventResult = {
  ev: any;
  city: string;
  lat: number;
  lon: number;
  event_time: string;
  outcomes: any[];
};

async function processEvent(ev: any): Promise<EventResult | null> {
  const eventTitle: string = ev?.title ?? ev?.question ?? "";
  if (!eventTitle) return null;
  const subMarkets: any[] = Array.isArray(ev?.markets) ? ev.markets : [ev];
  if (!subMarkets.length) return null;

  const text = `${eventTitle} ${subMarkets.map((m: any) => m?.question ?? "").join(" ")}`;
  const city = detectCity(text);
  const event_time = detectDate(text);
  if (!city || !event_time) return null;
  if (new Date(event_time).getTime() < Date.now()) return null;

  const g = await geocode(city);
  if (!g) return null;

  const outcomes = await Promise.all(
    subMarkets.map(async (sm, i) => {
      // Skip resolved sub-markets
      if (sm?.closed === true || sm?.archived === true) return null;
      const label = sm?.groupItemTitle ?? sm?.outcomes?.[0] ?? sm?.question ?? sm?.title ?? `Outcome ${i + 1}`;
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
    }),
  );
  const valid = outcomes.filter(Boolean) as any[];
  if (!valid.length) return null;

  return { ev, city, lat: g.lat, lon: g.lon, event_time, outcomes: valid };
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
    const userId = userRes.user.id;

    // 1. Cleanup: deactivate expired markets for this user
    const nowIso = new Date().toISOString();
    await supabase
      .from("weather_markets")
      .update({ active: false })
      .eq("user_id", userId)
      .lt("event_time", nowIso);

    // 2. Discover
    const events = await discoverEvents();

    // 3. Process in parallel (bounded)
    const processed: EventResult[] = [];
    const BATCH = 5;
    for (let i = 0; i < events.length; i += BATCH) {
      const slice = events.slice(i, i + BATCH);
      const results = await Promise.all(slice.map((e) => processEvent(e).catch(() => null)));
      for (const r of results) if (r) processed.push(r);
    }

    // 4. Sort by event_time ascending (soonest first), cap total outcomes
    processed.sort((a, b) => new Date(a.event_time).getTime() - new Date(b.event_time).getTime());
    let outcomeBudget = MAX_OUTCOMES;
    const kept: EventResult[] = [];
    for (const e of processed) {
      if (outcomeBudget <= 0) break;
      const take = Math.min(e.outcomes.length, outcomeBudget);
      e.outcomes = e.outcomes.slice(0, take);
      outcomeBudget -= take;
      kept.push(e);
    }

    // 5. Upsert markets + outcomes
    let marketsUpserted = 0;
    let outcomesUpserted = 0;
    for (const e of kept) {
      const slug = e.ev?.slug ?? null;
      const url = slug ? `https://polymarket.com/event/${slug}` : null;

      // Find existing market by event_slug for this user
      const { data: existing } = await supabase
        .from("weather_markets")
        .select("id")
        .eq("user_id", userId)
        .eq("polymarket_event_slug", slug ?? "__none__")
        .maybeSingle();

      let marketId: string;
      if (existing?.id) {
        await supabase.from("weather_markets").update({
          city: e.city, latitude: e.lat, longitude: e.lon,
          market_question: e.ev?.title ?? "", event_time: e.event_time,
          polymarket_url: url, active: true,
        }).eq("id", existing.id);
        marketId = existing.id;
      } else {
        const { data: ins, error: insErr } = await supabase
          .from("weather_markets").insert({
            user_id: userId, city: e.city, latitude: e.lat, longitude: e.lon,
            market_question: e.ev?.title ?? "", condition_type: "temperature_discrete",
            event_time: e.event_time, polymarket_url: url, polymarket_event_slug: slug,
            active: true,
          }).select("id").single();
        if (insErr || !ins) continue;
        marketId = ins.id;
      }
      marketsUpserted++;

      // Replace outcomes for this market
      await supabase.from("weather_outcomes").delete().eq("market_id", marketId);
      const rows = e.outcomes.map((o) => ({ ...o, user_id: userId, market_id: marketId }));
      const { error: outErr } = await supabase.from("weather_outcomes").insert(rows);
      if (!outErr) outcomesUpserted += rows.length;
    }

    return new Response(JSON.stringify({
      ok: true,
      events_discovered: events.length,
      events_processed: processed.length,
      events_kept: kept.length,
      markets_upserted: marketsUpserted,
      outcomes_upserted: outcomesUpserted,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String((e as Error).message ?? e) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
