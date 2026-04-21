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

function eventEndTime(ev: any): number | null {
  const candidates = [ev?.endDate, ev?.end_date_iso, ev?.endDateIso];
  for (const c of candidates) {
    const t = c ? Date.parse(String(c)) : NaN;
    if (Number.isFinite(t)) return t;
  }
  // Fall back to earliest sub-market endDate
  const subs: any[] = Array.isArray(ev?.markets) ? ev.markets : [];
  let earliest = Infinity;
  for (const s of subs) {
    const t = s?.endDate ? Date.parse(String(s.endDate)) : NaN;
    if (Number.isFinite(t) && t < earliest) earliest = t;
  }
  return Number.isFinite(earliest) ? earliest : null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    // Optional body: { gap_min?: number, max_hours?: number }.
    let gapMin = DEFAULT_GAP_MIN;
    let maxHours = MAX_HOURS;
    try {
      if (req.method === "POST") {
        const body = await req.json().catch(() => null);
        const v = Number(body?.gap_min);
        if (Number.isFinite(v) && v > 0 && v < 1) gapMin = v;
        const h = Number(body?.max_hours);
        if (Number.isFinite(h) && h > 0 && h <= 72) maxHours = h;
      }
    } catch { /* ignore */ }

    const events = await discoverEvents();
    const now = Date.now();
    const target1h = now - 3_600_000;

    // Filter to events ending within window
    const eligible = events.filter((ev) => {
      const t = eventEndTime(ev);
      if (t == null) return false;
      const hours = (t - now) / 3_600_000;
      return hours > MIN_HOURS && hours <= maxHours;
    });

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
        if (gapNow < gapMin || leader.mid > MAX_ENTRY_PRICE) return;

        const [lh, rh] = await Promise.all([fetchHistory(leader.tokenId), fetchHistory(runner.tokenId)]);
        const l1h = priceAt(lh, target1h);
        const r1h = priceAt(rh, target1h);
        if (l1h == null || r1h == null) return;
        const gap1h = l1h - r1h;
        if (gap1h < gapMin) return;

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
        const endTs = eventEndTime(ev);
        const text = String(ev?.title ?? "") + " " + subs.map((s) => s?.question ?? "").join(" ");
        results.push({
          event_slug: slug,
          event_title: String(ev?.title ?? "Untitled"),
          city: detectCity(text),
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
