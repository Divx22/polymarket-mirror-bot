// Discovers ALL active Polymarket temperature markets closing within 48h and
// returns those qualifying for momentum (gap #1 vs #2 ≥ GAP_MIN now AND 1h ago).
// Read-only — does NOT save anything to the database.
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const DEFAULT_GAP_MIN = 0.10;
const MAX_ENTRY_PRICE = 0.95;
const MAX_HOURS = 48;
const MIN_HOURS = 0.5;
const FLAT_BAND = 0.01;

type HistPoint = { t: number; p: number };
type Trajectory = "accelerating" | "widening" | "flat" | "narrowing";

const KNOWN_CITIES: Record<string, string> = {
  nyc: "New York", "new york": "New York", la: "Los Angeles", "los angeles": "Los Angeles",
  sf: "San Francisco", "san francisco": "San Francisco", chicago: "Chicago", boston: "Boston",
  miami: "Miami", seattle: "Seattle", toronto: "Toronto", london: "London", paris: "Paris",
  tokyo: "Tokyo", berlin: "Berlin", madrid: "Madrid", rome: "Rome", sydney: "Sydney",
  dubai: "Dubai", "hong kong": "Hong Kong", singapore: "Singapore", austin: "Austin",
  denver: "Denver", phoenix: "Phoenix", dallas: "Dallas", houston: "Houston",
  philadelphia: "Philadelphia", atlanta: "Atlanta", minneapolis: "Minneapolis",
  "washington dc": "Washington DC", dc: "Washington DC", seoul: "Seoul",
  "mexico city": "Mexico City", moscow: "Moscow", istanbul: "Istanbul", mumbai: "Mumbai",
  delhi: "Delhi", beijing: "Beijing", shanghai: "Shanghai", "rio de janeiro": "Rio de Janeiro",
  "buenos aires": "Buenos Aires", "sao paulo": "Sao Paulo",
};

// City → IANA timezone for resolving "end of day" in the city's local time.
const CITY_TZ: Record<string, string> = {
  "New York": "America/New_York", "Los Angeles": "America/Los_Angeles",
  "San Francisco": "America/Los_Angeles", "Chicago": "America/Chicago",
  "Boston": "America/New_York", "Miami": "America/New_York",
  "Seattle": "America/Los_Angeles", "Toronto": "America/Toronto",
  "Austin": "America/Chicago", "Denver": "America/Denver",
  "Phoenix": "America/Phoenix", "Dallas": "America/Chicago",
  "Houston": "America/Chicago", "Philadelphia": "America/New_York",
  "Atlanta": "America/New_York", "Minneapolis": "America/Chicago",
  "Washington DC": "America/New_York", "Mexico City": "America/Mexico_City",
  "London": "Europe/London", "Paris": "Europe/Paris",
  "Berlin": "Europe/Berlin", "Madrid": "Europe/Madrid",
  "Rome": "Europe/Rome", "Moscow": "Europe/Moscow",
  "Istanbul": "Europe/Istanbul", "Tokyo": "Asia/Tokyo",
  "Seoul": "Asia/Seoul", "Beijing": "Asia/Shanghai",
  "Shanghai": "Asia/Shanghai", "Hong Kong": "Asia/Hong_Kong",
  "Singapore": "Asia/Singapore", "Mumbai": "Asia/Kolkata",
  "Delhi": "Asia/Kolkata", "Dubai": "Asia/Dubai",
  "Sydney": "Australia/Sydney", "Rio de Janeiro": "America/Sao_Paulo",
  "Sao Paulo": "America/Sao_Paulo",
  "Buenos Aires": "America/Argentina/Buenos_Aires",
};

const MONTHS: Record<string, number> = {
  january: 0, jan: 0, february: 1, feb: 1, march: 2, mar: 2, april: 3, apr: 3,
  may: 4, june: 5, jun: 5, july: 6, jul: 6, august: 7, aug: 7,
  september: 8, sep: 8, sept: 8, october: 9, oct: 9, november: 10, nov: 10,
  december: 11, dec: 11,
};

// Find the offset (ms) of a timezone at a given UTC instant — uses Intl to invert.
function tzOffsetMs(tz: string, utcMs: number): number {
  // Format the instant in the target tz, then parse back as UTC components.
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const parts = dtf.formatToParts(new Date(utcMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - utcMs;
}

// Compute the UTC instant that corresponds to "end of <Y-M-D> 23:59:59" in the given tz.
function endOfDayInTz(year: number, month0: number, day: number, tz: string): number {
  // Approximate: assume the offset at noon of that day, then refine once.
  const guess = Date.UTC(year, month0, day, 23, 59, 59);
  const off = tzOffsetMs(tz, guess);
  return guess - off;
}

// Try to extract a date (year/month/day) from the sub-market or event text — e.g.
// "Highest temperature in London on April 22" or "Will the highest temp be 12°C on April 22?".
function extractMarketDate(text: string, fallbackYear: number): { y: number; m: number; d: number } | null {
  // Pattern: "April 22" or "April 22, 2026" or "Apr 22 '26"
  const re1 = /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(\d{1,2})(?:[,\s]+(?:'?(\d{2,4})))?/i;
  const m = text.match(re1);
  if (m) {
    const month = MONTHS[m[1].toLowerCase()];
    const day = parseInt(m[2], 10);
    let year = fallbackYear;
    if (m[3]) {
      const yr = parseInt(m[3], 10);
      year = yr < 100 ? 2000 + yr : yr;
    }
    if (Number.isFinite(month) && day >= 1 && day <= 31) return { y: year, m: month, d: day };
  }
  return null;
}

function detectCity(text: string): string | null {
  const lower = text.toLowerCase();
  for (const k of Object.keys(KNOWN_CITIES)) {
    if (new RegExp(`\\b${k.replace(/ /g, "\\s+")}\\b`, "i").test(lower)) return KNOWN_CITIES[k];
  }
  const m = text.match(/\bin\s+([A-Z][A-Za-z .'-]+?)(?:\s+on\b|\s+be\b|\?|$)/);
  return m ? m[1].trim() : null;
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

async function discoverEvents(): Promise<any[]> {
  const seen = new Map<string, any>();
  const urls = [
    "https://gamma-api.polymarket.com/events?tag_slug=weather&closed=false&active=true&limit=200",
    "https://gamma-api.polymarket.com/events?tag_slug=climate&closed=false&active=true&limit=100",
    "https://gamma-api.polymarket.com/events?closed=false&active=true&limit=100&query=temperature",
    "https://gamma-api.polymarket.com/events?closed=false&active=true&limit=100&query=highest%20temp",
    "https://gamma-api.polymarket.com/events?closed=false&active=true&limit=100&query=lowest%20temp",
    "https://gamma-api.polymarket.com/events?closed=false&active=true&limit=100&query=hottest",
    "https://gamma-api.polymarket.com/events?closed=false&active=true&limit=100&query=coldest",
    "https://gamma-api.polymarket.com/events?closed=false&active=true&limit=100&query=weather",
    "https://gamma-api.polymarket.com/events?closed=false&active=true&limit=100&query=rain",
    "https://gamma-api.polymarket.com/events?closed=false&active=true&limit=100&query=snow",
  ];
  for (const url of urls) {
    try {
      const r = await fetch(url);
      if (!r.ok) continue;
      const j = await r.json();
      const arr = Array.isArray(j) ? j : (j?.events ?? []);
      for (const ev of arr) {
        const title = String(ev?.title ?? "").toLowerCase();
        if (!/temperature|temp|°|degree|hot|cold|weather|rain|snow|precip/.test(title)) continue;
        if (ev?.id && !seen.has(String(ev.id))) seen.set(String(ev.id), ev);
      }
    } catch { /* skip */ }
  }
  return Array.from(seen.values());
}

async function fetchMid(tokenId: string): Promise<number | null> {
  try {
    const r = await fetch(`https://clob.polymarket.com/midpoint?token_id=${tokenId}`);
    if (!r.ok) return null;
    const j = await r.json();
    const m = Number(j?.mid);
    return Number.isFinite(m) ? m : null;
  } catch { return null; }
}

async function fetchHistory(tokenId: string): Promise<HistPoint[]> {
  try {
    const r = await fetch(`https://clob.polymarket.com/prices-history?market=${tokenId}&interval=1d&fidelity=60`);
    if (!r.ok) return [];
    const j = await r.json();
    return ((j?.history ?? []) as any[])
      .map((h) => ({ t: Number(h.t) * 1000, p: Number(h.p) }))
      .filter((h) => Number.isFinite(h.t) && Number.isFinite(h.p))
      .sort((a, b) => a.t - b.t);
  } catch { return []; }
}

function priceAt(hist: HistPoint[], targetTs: number): number | null {
  if (hist.length === 0) return null;
  let best: HistPoint | null = null;
  let bestDelta = Infinity;
  for (const h of hist) {
    const d = Math.abs(h.t - targetTs);
    if (d < bestDelta) { bestDelta = d; best = h; }
  }
  if (!best || bestDelta > 90 * 60 * 1000) return null;
  return best.p;
}

function eventEndTime(ev: any, city: string | null): number | null {
  const subs: any[] = Array.isArray(ev?.markets) ? ev.markets : [];
  const tz = city ? CITY_TZ[city] : null;

  // 1) BEST: parse the resolution date out of the question/title text and combine with city TZ
  //    → end-of-day in city local time (e.g. "April 22" in London = 23:59:59 BST on Apr 22).
  if (tz) {
    const fallbackYear = new Date().getUTCFullYear();
    const texts: string[] = [];
    if (ev?.title) texts.push(String(ev.title));
    for (const s of subs) {
      if (s?.question) texts.push(String(s.question));
      if (s?.groupItemTitle) texts.push(String(s.groupItemTitle));
    }
    for (const t of texts) {
      const dt = extractMarketDate(t, fallbackYear);
      if (dt) {
        // If extracted date is far in the past, bump year forward (year wraparound near Jan).
        let { y, m, d } = dt;
        const now = Date.now();
        let candidate = endOfDayInTz(y, m, d, tz);
        if (candidate < now - 12 * 3_600_000) candidate = endOfDayInTz(y + 1, m, d, tz);
        return candidate;
      }
    }
  }

  // 2) gameStartTime is when the *resolution day starts* in city local time.
  //    For daily markets this means trading actually closes ~24h later (end of that local day).
  //    Add 24h as the trading-close boundary.
  let earliestGameStart = Infinity;
  for (const s of subs) {
    const raw = s?.gameStartTime;
    if (!raw) continue;
    const iso = String(raw).replace(" ", "T").replace("+00", "+00:00");
    const t = Date.parse(iso);
    if (Number.isFinite(t) && t < earliestGameStart) earliestGameStart = t;
  }
  if (Number.isFinite(earliestGameStart)) return earliestGameStart + 24 * 3_600_000;

  // 3) Fallback to event endDate (resolution finalization — usually noon UTC after close).
  const candidates = [ev?.endDate, ev?.end_date_iso, ev?.endDateIso];
  for (const c of candidates) {
    const t = c ? Date.parse(String(c)) : NaN;
    if (Number.isFinite(t)) return t;
  }
  // 4) Final fallback: earliest sub endDate.
  let earliest = Infinity;
  for (const s of subs) {
    const t = s?.endDate ? Date.parse(String(s.endDate)) : NaN;
    if (Number.isFinite(t) && t < earliest) earliest = t;
  }
  return Number.isFinite(earliest) ? earliest : null;
}

function extractSlugFromUrl(url: string): string | null {
  try {
    const u = new URL(url.trim());
    // Expected: /event/<slug> or /event/<slug>/<market-slug>
    const parts = u.pathname.split("/").filter(Boolean);
    const idx = parts.indexOf("event");
    if (idx >= 0 && parts[idx + 1]) return parts[idx + 1];
    // Fallback: last non-empty segment
    return parts[parts.length - 1] ?? null;
  } catch { return null; }
}

async function fetchEventBySlug(slug: string): Promise<any | null> {
  try {
    const r = await fetch(`https://gamma-api.polymarket.com/events?slug=${encodeURIComponent(slug)}`);
    if (!r.ok) return null;
    const j = await r.json();
    const arr = Array.isArray(j) ? j : (j?.events ?? []);
    return arr[0] ?? null;
  } catch { return null; }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    // Optional body: { gap_min?: number, max_hours?: number, event_url?: string }.
    let gapMin = DEFAULT_GAP_MIN;
    let maxHours = MAX_HOURS;
    let singleEventUrl: string | null = null;
    try {
      if (req.method === "POST") {
        const body = await req.json().catch(() => null);
        const v = Number(body?.gap_min);
        if (Number.isFinite(v) && v > 0 && v < 1) gapMin = v;
        const h = Number(body?.max_hours);
        if (Number.isFinite(h) && h > 0 && h <= 72) maxHours = h;
        if (typeof body?.event_url === "string" && body.event_url.trim()) {
          singleEventUrl = body.event_url.trim();
        }
      }
    } catch { /* ignore */ }

    const now = Date.now();
    const target1h = now - 3_600_000;

    // Single-event mode: fetch by slug, skip time-window + gap filters,
    // but keep gap-history & trajectory math so the UI looks the same.
    const singleMode = !!singleEventUrl;
    let eligible: any[];
    if (singleMode) {
      const slug = extractSlugFromUrl(singleEventUrl!);
      if (!slug) {
        return new Response(JSON.stringify({ error: "Could not extract slug from URL" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const ev = await fetchEventBySlug(slug);
      if (!ev) {
        return new Response(JSON.stringify({ error: `Event not found for slug: ${slug}` }), {
          status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      eligible = [ev];
    } else {
      const events = await discoverEvents();
      // Filter to events ending within window. City is detected from title+sub-questions
      // so eventEndTime can compute end-of-day in the city's local timezone.
      eligible = events.filter((ev) => {
        const subs: any[] = Array.isArray(ev?.markets) ? ev.markets : [];
        const text = String(ev?.title ?? "") + " " + subs.map((s) => s?.question ?? "").join(" ");
        const city = detectCity(text);
        const t = eventEndTime(ev, city);
        if (t == null) return false;
        const hours = (t - now) / 3_600_000;
        return hours > MIN_HOURS && hours <= maxHours;
      });
    }

    type BucketOut = { label: string; clob_token_id: string; mid: number };
    type Result = {
      event_slug: string | null;
      event_title: string;
      city: string | null;
      event_time: string | null;
      polymarket_url: string | null;
      leader_label: string;
      runner_label: string;
      leader_now: number;
      gap_now: number;
      gap_1h: number;
      gap_2h: number;
      net_delta: number;
      trajectory: Trajectory;
      /** All sub-market buckets with live mid prices. UI uses these to render the full bucket table. */
      buckets: BucketOut[];
    };
    const results: Result[] = [];

    const BATCH = 4;
    for (let i = 0; i < eligible.length; i += BATCH) {
      const batch = eligible.slice(i, i + BATCH);
      await Promise.all(batch.map(async (ev) => {
        const subs: any[] = Array.isArray(ev?.markets) ? ev.markets : [];
        if (subs.length < 2) return;

        const enriched = await Promise.all(subs.map(async (sm) => {
          if (sm?.closed === true || sm?.archived === true) return null;
          const tokens = tokensFromMarket(sm);
          const tokenId = tokens[0];
          if (!tokenId) return null;
          const label = String(sm?.groupItemTitle ?? sm?.outcomes?.[0] ?? sm?.question ?? "?");
          const mid = await fetchMid(tokenId);
          if (mid == null) return null;
          return { label, tokenId, mid };
        }));
        const valid = enriched.filter(Boolean) as { label: string; tokenId: string; mid: number }[];
        if (valid.length < 2) return;

        valid.sort((a, b) => b.mid - a.mid);
        const leader = valid[0];
        const runner = valid[1];
        const gapNow = leader.mid - runner.mid;
        // High-temperature markets ("highest", "hottest", "warmest", "high temp")
        // are never filtered out — user wants full coverage of those.
        const evTitle = String(ev?.title ?? "").toLowerCase();
        const isHighTemp = /\b(highest|hottest|warmest|high\s+temp)/.test(evTitle);
        // In single-event mode or high-temp mode, bypass gap/price filters so
        // every qualifying event renders even if it doesn't meet momentum thresholds.
        if (!singleMode && !isHighTemp && (gapNow < gapMin || leader.mid > MAX_ENTRY_PRICE)) return;

        const [lh, rh] = await Promise.all([fetchHistory(leader.tokenId), fetchHistory(runner.tokenId)]);
        const l1h = priceAt(lh, target1h);
        const r1h = priceAt(rh, target1h);
        // 1h gap is informational only (used for trajectory). Fresh widenings (no 1h history
        // or gap_1h < gapMin) still qualify as long as gap_now meets the threshold.
        const gap1h = (l1h != null && r1h != null) ? l1h - r1h : gapNow;

        const target2h = now - 2 * 3_600_000;
        const l2h = priceAt(lh, target2h);
        const r2h = priceAt(rh, target2h);
        const gap2h = (l2h != null && r2h != null) ? l2h - r2h : gap1h;
        const d1 = gap1h - gap2h;
        const d2 = gapNow - gap1h;
        const netDelta = gapNow - gap2h;
        let trajectory: Trajectory;
        if (d1 > 0 && d2 > 0 && d2 >= d1) trajectory = "accelerating";
        else if (netDelta > FLAT_BAND) trajectory = "widening";
        else if (netDelta < -FLAT_BAND) trajectory = "narrowing";
        else trajectory = "flat";

        const slug = ev?.slug ?? null;
        const text = String(ev?.title ?? "") + " " + subs.map((s) => s?.question ?? "").join(" ");
        const city = detectCity(text);
        const endTs = eventEndTime(ev, city);
        results.push({
          event_slug: slug,
          event_title: String(ev?.title ?? "Untitled"),
          city,
          event_time: endTs ? new Date(endTs).toISOString() : null,
          polymarket_url: slug ? `https://polymarket.com/event/${slug}` : null,
          leader_label: leader.label,
          runner_label: runner.label,
          leader_now: leader.mid,
          gap_now: gapNow,
          gap_1h: gap1h,
          gap_2h: gap2h,
          net_delta: netDelta,
          trajectory,
          buckets: valid.map((v) => ({ label: v.label, clob_token_id: v.tokenId, mid: v.mid })),
        });
      }));
    }

    const rank: Record<Trajectory, number> = { accelerating: 0, widening: 1, flat: 2, narrowing: 3 };
    results.sort((a, b) => rank[a.trajectory] - rank[b.trajectory] || b.net_delta - a.net_delta);

    return new Response(JSON.stringify({
      ok: true,
      scanned: eligible.length,
      qualified: results.length,
      results,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String((e as Error).message ?? e) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
