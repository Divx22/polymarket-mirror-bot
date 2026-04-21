import { useEffect, useRef, useState } from "react";
import { TrendingUp, Loader2, Copy, Check, RefreshCw, Globe, ExternalLink, Clock, ChevronDown, BookmarkPlus } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { type WeatherMarket, type WeatherOutcome, decideAction, type ActionDecision, type WeatherState, type MomentumMode } from "@/lib/weather";
import { fetchOpenMeteoSnapshot, peakFromForecast, type OpenMeteoSnapshot } from "@/lib/openMeteo";
import { compareToMarket, cToF, type MarketVerdict, type ProjectionResult, type BucketLike } from "@/lib/weatherProjection";
import { detectTempExtreme } from "@/lib/tempExtreme";
import { formatLocalCloseTime, peakWeatherTimeMs, formatLocalHour } from "@/lib/cityTimezones";
import { parseBucketLabel, geocodeCity } from "@/lib/bucketParser";
import { logEdgeTrade, fairPriceFromProjection, type LogEdgeTradeInput } from "@/lib/edgeTrades";
import { cn } from "@/lib/utils";

type Props = {
  markets: WeatherMarket[];
  outcomes: Record<string, WeatherOutcome[]>;
  onSelect?: (m: WeatherMarket) => void;
  /** Minimum gap (0–1) between #1 and #2 outcomes required at "now" AND "1h ago". Default 0.10. */
  gapMin?: number;
  /** Allow user to change the threshold via a slider in the panel header. Default true. */
  showThresholdControl?: boolean;
  /** User's bankroll in USDC (used to suggest stake $). Default 1000. */
  bankroll?: number;
  /** Hard cap on suggested stake as % of bankroll. Default 3. */
  stakeCapPct?: number;
};

const DEFAULT_GAP_MIN = 0.10;
const MAX_ENTRY_PRICE = 0.95;
const MIN_HOURS_TO_EVENT = 0.5;
const FLAT_BAND = 0.01;
const WINDOW_OPTIONS = [8, 12, 24] as const;
type WindowHours = typeof WINDOW_OPTIONS[number];
const DEFAULT_WINDOW: WindowHours = 12;

type Trajectory = "accelerating" | "widening" | "flat" | "narrowing";
type HistPoint = { t: number; p: number };

type Movement = {
  source: "local";
  market: WeatherMarket;
  leader: WeatherOutcome;
  runnerUp: WeatherOutcome;
  leaderNow: number;
  gap2h: number;
  gap1h: number;
  gapNow: number;
  netDelta: number;
  trajectory: Trajectory;
  volLast: number | null;
  volPrev: number | null;
  weather: OpenMeteoSnapshot | null;
  liveMids: Record<string, number>;
};

type ExternalMovement = {
  source: "external";
  event_title: string;
  event_slug: string | null;
  city: string | null;
  event_time: string | null;
  polymarket_url: string | null;
  leader_label: string;
  runner_label: string;
  leaderNow: number;
  gap2h: number;
  gap1h: number;
  gapNow: number;
  netDelta: number;
  trajectory: Trajectory;
  /** Coords resolved from local markets or Open-Meteo geocoding (post-discover). */
  lat: number | null;
  lon: number | null;
  /** Open-Meteo snapshot, fetched after discover so the WX verdict can run. */
  weather: OpenMeteoSnapshot | null;
  /** All sub-market buckets with live mids (from discover payload) so we can render the full table. */
  allBuckets: Array<{ label: string; clob_token_id: string; mid: number }>;
};

type AnyMove = Movement | ExternalMovement;

async function fetchHistory(tokenId: string): Promise<HistPoint[]> {
  const url = `https://clob.polymarket.com/prices-history?market=${tokenId}&interval=1d&fidelity=60`;
  try {
    const r = await fetch(url);
    if (!r.ok) return [];
    const j = await r.json();
    return ((j?.history ?? []) as any[])
      .map((h) => ({ t: Number(h.t) * 1000, p: Number(h.p) }))
      .filter((h) => Number.isFinite(h.t) && Number.isFinite(h.p))
      .sort((a, b) => a.t - b.t);
  } catch { return []; }
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

/** Fetch recent trades for an outcome and bucket USDC volume into two 15-minute windows.
 *  Polymarket's public data-api `/trades` filters by **conditionId** (not tokenId),
 *  so we pass conditionId and then filter rows by `asset === tokenId` client-side.
 *  Returns null buckets when the underlying API call fails so the UI can show "n/a".
 *  An empty bucket (real $0) is returned as 0, which the decision engine treats as flat. */
async function fetchRecentVolume(
  tokenId: string,
  conditionId?: string | null,
): Promise<{ last10m: number | null; prev10m: number | null }> {
  if (!conditionId) return { last10m: null, prev10m: null };
  try {
    const r = await fetch(
      `https://data-api.polymarket.com/trades?market=${conditionId}&limit=500&takerOnly=false`,
    );
    if (!r.ok) return { last10m: null, prev10m: null };
    const j = await r.json();
    const trades: any[] = Array.isArray(j) ? j : (j?.data ?? []);
    const now = Date.now();
    // 15-min buckets give quiet weather markets a better chance of usable signal
    // while still being recent enough to reflect momentum.
    const t15 = now - 15 * 60_000;
    const t30 = now - 30 * 60_000;
    let last = 0, prev = 0;
    for (const tr of trades) {
      if (String(tr?.asset ?? "") !== tokenId) continue; // condition has 2 tokens; keep ours
      const tsRaw = Number(tr?.timestamp ?? tr?.match_time ?? tr?.t ?? 0);
      // data-api returns seconds; normalize either way.
      const ts = tsRaw > 1e12 ? tsRaw : tsRaw * 1000;
      if (!Number.isFinite(ts) || ts < t30) continue;
      const price = Number(tr?.price ?? 0);
      const size = Number(tr?.size ?? tr?.shares ?? 0);
      const usdc = Number.isFinite(price) && Number.isFinite(size) ? price * size : 0;
      if (ts >= t15) last += usdc;
      else if (ts >= t30) prev += usdc;
    }
    return { last10m: last, prev10m: prev };
  } catch {
    return { last10m: null, prev10m: null };
  }
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

// Momentum-weighted score: 0.4·upside + 0.3·gapNow + 0.3·netDelta + trajectory bonus.
// Higher = stronger momentum pick.
const TRAJ_BONUS: Record<Trajectory, number> = {
  accelerating: 0.05,
  widening: 0.02,
  flat: 0,
  narrowing: -0.05,
};
function momentumScore(leaderNow: number, gapNow: number, netDelta: number, trajectory: Trajectory): number {
  const upside = 1 - leaderNow;
  return 0.4 * upside + 0.3 * gapNow + 0.3 * netDelta + (TRAJ_BONUS[trajectory] ?? 0);
}

// Suggest a stake $ for a momentum pick.
// Long-term strategy: scale by score within [0..MAX_SCORE], cap at stakeCapPct% of bankroll.
// MAX_SCORE ~ 0.45 = strong upside (50%) + wide gap (30%) + big widening (10%) + accel bonus (5%).
const MAX_SCORE = 0.45;
function suggestStake(bankroll: number, stakeCapPct: number, score: number): number {
  if (!Number.isFinite(bankroll) || bankroll <= 0) return 0;
  const cap = bankroll * (stakeCapPct / 100);
  const ratio = Math.max(0, Math.min(1, score / MAX_SCORE));
  // Floor at 25% of cap so qualified picks always show a non-trivial size.
  const stake = cap * Math.max(0.25, ratio);
  return Math.round(stake);
}

// Smart bid for a "best value" mispricing — Kelly-lite.
// Inputs: edge in pp (e.g. +32), action confidence 0–100, bankroll $, hard cap %.
// Sizing: edgeRatio (saturates at 30pp) × confRatio (0..1) × cap. Floor 10% of cap when ≥ +7pp.
// Returns 0 when edge < +7pp (no real value).
function suggestSmartBid(
  edgePp: number | null | undefined,
  confidence: number | null | undefined,
  bankroll: number,
  stakeCapPct: number,
): number {
  if (!Number.isFinite(bankroll) || bankroll <= 0) return 0;
  const e = Number(edgePp ?? 0);
  if (!Number.isFinite(e) || e < 7) return 0;
  const cap = bankroll * (stakeCapPct / 100);
  const edgeRatio = Math.min(1, e / 30);
  const confRatio = Math.max(0, Math.min(1, Number(confidence ?? 50) / 100));
  const raw = cap * edgeRatio * confRatio;
  const floor = cap * 0.10;
  return Math.round(Math.max(floor, raw));
}

export const MomentumBreakouts = ({
  markets, outcomes, onSelect, gapMin: gapMinProp, showThresholdControl = true,
  bankroll = 1000, stakeCapPct = 3,
}: Props) => {
  const [scanning, setScanning] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [items, setItems] = useState<Movement[]>([]);
  const [externals, setExternals] = useState<ExternalMovement[]>([]);
  const [scannedAt, setScannedAt] = useState<number | null>(null);
  const [progress, setProgress] = useState(0);
  // Threshold (0–1). Editable via slider when showThresholdControl is true.
  const [gapMin, setGapMin] = useState<number>(gapMinProp ?? DEFAULT_GAP_MIN);
  // Resolution window in hours. User-selectable: 8 / 12 / 24.
  const [windowHours, setWindowHours] = useState<WindowHours>(DEFAULT_WINDOW);
  const [detectingIds, setDetectingIds] = useState<Set<string>>(new Set());
  const [singleUrl, setSingleUrl] = useState<string>("");
  const [analyzingUrl, setAnalyzingUrl] = useState(false);

  const detectResolution = async (marketId: string) => {
    setDetectingIds((s) => new Set(s).add(marketId));
    try {
      await supabase.functions.invoke("weather-detect-resolution", { body: { market_id: marketId } });
      // Force a reload of the page so the updated resolution_method flows through.
      window.location.reload();
    } catch (e) {
      console.error("detect-resolution failed", e);
    } finally {
      setDetectingIds((s) => { const n = new Set(s); n.delete(marketId); return n; });
    }
  };

  // One-shot backfill on mount: classify any active market without a method yet.
  useEffect(() => {
    supabase.functions.invoke("weather-detect-resolution", { body: { all_pending: true } }).catch(() => {});
  }, []);


  const scan = async () => {
    setScanning(true);
    setItems([]);
    setProgress(0);

    const eligible = markets.filter((m) => {
      const hours = (new Date(m.event_time).getTime() - Date.now()) / 3_600_000;
      return hours > MIN_HOURS_TO_EVENT && hours <= windowHours;
    });

    const found: Movement[] = [];
    const target1h = Date.now() - 1 * 3_600_000;
    const target2h = Date.now() - 2 * 3_600_000;

    let done = 0;
    const BATCH = 4;
    for (let i = 0; i < eligible.length; i += BATCH) {
      const batch = eligible.slice(i, i + BATCH);
      await Promise.all(batch.map(async (m) => {
        const outs = (outcomes[m.id] ?? []).filter(o => o.clob_token_id);
        if (outs.length < 2) return;

        const liveMids = await Promise.all(outs.map(o => fetchMid(o.clob_token_id!)));
        // Only rank outcomes with a fresh live midpoint — mixing stale DB prices
        // produces wrong leader/runner pairs.
        const enriched = outs
          .map((o, i) => ({ o, mid: liveMids[i] }))
          .filter((e): e is { o: typeof e.o; mid: number } => e.mid != null && Number.isFinite(e.mid));
        if (enriched.length < 2) return;
        enriched.sort((a, b) => b.mid - a.mid);

        const leader = enriched[0].o;
        const runnerUp = enriched[1].o;
        const leaderNow = enriched[0].mid;
        const gapNow = leaderNow - enriched[1].mid;

        if (gapNow < gapMin) return;
        if (leaderNow > MAX_ENTRY_PRICE) return;

        const [leaderHist, runnerHist] = await Promise.all([
          fetchHistory(leader.clob_token_id!),
          fetchHistory(runnerUp.clob_token_id!),
        ]);
        const leader1h = priceAt(leaderHist, target1h);
        const runner1h = priceAt(runnerHist, target1h);
        if (leader1h == null || runner1h == null) return;

        const gap1h = leader1h - runner1h;
        if (gap1h < gapMin) return;

        const leader2h = priceAt(leaderHist, target2h);
        const runner2h = priceAt(runnerHist, target2h);
        const gap2h = (leader2h != null && runner2h != null) ? (leader2h - runner2h) : gap1h;

        const d1 = gap1h - gap2h;
        const d2 = gapNow - gap1h;
        const netDelta = gapNow - gap2h;

        let trajectory: Trajectory;
        if (d1 > 0 && d2 > 0 && d2 >= d1) trajectory = "accelerating";
        else if (netDelta > FLAT_BAND) trajectory = "widening";
        else if (netDelta < -FLAT_BAND) trajectory = "narrowing";
        else trajectory = "flat";

        const [vol, weather] = await Promise.all([
          fetchRecentVolume(leader.clob_token_id!, leader.condition_id ?? null),
          fetchOpenMeteoSnapshot(m.latitude, m.longitude),
        ]);

        const liveMidsMap: Record<string, number> = {};
        enriched.forEach((e) => { liveMidsMap[e.o.id] = e.mid; });
        found.push({ source: "local", market: m, leader, runnerUp, leaderNow, gap2h, gap1h, gapNow, netDelta, trajectory, volLast: vol.last10m, volPrev: vol.prev10m, weather, liveMids: liveMidsMap });
      }));
      done += batch.length;
      setProgress(Math.round((done / eligible.length) * 100));
    }

    // Momentum-weighted sort.
    found.sort((a, b) =>
      momentumScore(b.leaderNow, b.gapNow, b.netDelta, b.trajectory) -
      momentumScore(a.leaderNow, a.gapNow, a.netDelta, a.trajectory),
    );

    setItems(found);
    setScannedAt(Date.now());
    setScanning(false);
  };

  const discover = async () => {
    setDiscovering(true);
    try {
      const { data, error } = await supabase.functions.invoke("weather-discover-momentum", {
        body: { gap_min: gapMin, max_hours: windowHours },
      });
      if (error) throw error;
      const results = (data?.results ?? []) as any[];
      // Build a coord lookup from the user's local markets so we avoid an
      // extra geocode call whenever possible.
      const coordsByCity = new Map<string, { lat: number; lon: number }>();
      for (const lm of markets) {
        if (lm.city && Number.isFinite(lm.latitude) && Number.isFinite(lm.longitude)) {
          coordsByCity.set(lm.city.trim().toLowerCase(), { lat: Number(lm.latitude), lon: Number(lm.longitude) });
        }
      }

      const enriched: ExternalMovement[] = await Promise.all(results.map(async (r) => {
        const city: string | null = r.city ?? null;
        let coords: { lat: number; lon: number } | null = null;
        if (city) {
          coords = coordsByCity.get(city.trim().toLowerCase()) ?? null;
          if (!coords) coords = await geocodeCity(city);
        }
        const weather = coords ? await fetchOpenMeteoSnapshot(coords.lat, coords.lon) : null;
        return {
          source: "external",
          event_title: r.event_title,
          event_slug: r.event_slug,
          city,
          event_time: r.event_time,
          polymarket_url: r.polymarket_url,
          leader_label: r.leader_label,
          runner_label: r.runner_label,
          leaderNow: r.leader_now,
          gap2h: r.gap_2h ?? r.gap_1h,
          gap1h: r.gap_1h,
          gapNow: r.gap_now,
          netDelta: r.net_delta,
          trajectory: r.trajectory,
          lat: coords?.lat ?? null,
          lon: coords?.lon ?? null,
          weather,
          allBuckets: Array.isArray((r as any).buckets) ? (r as any).buckets : [],
        };
      }));

      // Same momentum-weighted sort as local results.
      enriched.sort((a, b) =>
        momentumScore(b.leaderNow, b.gapNow, b.netDelta, b.trajectory) -
        momentumScore(a.leaderNow, a.gapNow, a.netDelta, a.trajectory),
      );
      // Defensive client-side filter in case the function returns markets outside the window.
      const cutoffMs = Date.now() + windowHours * 3_600_000;
      const filtered = enriched.filter((m) => {
        if (!m.event_time) return true;
        const t = Date.parse(m.event_time);
        return !Number.isFinite(t) || t <= cutoffMs;
      });
      setExternals(filtered);
    } catch (e: any) {
      console.error("Discover failed", e);
    } finally {
      setDiscovering(false);
    }
  };

  const analyzeUrl = async () => {
    const url = singleUrl.trim();
    if (!url) return;
    if (!/polymarket\.com\/event\//i.test(url)) {
      toast.error("Paste a Polymarket event URL (https://polymarket.com/event/…)");
      return;
    }
    setAnalyzingUrl(true);
    try {
      const { data, error } = await supabase.functions.invoke("weather-discover-momentum", {
        body: { event_url: url, gap_min: gapMin, max_hours: 720 },
      });
      if (error) throw error;
      const results = (data?.results ?? []) as any[];
      if (results.length === 0) {
        toast.error("No tradable buckets found for that event.");
        return;
      }
      const r = results[0];
      const city: string | null = r.city ?? null;
      let coords: { lat: number; lon: number } | null = null;
      if (city) {
        const local = markets.find((lm) => lm.city?.trim().toLowerCase() === city.trim().toLowerCase());
        if (local && Number.isFinite(local.latitude) && Number.isFinite(local.longitude)) {
          coords = { lat: Number(local.latitude), lon: Number(local.longitude) };
        } else {
          coords = await geocodeCity(city);
        }
      }
      const weather = coords ? await fetchOpenMeteoSnapshot(coords.lat, coords.lon) : null;
      const ext: ExternalMovement = {
        source: "external",
        event_title: r.event_title,
        event_slug: r.event_slug,
        city,
        event_time: r.event_time,
        polymarket_url: r.polymarket_url ?? url,
        leader_label: r.leader_label,
        runner_label: r.runner_label,
        leaderNow: r.leader_now,
        gap2h: r.gap_2h ?? r.gap_1h,
        gap1h: r.gap_1h,
        gapNow: r.gap_now,
        netDelta: r.net_delta,
        trajectory: r.trajectory,
        lat: coords?.lat ?? null,
        lon: coords?.lon ?? null,
        weather,
        allBuckets: Array.isArray(r.buckets) ? r.buckets : [],
      };
      // Replace any existing entry for the same slug, then prepend.
      setExternals((prev) => {
        const filtered = prev.filter((e) => !ext.event_slug || e.event_slug !== ext.event_slug);
        return [ext, ...filtered];
      });
      setSingleUrl("");
      toast.success(`Loaded "${ext.event_title}"`);
    } catch (e: any) {
      console.error("analyzeUrl failed", e);
      toast.error(e?.message ?? "Failed to analyze URL");
    } finally {
      setAnalyzingUrl(false);
    }
  };

  useEffect(() => {
    // Re-scan local list whenever the window changes so the visible set matches.
    if (markets.length > 0 && !scanning) scan();
    // Also re-filter any externals already loaded.
    if (externals.length > 0) {
      const cutoffMs = Date.now() + windowHours * 3_600_000;
      setExternals((prev) => prev.filter((m) => {
        if (!m.event_time) return true;
        const t = Date.parse(m.event_time);
        return !Number.isFinite(t) || t <= cutoffMs;
      }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [windowHours]);

  return (
    <div className="rounded-lg border border-border bg-card overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 border-b border-border bg-surface-2/40">
        <div className="flex items-center gap-2">
          <TrendingUp className="h-4 w-4 text-blue-400" />
          <div>
            <div className="text-xs font-semibold uppercase tracking-wider">Momentum</div>
            <div className="text-[10px] text-muted-foreground">
              Closing within {windowHours}h. Gap #1 vs #2 ≥{Math.round(gapMin * 100)}% now AND 1h ago.
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1 mr-2">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground mr-1">Window</span>
          {WINDOW_OPTIONS.map((h) => (
            <button
              key={h}
              onClick={() => setWindowHours(h)}
              className={cn(
                "px-2 py-0.5 rounded border text-[11px] font-mono-num",
                windowHours === h
                  ? "border-primary bg-primary/15 text-primary"
                  : "border-border bg-background hover:bg-surface-2 text-muted-foreground",
              )}
            >
              {h}h
            </button>
          ))}
        </div>
        {showThresholdControl && (
          <div className="hidden md:flex items-center gap-2 mr-2">
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Min gap</span>
            <input
              type="range"
              min={5}
              max={30}
              step={1}
              value={Math.round(gapMin * 100)}
              onChange={(e) => setGapMin(Number(e.target.value) / 100)}
              className="w-24 accent-primary"
              aria-label="Minimum gap percentage"
            />
            <input
              type="number"
              min={5}
              max={50}
              step={1}
              value={Math.round(gapMin * 100)}
              onChange={(e) => {
                const v = Math.max(1, Math.min(50, Number(e.target.value) || 0));
                setGapMin(v / 100);
              }}
              className="w-12 rounded border border-border bg-background px-1.5 py-0.5 text-xs font-mono-num text-foreground"
            />
            <span className="text-[10px] text-muted-foreground">%</span>
          </div>
        )}
        <div className="flex items-center gap-1.5">
          <button
            onClick={discover}
            disabled={discovering}
            className="inline-flex items-center gap-1.5 rounded border border-border bg-background hover:bg-surface-2 px-2.5 py-1 text-[11px] disabled:opacity-50"
            title="Scan ALL Polymarket temperature markets (next 48h)"
          >
            {discovering ? <Loader2 className="h-3 w-3 animate-spin" /> : <Globe className="h-3 w-3" />}
            {discovering ? "Discovering…" : "Discover"}
          </button>
          <button
            onClick={scan}
            disabled={scanning}
            className="inline-flex items-center gap-1.5 rounded border border-border bg-background hover:bg-surface-2 px-2.5 py-1 text-[11px] disabled:opacity-50"
          >
            {scanning ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
            {scanning ? `${progress}%` : "Rescan"}
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5 px-4 py-2 border-b border-border bg-surface-2/20">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground mr-1">Analyze URL</span>
        <input
          type="url"
          placeholder="https://polymarket.com/event/…"
          value={singleUrl}
          onChange={(e) => setSingleUrl(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") analyzeUrl(); }}
          disabled={analyzingUrl}
          className="flex-1 min-w-[200px] rounded border border-border bg-background px-2 py-1 text-[11px] font-mono-num text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-50"
        />
        <button
          onClick={analyzeUrl}
          disabled={analyzingUrl || !singleUrl.trim()}
          className="inline-flex items-center gap-1.5 rounded border border-border bg-background hover:bg-surface-2 px-2.5 py-1 text-[11px] disabled:opacity-50"
          title="Discover and chart this single Polymarket event"
        >
          {analyzingUrl ? <Loader2 className="h-3 w-3 animate-spin" /> : <ExternalLink className="h-3 w-3" />}
          {analyzingUrl ? "Analyzing…" : "Analyze"}
        </button>
      </div>

      {scanning && items.length === 0 && (
        <div className="px-4 py-6 text-center text-xs text-muted-foreground">
          Checking {markets.length} market{markets.length === 1 ? "" : "s"}…
        </div>
      )}

      {(() => {
        const localSlugs = new Set(
          items.map((it) => it.market.polymarket_event_slug).filter(Boolean) as string[],
        );
        const dedupedExternals = externals.filter(
          (e) => !e.event_slug || !localSlugs.has(e.event_slug),
        );
        type Merged =
          | { kind: "local"; key: string; sortScore: number; data: Movement }
          | { kind: "ext"; key: string; sortScore: number; data: ExternalMovement };
        const merged: Merged[] = [
          ...items.map((it): Merged => ({
            kind: "local", key: `l-${it.market.id}`,
            sortScore: momentumScore(it.leaderNow, it.gapNow, it.netDelta, it.trajectory), data: it,
          })),
          ...dedupedExternals.map((e, i): Merged => ({
            kind: "ext", key: `e-${e.event_slug ?? i}`,
            sortScore: momentumScore(e.leaderNow, e.gapNow, e.netDelta, e.trajectory), data: e,
          })),
        ].sort((a, b) => b.sortScore - a.sortScore);

        if (!scanning && merged.length === 0 && scannedAt != null) {
          return (
            <div className="px-4 py-6 text-center text-xs text-muted-foreground">
              No markets qualified — try Discover to scan all of Polymarket.
            </div>
          );
        }
        if (merged.length === 0) return null;
        return (
          <div className="p-3 sm:p-4 grid grid-cols-1 lg:grid-cols-2 gap-3">
            {merged.map((row) => {
              const stake = suggestStake(bankroll, stakeCapPct, row.sortScore);
              const stakePct = bankroll > 0 ? (stake / bankroll) * 100 : 0;
              return row.kind === "local"
                ? <Row key={row.key} m={row.data} outs={outcomes[row.data.market.id] ?? []} onSelect={onSelect} stake={stake} stakePct={stakePct} score={row.sortScore} bankroll={bankroll} stakeCapPct={stakeCapPct} onDetectResolution={detectResolution} detectingResolution={detectingIds.has(row.data.market.id)} />
                : <ExternalRow key={row.key} m={row.data} stake={stake} stakePct={stakePct} score={row.sortScore} bankroll={bankroll} stakeCapPct={stakeCapPct} />;
            })}
          </div>
        );
      })()}
    </div>
  );
};

const TRAJ_META: Record<Trajectory, { label: string; badge: string; arrow: string }> = {
  accelerating: { label: "Accelerating", badge: "bg-emerald-500/25 text-emerald-200 border-emerald-400/60 shadow-[0_0_8px_hsl(142_72%_48%/0.35)]", arrow: "text-emerald-400" },
  widening:     { label: "Widening",     badge: "bg-emerald-500/20 text-emerald-200 border-emerald-400/50",                                       arrow: "text-emerald-400" },
  flat:         { label: "Flat",         badge: "bg-amber-500/20 text-amber-200 border-amber-400/50",                                             arrow: "text-amber-300" },
  narrowing:    { label: "Narrowing",    badge: "bg-red-500/25 text-red-200 border-red-400/60 shadow-[0_0_8px_hsl(0_72%_55%/0.35)]",              arrow: "text-red-400" },
};

// Countdown timer hook
const useCountdown = (targetTime: string | null | undefined) => {
  const [timeLeft, setTimeLeft] = useState<{ hours: number; minutes: number; seconds: number; totalMs: number } | null>(null);
  
  useEffect(() => {
    if (!targetTime) return;
    const target = new Date(targetTime).getTime();
    if (!Number.isFinite(target)) return;
    
    const tick = () => {
      const now = Date.now();
      const diff = target - now;
      if (diff <= 0) {
        setTimeLeft({ hours: 0, minutes: 0, seconds: 0, totalMs: 0 });
        return;
      }
      const hours = Math.floor(diff / (1000 * 60 * 60));
      const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
      const seconds = Math.floor((diff % (1000 * 60)) / 1000);
      setTimeLeft({ hours, minutes, seconds, totalMs: diff });
    };
    
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [targetTime]);
  
  return timeLeft;
};

// Live local-time formatter for a city/coords. Re-renders every second.
const useNowInLocation = (loc: { city?: string | null; lat?: number | null; lon?: number | null }): string | null => {
  const [now, setNow] = useState<string | null>(() => formatLocalHour(Date.now(), loc));
  useEffect(() => {
    const tick = () => setNow(formatLocalHour(Date.now(), loc));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [loc.city, loc.lat, loc.lon]);
  return now;
};

// Countdown badge component — shows local close time + live countdown,
// plus a secondary "peak weather" countdown (4 PM local in city tz).
const CountdownBadge = ({
  eventTime, city, lat, lon, urgent,
}: { eventTime: string | null | undefined; city?: string | null; lat?: number | null; lon?: number | null; urgent?: boolean }) => {
  const timeLeft = useCountdown(eventTime);
  const loc = { city, lat, lon };
  const peakMs = peakWeatherTimeMs(eventTime, loc);
  const peakIso = peakMs != null ? new Date(peakMs).toISOString() : null;
  const peakLeft = useCountdown(peakIso);
  const nowLocal = useNowInLocation(loc);
  if (!timeLeft) return null;

  const { hours, minutes, seconds, totalMs } = timeLeft;
  const isUrgent = urgent || totalMs < 2 * 60 * 60 * 1000;
  const isWarning = totalMs < 4 * 60 * 60 * 1000;

  const colorClass = isUrgent
    ? "bg-red-500/20 text-red-300 border-red-400/50"
    : isWarning
      ? "bg-amber-500/20 text-amber-300 border-amber-400/50"
      : "bg-blue-500/15 text-blue-300 border-blue-400/40";

  const localTime = formatLocalCloseTime(eventTime, loc);
  const peakLocal = formatLocalHour(peakMs, loc);
  const peakPassed = peakLeft != null && peakLeft.totalMs <= 0;

  return (
    <div className="inline-flex flex-col items-end gap-1">
      {nowLocal && (
        <div className="inline-flex items-center gap-1 px-2 py-0.5 rounded border bg-muted/40 text-muted-foreground border-border text-[10px] font-mono-num">
          <span className="opacity-70 uppercase tracking-wider text-[9px]">now</span>
          <span className="font-semibold">{nowLocal}</span>
        </div>
      )}
      <div className={cn("inline-flex flex-col items-end gap-0.5 px-2 py-1 rounded border", colorClass)}>
        <div className="inline-flex items-center gap-1 text-[11px] font-mono-num font-semibold">
          <Clock className="h-3 w-3" />
          {hours > 0 && <span>{hours}h </span>}
          <span>{minutes.toString().padStart(2, "0")}m</span>
          <span className="text-[10px] opacity-70">{seconds.toString().padStart(2, "0")}s</span>
        </div>
        {localTime && (
          <div className="text-[9px] uppercase tracking-wider opacity-80 leading-none">
            closes {localTime}
          </div>
        )}
      </div>
      {peakLeft && peakLocal && (() => {
        const sincePeakMs = peakPassed && peakMs != null ? Date.now() - peakMs : 0;
        const sinceH = Math.floor(sincePeakMs / 3_600_000);
        const sinceM = Math.floor((sincePeakMs % 3_600_000) / 60_000);
        // After peak: green (high likely already set, safer). Before: red (still pending).
        const peakColor = peakPassed
          ? "bg-emerald-500/20 text-emerald-200 border-emerald-400/50"
          : "bg-red-500/20 text-red-200 border-red-400/50";
        return (
          <div className={cn("inline-flex flex-col items-end gap-0.5 px-2 py-1 rounded border", peakColor)}>
            <div className="inline-flex items-center gap-1 text-[11px] font-mono-num font-semibold">
              <span aria-hidden>☀</span>
              {peakPassed ? (
                <>
                  {sinceH > 0 && <span>{sinceH}h </span>}
                  <span>{sinceM.toString().padStart(2, "0")}m</span>
                  <span className="text-[10px] opacity-70">past peak</span>
                </>
              ) : (
                <>
                  {peakLeft.hours > 0 && <span>{peakLeft.hours}h </span>}
                  <span>{peakLeft.minutes.toString().padStart(2, "0")}m</span>
                  <span className="text-[10px] opacity-70">to peak</span>
                </>
              )}
            </div>
            <div className="text-[9px] uppercase tracking-wider opacity-80 leading-none">
              peak {peakLocal}
            </div>
          </div>
        );
      })()}
    </div>
  );
};

type RowExtras = { stake: number; stakePct: number; score: number; bankroll: number; stakeCapPct: number };

const ACTION_META: Record<ActionDecision["action"], { cls: string; label: string }> = {
  ENTER: { cls: "bg-blue-500/20 text-blue-200 border-blue-400/60", label: "ENTER" },
  ADD:   { cls: "bg-emerald-500/20 text-emerald-200 border-emerald-400/60", label: "ADD" },
  HOLD:  { cls: "bg-amber-500/20 text-amber-200 border-amber-400/60", label: "HOLD" },
  TRIM:  { cls: "bg-red-500/20 text-red-200 border-red-400/60", label: "TRIM" },
};

const ActionBadge = ({ decision, degradedHint }: { decision: ActionDecision; degradedHint?: string }) => {
  const meta = ACTION_META[decision.action];
  return (
    <div
      className={cn(
        "flex items-center gap-2 px-2.5 py-1.5 rounded-md border text-[11px]",
        meta.cls,
      )}
      title={decision.degraded ? (degradedHint ?? "Limited data: volume unavailable") : undefined}
    >
      <span className="font-bold tracking-wide">{meta.label}</span>
      <span className="font-mono-num font-semibold opacity-90">{decision.confidence}%</span>
      <span className="opacity-80 font-normal truncate">{decision.reason}{decision.degraded ? " · limited data" : ""}</span>
    </div>
  );
};

const MODE_META: Record<MomentumMode, { cls: string; label: string; dot: string }> = {
  MOMENTUM:   { cls: "bg-emerald-500/15 text-emerald-200 border-emerald-400/50", label: "MOMENTUM",   dot: "🟢" },
  TRANSITION: { cls: "bg-amber-500/15 text-amber-200 border-amber-400/50",       label: "TRANSITION", dot: "🟡" },
  CERTAINTY:  { cls: "bg-blue-500/15 text-blue-200 border-blue-400/50",          label: "CERTAINTY",  dot: "🔵" },
};

const MODE_HINT: Record<MomentumMode, { tip: string; cls: string }> = {
  MOMENTUM:   { tip: "Hunt & build — enter on widening, add on STRONG weather.", cls: "text-emerald-300" },
  TRANSITION: { tip: "Defend — hold winners, trim on weakness, no new ADDs.",    cls: "text-amber-300" },
  CERTAINTY:  { tip: "Exit or wait — no new entries; close <90¢, hold ≥95¢.",    cls: "text-blue-300" },
};

const ModeBadge = ({ mode }: { mode: MomentumMode }) => {
  const meta = MODE_META[mode];
  return (
    <span className={cn("inline-flex items-center gap-1 px-2 py-0.5 rounded border text-[10px] font-bold uppercase tracking-wide", meta.cls)}>
      <span aria-hidden>{meta.dot}</span>MODE · {meta.label}
    </span>
  );
};

const VERDICT_META: Record<MarketVerdict, { cls: string; label: string; dot: string }> = {
  AGREE:           { cls: "bg-emerald-500/15 text-emerald-200 border-emerald-400/50", label: "AGREE",           dot: "🟢" },
  NEUTRAL:         { cls: "bg-amber-500/15 text-amber-200 border-amber-400/50",       label: "NEUTRAL",         dot: "🟡" },
  WEAK_DISAGREE:   { cls: "bg-orange-500/15 text-orange-200 border-orange-400/50",    label: "WEAK DISAGREE",   dot: "🟠" },
  STRONG_DISAGREE: { cls: "bg-red-500/15 text-red-200 border-red-400/50",             label: "STRONG DISAGREE", dot: "🔴" },
  UNKNOWN:         { cls: "bg-muted text-muted-foreground border-border",             label: "N/A",             dot: "⚪" },
};

const VerdictBadge = ({ verdict, title }: { verdict: MarketVerdict; title?: string }) => {
  const meta = VERDICT_META[verdict];
  return (
    <span className={cn("inline-flex items-center gap-1 px-2 py-0.5 rounded border text-[10px] font-bold uppercase tracking-wide", meta.cls)} title={title}>
      <span aria-hidden>{meta.dot}</span>WX · {meta.label}
    </span>
  );
};

type TradeContext = Omit<LogEdgeTradeInput, "source" | "entry_price" | "suggested_price" | "edge_pp" | "p_model" | "projected_temp_c" | "projected_temp_unit" | "stake_usdc" | "outcome_label" | "bucket_min_c" | "bucket_max_c">;

const ProjectionPanel = ({
  projection, snapshot, bankroll, stakeCapPct, confidence, unit,
  tradeContext, buckets, mode, leaderLabel, pastPeak,
}: {
  projection: ProjectionResult;
  snapshot: OpenMeteoSnapshot | null;
  bankroll: number;
  stakeCapPct: number;
  confidence: number;
  unit: "C" | "F";
  tradeContext: TradeContext;
  buckets: BucketLike[];
  mode: MomentumMode;
  leaderLabel: string | null;
  pastPeak?: boolean;
}) => {
  const isCounterTrend = projection.bestValueLabel != null
    && leaderLabel != null
    && projection.bestValueLabel !== leaderLabel;
  // Block auto-log when counter-trend and not in MOMENTUM (early-reversal) mode.
  const blockAutoLog = isCounterTrend && mode !== "MOMENTUM";
  // Hide CTA entirely in CERTAINTY mode counter-trend (post-peak, no fighting trend).
  const hideCta = isCounterTrend && mode === "CERTAINTY";
  const [open, setOpen] = useState(false);
  const [logging, setLogging] = useState(false);
  const [logged, setLogged] = useState(false);
  const autoLoggedKeyRef = useRef<string | null>(null);
  const meanDisp = unit === "F" ? cToF(projection.meanC) : projection.meanC;
  const toUnit = (c: number) => unit === "F" ? c * 9 / 5 : c;
  const bandUpDisp = toUnit(projection.bandUpC);
  const bandDownDisp = toUnit(projection.bandDownC);
  const asymmetric = Math.abs(projection.bandUpC - projection.bandDownC) > 0.05;
  const bandDisp = Math.max(bandUpDisp, bandDownDisp);
  const sym = unit === "F" ? "°F" : "°C";
  const h = Math.floor(projection.hoursToPeak);
  const m = Math.round((projection.hoursToPeak - h) * 60);
  const ttpStr = projection.hoursToPeak > 0
    ? (h > 0 ? `in ${h}h ${m.toString().padStart(2, "0")}m` : `in ${m}m`)
    : "now";
  const fmt = (v: number | null | undefined, suffix = "") => v == null || !Number.isFinite(v) ? "—" : `${v.toFixed(1)}${suffix}`;
  const tempSpeed = snapshot?.temperature_1h_ago != null ? snapshot.temperature_now - snapshot.temperature_1h_ago : null;
  const forecastSpeed = snapshot?.temp_forecast_1h != null ? snapshot.temp_forecast_1h - snapshot.temperature_now : null;
  const headerTitle = snapshot
    ? `temp Δ1h ${tempSpeed != null ? (tempSpeed >= 0 ? "+" : "") + tempSpeed.toFixed(1) : "—"}°C · forecast Δ1h ${forecastSpeed != null ? (forecastSpeed >= 0 ? "+" : "") + forecastSpeed.toFixed(1) : "—"}°C\ncloud ${fmt(snapshot.cloud_cover, "%")} · precip ${fmt(snapshot.precipitation, "mm")} · humidity ${fmt(snapshot.humidity, "%")} · wind ${fmt(snapshot.wind_speed, "km/h")}`
    : undefined;

  const smartBid = suggestSmartBid(projection.bestValueEdge, confidence, bankroll, stakeCapPct);
  const smartBidPct = bankroll > 0 ? (smartBid / bankroll) * 100 : 0;

  // Fair price + bucket info derived from the projection.
  const fair = fairPriceFromProjection(projection);
  const bestBucket = fair ? buckets.find((b) => b.label === fair.bucketLabel) : null;

  const buildPayload = (source: "manual" | "auto_edge", stake: number): LogEdgeTradeInput | null => {
    if (!fair || !projection.bestValueLabel) return null;
    return {
      ...tradeContext,
      source,
      outcome_label: projection.bestValueLabel,
      clob_token_id: bestBucket?.clob_token_id ?? tradeContext.clob_token_id ?? null,
      bucket_min_c: bestBucket?.bucket_min_c ?? null,
      bucket_max_c: bestBucket?.bucket_max_c ?? null,
      side: "YES",
      entry_price: fair.marketPrice,
      suggested_price: fair.fairPrice,
      edge_pp: fair.edgePp,
      p_model: fair.fairPrice,
      projected_temp_c: projection.meanC,
      projected_temp_unit: unit,
      stake_usdc: stake,
    };
  };

  // Auto-log every qualifying outcome once per render-instance (DB has unique
  // index per user/token/day, so duplicates are silently dropped).
  useEffect(() => {
    if (!fair || projection.bestValueEdge == null) return;
    if (projection.bestValueEdge < 15) return;
    if (blockAutoLog) return;
    const key = `${tradeContext.market_slug ?? tradeContext.market_question}::${projection.bestValueLabel}`;
    if (autoLoggedKeyRef.current === key) return;
    autoLoggedKeyRef.current = key;
    const payload = buildPayload("auto_edge", smartBid);
    if (!payload) return;
    void logEdgeTrade(payload);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projection.bestValueEdge, projection.bestValueLabel, tradeContext.market_slug, blockAutoLog]);

  const onMarkTraded = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const payload = buildPayload("manual", smartBid > 0 ? smartBid : 0);
    if (!payload) { toast.error("No best-value bucket to log"); return; }
    setLogging(true);
    const r = await logEdgeTrade(payload);
    setLogging(false);
    if (r.ok) {
      setLogged(true);
      toast.success(r.duplicate ? "Already logged today" : "Trade logged");
    } else {
      toast.error(r.error ?? "Failed to log trade");
    }
  };

  return (
    <div className="rounded-md border border-border bg-background/40">
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        className="w-full flex items-center justify-between gap-2 px-3 py-2 text-left hover:bg-surface-2/40"
        title={headerTitle}
      >
        <div className="flex flex-col">
          <span className="text-[9px] uppercase tracking-wider text-muted-foreground">Projected temp at peak ({ttpStr})</span>
          <span className="font-mono-num text-sm font-bold text-foreground">
            {meanDisp.toFixed(1)}{sym}{" "}
            <span className="text-muted-foreground font-normal">
              {asymmetric
                ? `(+${bandUpDisp.toFixed(1)} / −${bandDownDisp.toFixed(1)}${sym})`
                : `±${bandDisp.toFixed(1)}${sym}`}
            </span>
          </span>
        </div>
        <ChevronDown className={cn("h-4 w-4 text-muted-foreground transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div className="px-3 pb-3">
          {projection.bestValueLabel && projection.bestValueEdge != null && projection.bestValueEdge >= 7 && (() => {
            const bestRow = projection.rows.find((r) => r.label === projection.bestValueLabel);
            const bestPrice = bestRow?.marketPct ?? null;
            const fairPct = bestRow?.modelPct ?? null;
            const edge = projection.bestValueEdge;
            const strong = edge >= 15 && bestPrice != null && bestPrice <= 70;
            const weak = edge < 10;
            const tier = strong ? "STRONG" : weak ? "WEAK" : "MODERATE";
            const tierCls = strong ? "text-emerald-300" : weak ? "text-muted-foreground" : "text-amber-300";
            return (
              <div className="mb-2 space-y-1">
                <div className={cn("text-[11px] font-bold uppercase tracking-wider flex items-center gap-1.5 flex-wrap", tierCls)}>
                  <span>
                    Best value: <span className="font-mono-num">{projection.bestValueLabel}</span>
                    <span className="ml-1 font-mono-num">({tier} +{edge})</span>
                    {bestPrice != null && <span className="ml-1 font-mono-num text-muted-foreground">@ {bestPrice.toFixed(0)}%</span>}
                  </span>
                  {isCounterTrend && (
                    <span
                      className="inline-flex items-center px-1.5 py-0.5 rounded border border-amber-400/50 bg-amber-500/15 text-amber-200 text-[9px] font-bold normal-case tracking-normal"
                      title={`Best value disagrees with market leader (${leaderLabel}). ${mode === "MOMENTUM" ? "Early reversal — actionable." : mode === "TRANSITION" ? "Auto-log blocked; manual CTA still available." : "CERTAINTY: CTA hidden, no fighting trend."}`}
                    >
                      ⚠ counter-trend vs leader
                    </span>
                  )}
                </div>
                {fairPct != null && bestPrice != null && (
                  <div className="text-[10px] text-muted-foreground">
                    Suggested entry (WX fair price): <span className="font-mono-num font-semibold text-foreground">{fairPct.toFixed(0)}%</span>
                    <span className="mx-1">·</span>
                    market <span className="font-mono-num">{bestPrice.toFixed(0)}%</span>
                  </div>
                )}
                {!strong && (
                  <div className="text-[10px] text-muted-foreground">
                    {weak ? "Edge <10 — not actionable." : `Need edge ≥15 and price ≤70% for a real opportunity${bestPrice != null && bestPrice > 70 ? ` (price ${bestPrice.toFixed(0)}% too high)` : ""}.`}
                  </div>
                )}
                {strong && smartBid > 0 && (
                  <div
                    className="text-[10px] text-muted-foreground"
                    title={`Sized from edge +${edge}pp · confidence ${confidence}% · bankroll $${bankroll.toLocaleString()} · cap ${stakeCapPct}%`}
                  >
                    Smart bid: <span className="font-mono-num font-semibold text-foreground">${smartBid.toLocaleString()}</span>
                    <span className="ml-1 font-mono-num">({smartBidPct.toFixed(1)}% of bankroll)</span>
                  </div>
                )}
                {!hideCta && (
                  <button
                    onClick={onMarkTraded}
                    disabled={logging || logged}
                    className={cn(
                      "mt-1 inline-flex items-center gap-1.5 rounded border px-2 py-1 text-[11px] font-semibold transition-colors",
                      logged
                        ? "border-emerald-400/50 bg-emerald-500/15 text-emerald-200"
                        : "border-primary/40 bg-primary/10 text-primary hover:bg-primary/20",
                    )}
                    title={`Log this opportunity (${projection.bestValueLabel}) as a trade in your /trades log`}
                  >
                    {logging
                      ? <Loader2 className="h-3 w-3 animate-spin" />
                      : logged ? <Check className="h-3 w-3" /> : <BookmarkPlus className="h-3 w-3" />}
                    {logged ? "Logged" : "Mark as traded"}
                  </button>
                )}
                {edge >= 15 && !blockAutoLog && (
                  <div className="text-[9px] text-muted-foreground italic">
                    Auto-logged (edge ≥15pp). Review or update outcome on the /trades page.
                  </div>
                )}
                {edge >= 15 && blockAutoLog && (
                  <div className="text-[9px] text-amber-300/80 italic">
                    Auto-log blocked: counter-trend in {mode} mode. {hideCta ? "CTA hidden — no fighting trend after peak." : "Use manual CTA if you still want to enter."}
                  </div>
                )}
              </div>
            );
          })()}
          {projection.outOfRange && (() => {
            const realizedC = snapshot?.today_high_so_far_c ?? null;
            const realizedDisp = realizedC != null ? toUnit(realizedC) : null;
            // Past-peak case: today's realized high is locked in. The forecast
            // mean is a stale lower-bound; market is pricing what already happened.
            if (pastPeak) {
              return (
                <div className="mb-2 rounded border border-amber-400/40 bg-amber-500/10 px-2 py-1.5 text-[10px] text-amber-200">
                  Past peak — today's high {realizedDisp != null ? `(${realizedDisp.toFixed(1)}${sym}) ` : ""}is already locked in.
                  Forecast mean ({meanDisp.toFixed(1)}{sym}) is stale and no longer relevant; trust the market's leader bucket.
                </div>
              );
            }
            return (
              <div className="mb-2 rounded border border-red-400/40 bg-red-500/10 px-2 py-1.5 text-[10px] text-red-200">
                Model projects ~{meanDisp.toFixed(1)}{sym} — well outside all listed buckets. Market is pricing a peak the forecast doesn't support.
              </div>
            );
          })()}
          <table className="w-full text-[11px] font-mono-num">
            <thead>
              <tr className="text-muted-foreground text-[9px] uppercase tracking-wider">
                <th className="text-left font-medium py-1">Bucket</th>
                <th className="text-right font-medium py-1">Market</th>
                <th className="text-right font-medium py-1">Model</th>
                <th className="text-right font-medium py-1">Edge</th>
              </tr>
            </thead>
            <tbody>
              {projection.rows.map((r) => {
                const edgeColor = r.edge >= 10 ? "text-emerald-400"
                  : r.edge <= -10 ? "text-red-400"
                  : "text-muted-foreground";
                const isBest = r.label === projection.bestValueLabel && r.edge > 0;
                const fmtPct = (p: number) => {
                  if (p >= 1) return `${p.toFixed(0)}%`;
                  if (p >= 0.1) return `<1%`;
                  return `≈0%`;
                };
                return (
                  <tr key={r.label} className="border-t border-border/40">
                    <td className="py-1 text-foreground">
                      {r.label}
                      {r.isProjected && <span className="ml-1 text-[9px] text-blue-300">← projection</span>}
                      {isBest && <span className="ml-1 text-[9px] text-emerald-300">★ best value</span>}
                    </td>
                    <td className="py-1 text-right text-foreground">{fmtPct(r.marketPct)}</td>
                    <td className="py-1 text-right text-foreground">{fmtPct(r.modelPct)}</td>
                    <td className={cn("py-1 text-right font-semibold", edgeColor)}>
                      {r.edge >= 0 ? "+" : ""}{r.edge}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {(projection.verdict === "STRONG_DISAGREE" || projection.verdict === "WEAK_DISAGREE") && projection.marketTopLabel && (() => {
            const bestRow = projection.rows.find((r) => r.label === projection.bestValueLabel && r.edge > 0);
            const fmtPct = (p: number) => p >= 1 ? `${p.toFixed(0)}%` : p >= 0.1 ? `<1%` : `≈0%`;
            return (
              <div className={cn(
                "mt-2 text-[10px] space-y-1",
                projection.verdict === "STRONG_DISAGREE" ? "text-red-300" : "text-orange-300",
              )}>
                <div>
                  Model favors <span className="font-bold">{projection.modelTopLabel ?? "out of range"}</span>; market favors <span className="font-bold">{projection.marketTopLabel}</span>.
                </div>
                {bestRow && (
                  <div className="text-emerald-300">
                    ★ Best trade: <span className="font-bold">{bestRow.label}</span> — market {fmtPct(bestRow.marketPct)}, model {fmtPct(bestRow.modelPct)}, edge <span className="font-bold">+{bestRow.edge}</span>
                  </div>
                )}
              </div>
            );
          })()}
        </div>
      )}
    </div>
  );
};

const CardShell = ({
  onClick, children, clickable,
}: { onClick?: () => void; children: React.ReactNode; clickable: boolean }) => (
  <div
    onClick={onClick}
    className={cn(
      "rounded-xl border-2 border-border bg-surface-1 hover:border-primary/40 hover:bg-surface-2/40 transition-colors overflow-hidden",
      clickable && "cursor-pointer",
    )}
  >
    {children}
  </div>
);

const UnknownReasonLabel = ({ reason }: { reason: string }) => (
  <span className="text-[9px] text-muted-foreground italic">{reason}</span>
);

/** Side-by-side info boxes: Momentum mode + WX verdict, each with its own explanation. */
const SignalBoxes = ({
  mode, modeTip, modeCls,
  verdict, verdictTitle, verdictReason,
  wxSourceLine,
  resolutionMethod, onDetectResolution, detectingResolution,
}: {
  mode: MomentumMode;
  modeTip: string;
  modeCls: string;
  verdict: MarketVerdict;
  verdictTitle?: string;
  verdictReason?: string;
  wxSourceLine: string;
  resolutionMethod?: "rounded" | "floor" | "ceiling" | "unknown" | null;
  onDetectResolution?: () => void;
  detectingResolution?: boolean;
}) => (
  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
    <div className="rounded-md border border-border bg-background/40 p-2.5 space-y-1.5">
      <div className="flex items-center gap-1.5">
        <span className="text-[9px] uppercase tracking-wider text-muted-foreground">Momentum</span>
        <ModeBadge mode={mode} />
      </div>
      <div className={cn("text-[11px] leading-snug font-medium", modeCls)}>{modeTip}</div>
    </div>
    <div className="rounded-md border border-border bg-background/40 p-2.5 space-y-1.5">
      <div className="flex items-center gap-1.5 flex-wrap">
        <span className="text-[9px] uppercase tracking-wider text-muted-foreground">WX verdict</span>
        <VerdictBadge verdict={verdict} title={verdictTitle} />
      </div>
      {verdictReason && (
        <div className="text-[11px] leading-snug text-muted-foreground italic">{verdictReason}</div>
      )}
      <div className="text-[10px] leading-snug text-muted-foreground">
        <span className="uppercase tracking-wider text-[9px]">Temp source: </span>
        {wxSourceLine}
      </div>
      {onDetectResolution && (
        <div className="text-[10px] leading-snug text-muted-foreground flex items-center gap-1.5 flex-wrap pt-1 border-t border-border/40">
          <span className="uppercase tracking-wider text-[9px]">Resolution:</span>
          <span className="font-mono-num">
            {resolutionMethod && resolutionMethod !== "unknown"
              ? resolutionMethod
              : (resolutionMethod === "unknown" ? "unknown" : "not detected")}
          </span>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onDetectResolution(); }}
            disabled={detectingResolution}
            className="text-[10px] underline underline-offset-2 hover:text-foreground disabled:opacity-50"
          >
            {detectingResolution ? "detecting…" : "re-detect"}
          </button>
        </div>
      )}
    </div>
  </div>
);

const CardHeader = ({
  title, city, lat, lon, leader, runner, sourceLabel, eventTime,
}: { title?: string | null; city: string | null; lat?: number | null; lon?: number | null; leader: string; runner: string; sourceLabel: string; eventTime?: string | null }) => (
  <div className="px-4 pt-3 pb-2 border-b border-border/60 bg-surface-2/30">
    <div className="flex items-start justify-between gap-2">
      <div className="flex-1 min-w-0">
        <div className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground mb-0.5">
          {sourceLabel}{city ? ` · ${city}` : ""}
        </div>
        {title && (
          <div className="text-base sm:text-lg font-extrabold text-foreground leading-snug">{title}</div>
        )}
        <div className="mt-1 flex items-baseline gap-2 flex-wrap">
          <span className="text-base font-bold text-emerald-400">{leader}</span>
          <span className="text-xs text-muted-foreground">vs</span>
          <span className="text-sm font-semibold text-foreground/80">{runner}</span>
        </div>
      </div>
      {eventTime && (
        <div className="shrink-0">
          <CountdownBadge eventTime={eventTime} city={city} lat={lat} lon={lon} />
        </div>
      )}
    </div>
  </div>
);

const StakeBar = ({ stake, stakePct }: { stake: number; stakePct: number }) => (
  <div className="px-4 py-2 bg-primary/10 border-t border-primary/20 flex items-center justify-between">
    <div>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Suggested stake</div>
      <div className="font-mono-num font-bold text-lg text-primary">${stake.toLocaleString()}</div>
    </div>
    <div className="text-right">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">% of bankroll</div>
      <div className="font-mono-num font-semibold text-foreground">{stakePct.toFixed(2)}%</div>
    </div>
  </div>
);

const Row = ({ m, outs, onSelect, stake, stakePct, score, bankroll, stakeCapPct, onDetectResolution, detectingResolution }: { m: Movement; outs: WeatherOutcome[]; onSelect?: (mk: WeatherMarket) => void; onDetectResolution?: (marketId: string) => void; detectingResolution?: boolean } & RowExtras) => {
  const [copied, setCopied] = useState(false);
  const entryPct = (m.leaderNow * 100).toFixed(1);
  const upsidePct = ((1 - m.leaderNow) * 100).toFixed(1);
  const gap2hPct = (m.gap2h * 100).toFixed(1);
  const gap1hPct = (m.gap1h * 100).toFixed(1);
  const gapNowPct = (m.gapNow * 100).toFixed(1);
  const netSign = m.netDelta >= 0 ? "+" : "";
  const netPct = (m.netDelta * 100).toFixed(1);
  const meta = TRAJ_META[m.trajectory] ?? TRAJ_META.flat;
  const nowColor = m.trajectory === "narrowing" ? "text-red-400" : m.trajectory === "flat" ? "text-foreground" : "text-emerald-400";
  const modelPct = m.leader.p_model != null ? Number(m.leader.p_model) * 100 : null;
  const modelEdge = modelPct != null ? modelPct - m.leaderNow * 100 : null;

  const openCard = () => {
    if (m.market.polymarket_url) window.open(m.market.polymarket_url, "_blank", "noopener,noreferrer");
    else onSelect?.(m.market);
  };

  // Detect whether the market asks for daily LOW (min) or HIGH (max).
  const extreme = detectTempExtreme(m.market.market_question, m.market.polymarket_event_slug);
  // Argmin/argmax of forecast path between now and event_time. Falls back to
  // the "4 PM local" heuristic when no forecast path is available.
  const scan = peakFromForecast(m.weather, m.market.event_time, extreme);
  const peakMs = scan?.peakMs ?? peakWeatherTimeMs(m.market.event_time, { city: m.market.city, lat: m.market.latitude, lon: m.market.longitude });
  const ttpMinutes = peakMs != null
    ? Math.max(0, (peakMs - Date.now()) / 60000)
    : Math.max(0, (new Date(m.market.event_time).getTime() - Date.now()) / 60000);
  const hoursToPeak = ttpMinutes / 60;
  const pastPeak = scan?.pastPeak ?? false;
  const extremeLabel = extreme === "min" ? "low" : "peak";

  // Build market-vs-model projection from outcome buckets.
  // If we know the market's resolution_method (rounded/floor/ceiling), re-parse
  // single-integer labels with the right bounds — DB-stored bounds default to rounded.
  const resMethod = m.market.resolution_method ?? null;
  const buckets: BucketLike[] = outs.map((o) => {
    let min_c = o.bucket_min_c;
    let max_c = o.bucket_max_c;
    if (resMethod && resMethod !== "rounded" && resMethod !== "unknown") {
      const reparsed = parseBucketLabel(o.label, resMethod);
      if (reparsed.min_c != null || reparsed.max_c != null) {
        min_c = reparsed.min_c;
        max_c = reparsed.max_c;
      }
    }
    return {
      label: o.label,
      bucket_min_c: min_c,
      bucket_max_c: max_c,
      marketPrice: m.liveMids?.[o.id] ?? o.polymarket_price,
      clob_token_id: o.clob_token_id ?? null,
    };
  });
  // Detect market unit from bucket labels (e.g. "26-27°C" → C, "78-79°F" → F).
  const labelBlob = outs.map((o) => o.label).join(" ");
  const unit: "C" | "F" = /°\s*C|\bC\b/i.test(labelBlob) && !/°\s*F/i.test(labelBlob) ? "C" : "F";
  const tConv = (c: number) => unit === "F" ? cToF(c) : c;
  const tSym = unit === "F" ? "°F" : "°C";
  const projection = compareToMarket(m.weather, hoursToPeak, buckets, extreme, pastPeak);
  const verdict: MarketVerdict = projection?.verdict ?? "UNKNOWN";

  // Determine specific reason for UNKNOWN verdict
  let unknownReason = "";
  if (verdict === "UNKNOWN") {
    if (!m.weather) {
      unknownReason = "Missing weather snapshot";
    } else if (buckets.filter(b => b.marketPrice != null && (b.bucket_min_c != null || b.bucket_max_c != null)).length === 0) {
      unknownReason = "Missing bucket prices or bounds";
    } else {
      unknownReason = "Unable to compute projection";
    }
  }

  const decision = decideAction({
    gap2h: m.gap2h, gap1h: m.gap1h, gapNow: m.gapNow,
    volLast: m.volLast, volPrev: m.volPrev, ttpMinutes,
    marketVerdict: verdict,
  });

  const projTempStr = projection ? `${tConv(projection.meanC).toFixed(1)}${tSym}` : null;
  const verdictTitle = projection
    ? `Model #1: ${projection.modelTopLabel ?? "—"} bucket (proj ${projTempStr}) · Market #1: ${projection.marketTopLabel ?? "—"}`
    : "No projection (missing weather or bucket data)";

  const copy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(`${entryPct}%`);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { toast.error("Copy failed"); }
  };

  return (
    <CardShell onClick={openCard} clickable>
      <CardHeader title={m.market.market_question} city={m.market.city} lat={m.market.latitude} lon={m.market.longitude} leader={m.leader.label} runner={m.runnerUp.label} sourceLabel="In your scanner" eventTime={m.market.event_time} />
      <div className="px-4 py-3 space-y-3">
        <div className="flex items-center gap-2 flex-wrap">
          <span className={cn("inline-flex items-center px-2.5 py-1 rounded-md border text-[12px] font-bold uppercase tracking-wide", meta.badge)}>
            {meta.label} {netSign}{netPct}%
          </span>
          <span className="text-[10px] text-muted-foreground font-mono-num">score {score.toFixed(3)}</span>
        </div>
        <SignalBoxes
          mode={decision.mode}
          modeTip={MODE_HINT[decision.mode].tip}
          modeCls={MODE_HINT[decision.mode].cls}
          verdict={verdict}
          verdictTitle={verdictTitle}
          verdictReason={unknownReason || (projection
            ? `Model ${projection.modelTopLabel ?? "—"} bucket (proj ${projTempStr}) vs market ${projection.marketTopLabel ?? "—"}`
            : undefined)}
          wxSourceLine={(() => {
            if (!m.weather) return "No live snapshot available";
            const nowDisp = tConv(m.weather.temperature_now).toFixed(1);
            const ph = Math.floor(hoursToPeak);
            const pm = Math.round((hoursToPeak - ph) * 60);
            const ttp = hoursToPeak > 0 ? (ph > 0 ? `in ${ph}h ${pm.toString().padStart(2, "0")}m` : `in ${pm}m`) : "now";
            if (!projection) {
              const f1 = m.weather.temp_forecast_1h != null ? `${tConv(m.weather.temp_forecast_1h).toFixed(1)}${tSym}` : "—";
              return `Open-Meteo ${m.market.city ?? "site"} · now ${nowDisp}${tSym} · +1h ${f1}`;
            }
            const peakDisp = tConv(projection.meanC).toFixed(1);
            const peak = projection.peak;
            const cloud = peak?.cloud != null ? `${Math.round(peak.cloud)}%` : "—";
            const precip = peak?.precipitation != null ? `${peak.precipitation.toFixed(1)}mm` : "—";
            const wind = peak?.wind != null ? `${Math.round(peak.wind)}km/h` : "—";
            const flags: string[] = [];
            if (pastPeak) flags.push(`⏷ past ${extremeLabel}`);
            if (projection.forecastDrift) flags.push("⚠ forecast drift");
            if (projection.plateauDetected) flags.push("≈ plateau");
            if (projection.peakBias === "LOWER") flags.push("↓ bias lower");
            else if (projection.peakBias === "HIGHER") flags.push("↑ bias higher");
            const flagStr = flags.length ? ` · ${flags.join(" · ")}` : "";
            const peakLbl = pastPeak ? `${extremeLabel} (passed)` : `${extremeLabel} (${ttp})`;
            // Realized extreme so far today — surface when it's anchoring the projection.
            const realized = extreme === "min" ? m.weather.today_low_so_far_c : m.weather.today_high_so_far_c;
            const realizedRelevant = realized != null && Number.isFinite(realized) && (
              extreme === "max" ? realized >= projection.meanC - 0.05 : realized <= projection.meanC + 0.05
            );
            const srcLabel = m.weather.today_extreme_source && m.weather.today_extreme_source !== "open-meteo"
              ? ` (official ${m.weather.today_extreme_source})`
              : "";
            const realizedStr = realizedRelevant
              ? ` · today ${extreme === "min" ? "low" : "high"} so far ${tConv(realized as number).toFixed(1)}${tSym}${srcLabel}`
              : "";
            return `Open-Meteo ${m.market.city ?? "site"} · now ${nowDisp}${tSym} · ${peakLbl} ${peakDisp}${tSym}${realizedStr} · cloud ${cloud} · precip ${precip} · wind ${wind} · conf ${projection.confidence}%${flagStr}`;
          })()}
          resolutionMethod={m.market.resolution_method}
          onDetectResolution={onDetectResolution ? () => onDetectResolution(m.market.id) : undefined}
          detectingResolution={detectingResolution}
        />
        <ActionBadge decision={decision} />
        {projection && <ProjectionPanel projection={projection} snapshot={m.weather} bankroll={bankroll} stakeCapPct={stakeCapPct} confidence={decision.confidence} unit={unit} buckets={buckets} mode={decision.mode} leaderLabel={m.leader.label} pastPeak={pastPeak} tradeContext={{ market_slug: m.market.polymarket_event_slug ?? null, market_question: m.market.market_question, city: m.market.city, event_time: m.market.event_time, clob_token_id: null }} />}
        <div className="inline-flex items-center gap-2 rounded border border-border bg-background/60 px-3 py-2">
          <Snap label="2h ago" value={gap2hPct} />
          <span className={cn("text-base", meta.arrow)}>→</span>
          <Snap label="1h ago" value={gap1hPct} />
          <span className={cn("text-base", meta.arrow)}>→</span>
          <Snap label="Now" value={gapNowPct} bold valueClass={nowColor} />
          <span className="text-[9px] uppercase tracking-wider text-muted-foreground ml-1">Gap #1 vs #2</span>
        </div>
        <div className="flex items-center gap-4 flex-wrap">
          <div>
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Entry</div>
            <div className="font-mono-num font-bold text-base text-foreground">{entryPct}%</div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Model</div>
            <div className={cn(
              "font-mono-num font-bold text-base",
              modelPct == null ? "text-muted-foreground"
                : modelEdge != null && modelEdge > 0 ? "text-emerald-400"
                : modelEdge != null && modelEdge < 0 ? "text-red-400"
                : "text-foreground",
            )}>
              {modelPct != null ? `${modelPct.toFixed(1)}%` : "—"}
              {modelEdge != null && (
                <span className="ml-1 text-[10px] font-semibold opacity-80">
                  ({modelEdge >= 0 ? "+" : ""}{modelEdge.toFixed(1)})
                </span>
              )}
            </div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Upside</div>
            <div className="font-mono-num font-bold text-base text-emerald-400">+{upsidePct}%</div>
          </div>
          <button onClick={copy} className="ml-auto inline-flex items-center gap-1 rounded border border-border bg-background hover:bg-surface-2 px-2 py-1 text-[11px]">
            {copied ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
            {copied ? "Copied" : "Copy %"}
          </button>
        </div>
      </div>
      <StakeBar stake={stake} stakePct={stakePct} />
    </CardShell>
  );
};

const ExternalRow = ({ m, stake, stakePct, score, bankroll, stakeCapPct }: { m: ExternalMovement } & RowExtras) => {
  const entryPct = (m.leaderNow * 100).toFixed(1);
  const upsidePct = ((1 - m.leaderNow) * 100).toFixed(1);
  const gap2hPct = (m.gap2h * 100).toFixed(1);
  const gap1hPct = (m.gap1h * 100).toFixed(1);
  const gapNowPct = (m.gapNow * 100).toFixed(1);
  const netSign = m.netDelta >= 0 ? "+" : "";
  const netPct = (m.netDelta * 100).toFixed(1);
  const meta = TRAJ_META[m.trajectory] ?? TRAJ_META.flat;
  const nowColor = m.trajectory === "narrowing" ? "text-red-400" : m.trajectory === "flat" ? "text-foreground" : "text-emerald-400";

  const openCard = () => {
    if (m.polymarket_url) window.open(m.polymarket_url, "_blank", "noopener,noreferrer");
  };

  // Detect whether the market asks for daily LOW (min) or HIGH (max).
  const extreme = detectTempExtreme(m.event_title, m.event_slug);
  // Argmin/argmax of forecast path between now and event_time (handles "past peak" cases).
  const scan = peakFromForecast(m.weather, m.event_time, extreme);
  const peakMs = scan?.peakMs ?? peakWeatherTimeMs(m.event_time, { city: m.city, lat: m.lat, lon: m.lon });
  const ttpMinutes = peakMs != null
    ? Math.max(0, (peakMs - Date.now()) / 60000)
    : (m.event_time ? Math.max(0, (new Date(m.event_time).getTime() - Date.now()) / 60000) : null);
  const hoursToPeak = ttpMinutes != null ? ttpMinutes / 60 : 0;
  const pastPeak = scan?.pastPeak ?? false;
  const extremeLabel = extreme === "min" ? "low" : "peak";

  // Build full bucket set from discover payload (all sub-markets with live mids).
  // Falls back to leader+runner if `allBuckets` is missing (older payloads).
  const buckets: BucketLike[] = (m.allBuckets && m.allBuckets.length > 0)
    ? m.allBuckets.map((b) => {
        const parsed = parseBucketLabel(b.label);
        return {
          label: b.label,
          bucket_min_c: parsed.min_c,
          bucket_max_c: parsed.max_c,
          marketPrice: b.mid,
          clob_token_id: b.clob_token_id,
        };
      })
    : (() => {
        const leaderParsed = parseBucketLabel(m.leader_label);
        const runnerParsed = parseBucketLabel(m.runner_label);
        return [
          { label: m.leader_label, bucket_min_c: leaderParsed.min_c, bucket_max_c: leaderParsed.max_c, marketPrice: m.leaderNow },
          { label: m.runner_label, bucket_min_c: runnerParsed.min_c, bucket_max_c: runnerParsed.max_c, marketPrice: Math.max(0, m.leaderNow - m.gapNow) },
        ];
      })();
  // Detect unit from labels (any °F → unify on F, else C).
  const labelBlob = buckets.map((b) => b.label).join(" ");
  const unit: "C" | "F" = /°\s*F|\bF\b/i.test(labelBlob) ? "F" : (/°\s*C|\bC\b/i.test(labelBlob) ? "C" : "F");
  const tConv = (c: number) => unit === "F" ? cToF(c) : c;
  const tSym = unit === "F" ? "°F" : "°C";

  const projection = compareToMarket(m.weather, hoursToPeak, buckets, extreme, pastPeak);
  const verdict: MarketVerdict = projection?.verdict ?? "UNKNOWN";

  let unknownReason = "";
  if (verdict === "UNKNOWN") {
    if (!m.lat || !m.lon) unknownReason = `No coordinates for ${m.city ?? "city"}`;
    else if (!m.weather) unknownReason = "Weather snapshot unavailable";
    else if (buckets.every((b) => b.bucket_min_c == null && b.bucket_max_c == null)) unknownReason = "Could not parse bucket bounds from labels";
    else unknownReason = "Unable to compute projection";
  }

  const decision = decideAction({
    gap2h: m.gap2h, gap1h: m.gap1h, gapNow: m.gapNow,
    volLast: null, volPrev: null, ttpMinutes,
    marketVerdict: verdict,
  });

  const projTempStr = projection ? `${tConv(projection.meanC).toFixed(1)}${tSym}` : null;
  const verdictTitle = projection
    ? `Model #1: ${projection.modelTopLabel ?? "—"} bucket (proj ${projTempStr}) · Market #1: ${projection.marketTopLabel ?? "—"}`
    : "No projection (missing weather or bucket data)";

  const wxSourceLine = (() => {
    if (!m.weather) return unknownReason || "No live snapshot available";
    const nowDisp = tConv(m.weather.temperature_now).toFixed(1);
    const ph = Math.floor(hoursToPeak);
    const pm = Math.round((hoursToPeak - ph) * 60);
    const ttp = hoursToPeak > 0 ? (ph > 0 ? `in ${ph}h ${pm.toString().padStart(2, "0")}m` : `in ${pm}m`) : "now";
    if (!projection) {
      const f1 = m.weather.temp_forecast_1h != null ? `${tConv(m.weather.temp_forecast_1h).toFixed(1)}${tSym}` : "—";
      return `Open-Meteo ${m.city ?? "site"} · now ${nowDisp}${tSym} · +1h ${f1}`;
    }
    const peakDisp = tConv(projection.meanC).toFixed(1);
    const peak = projection.peak;
    const cloud = peak?.cloud != null ? `${Math.round(peak.cloud)}%` : "—";
    const precip = peak?.precipitation != null ? `${peak.precipitation.toFixed(1)}mm` : "—";
    const wind = peak?.wind != null ? `${Math.round(peak.wind)}km/h` : "—";
    const flags: string[] = [];
    if (pastPeak) flags.push(`⏷ past ${extremeLabel}`);
    if (projection.forecastDrift) flags.push("⚠ forecast drift");
    if (projection.plateauDetected) flags.push("≈ plateau");
    if (projection.peakBias === "LOWER") flags.push("↓ bias lower");
    else if (projection.peakBias === "HIGHER") flags.push("↑ bias higher");
    const flagStr = flags.length ? ` · ${flags.join(" · ")}` : "";
    const peakLbl = pastPeak ? `${extremeLabel} (passed)` : `${extremeLabel} (${ttp})`;
    return `Open-Meteo ${m.city ?? "site"} · now ${nowDisp}${tSym} · ${peakLbl} ${peakDisp}${tSym} · cloud ${cloud} · precip ${precip} · wind ${wind} · conf ${projection.confidence}%${flagStr}`;
  })();

  return (
    <CardShell onClick={openCard} clickable={!!m.polymarket_url}>
      <CardHeader title={m.event_title} city={m.city} lat={m.lat} lon={m.lon} leader={m.leader_label} runner={m.runner_label} sourceLabel="From Polymarket" eventTime={m.event_time} />
      <div className="px-4 py-3 space-y-3">
        <div className="flex items-center gap-2 flex-wrap">
          <span className={cn("inline-flex items-center px-2.5 py-1 rounded-md border text-[12px] font-bold uppercase tracking-wide", meta.badge)}>
            {meta.label} {netSign}{netPct}%
          </span>
          <span className="text-[10px] text-muted-foreground font-mono-num">score {score.toFixed(3)}</span>
        </div>
        <SignalBoxes
          mode={decision.mode}
          modeTip={MODE_HINT[decision.mode].tip}
          modeCls={MODE_HINT[decision.mode].cls}
          verdict={verdict}
          verdictTitle={verdictTitle}
          verdictReason={unknownReason || (projection
            ? `Model ${projection.modelTopLabel ?? "—"} bucket (proj ${projTempStr}) vs market ${projection.marketTopLabel ?? "—"}`
            : undefined)}
          wxSourceLine={wxSourceLine}
        />
        <ActionBadge decision={decision} degradedHint="External market: live volume not fetched" />
        {projection && <ProjectionPanel projection={projection} snapshot={m.weather} bankroll={bankroll} stakeCapPct={stakeCapPct} confidence={decision.confidence} unit={unit} buckets={buckets} mode={decision.mode} leaderLabel={m.leader_label} pastPeak={pastPeak} tradeContext={{ market_slug: m.event_slug, market_question: m.event_title, city: m.city, event_time: m.event_time, clob_token_id: null }} />}
        <div className="inline-flex items-center gap-2 rounded border border-border bg-background/60 px-3 py-2">
          <Snap label="2h ago" value={gap2hPct} />
          <span className={cn("text-base", meta.arrow)}>→</span>
          <Snap label="1h ago" value={gap1hPct} />
          <span className={cn("text-base", meta.arrow)}>→</span>
          <Snap label="Now" value={gapNowPct} bold valueClass={nowColor} />
          <span className="text-[9px] uppercase tracking-wider text-muted-foreground ml-1">Gap #1 vs #2</span>
        </div>
        <div className="flex items-center gap-4">
          <div>
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Entry</div>
            <div className="font-mono-num font-bold text-base text-foreground">{entryPct}%</div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Upside</div>
            <div className="font-mono-num font-bold text-base text-emerald-400">+{upsidePct}%</div>
          </div>
          <span className="ml-auto inline-flex items-center gap-1 rounded border border-border bg-background px-2 py-1 text-[11px] text-muted-foreground">
            <ExternalLink className="h-3 w-3" />
            Open
          </span>
        </div>
        <div className="text-[10px] text-muted-foreground truncate">{m.event_title}</div>
      </div>
      <StakeBar stake={stake} stakePct={stakePct} />
    </CardShell>
  );
};

const Snap = ({ label, value, bold, valueClass }: { label: string; value: string; bold?: boolean; valueClass?: string }) => (
  <div className="flex flex-col items-center">
    <span className="text-[9px] uppercase tracking-wider text-muted-foreground">{label}</span>
    <span className={cn("font-mono-num text-sm leading-tight", bold ? "font-bold" : "font-semibold", valueClass ?? "text-foreground")}>{value}%</span>
  </div>
);
