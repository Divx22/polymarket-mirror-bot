import { useEffect, useState } from "react";
import { TrendingUp, Loader2, Copy, Check, RefreshCw, Globe, ExternalLink } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { type WeatherMarket, type WeatherOutcome } from "@/lib/weather";
import { cn } from "@/lib/utils";

type Props = {
  markets: WeatherMarket[];
  outcomes: Record<string, WeatherOutcome[]>;
  onSelect?: (m: WeatherMarket) => void;
  /** Minimum gap (0–1) between #1 and #2 outcomes required at "now" AND "1h ago". Default 0.10. */
  gapMin?: number;
  /** Allow user to change the threshold via a slider in the panel header. Default true. */
  showThresholdControl?: boolean;
};

const DEFAULT_GAP_MIN = 0.10;
const MAX_ENTRY_PRICE = 0.95;
const MIN_HOURS_TO_EVENT = 0.5;
const FLAT_BAND = 0.01;

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

export const MomentumBreakouts = ({ markets, outcomes, onSelect, gapMin: gapMinProp, showThresholdControl = true }: Props) => {
  const [scanning, setScanning] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [items, setItems] = useState<Movement[]>([]);
  const [externals, setExternals] = useState<ExternalMovement[]>([]);
  const [scannedAt, setScannedAt] = useState<number | null>(null);
  const [progress, setProgress] = useState(0);
  // Threshold (0–1). Editable via slider when showThresholdControl is true.
  const [gapMin, setGapMin] = useState<number>(gapMinProp ?? DEFAULT_GAP_MIN);

  const scan = async () => {
    setScanning(true);
    setItems([]);
    setProgress(0);

    const eligible = markets.filter((m) => {
      const hours = (new Date(m.event_time).getTime() - Date.now()) / 3_600_000;
      return hours > MIN_HOURS_TO_EVENT;
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
        const enriched = outs.map((o, i) => ({ o, mid: liveMids[i] ?? o.polymarket_price ?? 0 }));
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

        found.push({ source: "local", market: m, leader, runnerUp, leaderNow, gap2h, gap1h, gapNow, netDelta, trajectory });
      }));
      done += batch.length;
      setProgress(Math.round((done / eligible.length) * 100));
    }

    // Sort by average of upside% and gap%. Highest combined first.
    const score = (leaderNow: number, gapNow: number) => ((1 - leaderNow) + gapNow) / 2;
    found.sort((a, b) => score(b.leaderNow, b.gapNow) - score(a.leaderNow, a.gapNow));

    setItems(found);
    setScannedAt(Date.now());
    setScanning(false);
  };

  const discover = async () => {
    setDiscovering(true);
    try {
      const { data, error } = await supabase.functions.invoke("weather-discover-momentum", {
        body: { gap_min: gapMin },
      });
      if (error) throw error;
      const results = (data?.results ?? []) as any[];
      const mapped: ExternalMovement[] = results.map((r) => ({
        source: "external",
        event_title: r.event_title,
        event_slug: r.event_slug,
        city: r.city,
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
      }));
      // Same average-score sort as local results.
      const score = (leaderNow: number, gapNow: number) => ((1 - leaderNow) + gapNow) / 2;
      mapped.sort((a, b) => score(b.leaderNow, b.gapNow) - score(a.leaderNow, a.gapNow));
      setExternals(mapped);
    } catch (e: any) {
      console.error("Discover failed", e);
    } finally {
      setDiscovering(false);
    }
  };

  useEffect(() => {
    if (markets.length > 0 && scannedAt == null && !scanning) scan();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [markets.length]);

  return (
    <div className="rounded-lg border border-border bg-card overflow-hidden">
      <div className="flex items-center justify-between gap-2 px-4 py-2.5 border-b border-border bg-surface-2/40">
        <div className="flex items-center gap-2">
          <TrendingUp className="h-4 w-4 text-blue-400" />
          <div>
            <div className="text-xs font-semibold uppercase tracking-wider">Momentum</div>
            <div className="text-[10px] text-muted-foreground">
              Gap #1 vs #2 ≥{Math.round(gapMin * 100)}% now AND 1h ago. Sorted by avg(upside%, gap%).
            </div>
          </div>
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

      {scanning && items.length === 0 && (
        <div className="px-4 py-6 text-center text-xs text-muted-foreground">
          Checking {markets.length} market{markets.length === 1 ? "" : "s"}…
        </div>
      )}

      {(() => {
        const score = (leaderNow: number, gapNow: number) => ((1 - leaderNow) + gapNow) / 2;
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
            sortScore: score(it.leaderNow, it.gapNow), data: it,
          })),
          ...dedupedExternals.map((e, i): Merged => ({
            kind: "ext", key: `e-${e.event_slug ?? i}`,
            sortScore: score(e.leaderNow, e.gapNow), data: e,
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
          <ul className="divide-y divide-border/50">
            {merged.map((row) =>
              row.kind === "local"
                ? <Row key={row.key} m={row.data} onSelect={onSelect} />
                : <ExternalRow key={row.key} m={row.data} />,
            )}
          </ul>
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

const Row = ({ m, onSelect }: { m: Movement; onSelect?: (mk: WeatherMarket) => void }) => {
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

  const copy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(`${entryPct}%`);
      setCopied(true);
      toast.success(`Copied ${entryPct}%`);
      setTimeout(() => setCopied(false), 1500);
    } catch { toast.error("Copy failed"); }
  };

  return (
    <li
      onClick={() => onSelect?.(m.market)}
      className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3 px-3 sm:px-4 py-3 hover:bg-surface-2/50 cursor-pointer"
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-semibold text-foreground">{m.leader.label}</span>
          <span className="text-xs text-muted-foreground">vs {m.runnerUp.label}</span>
          <span className={cn("inline-flex items-center px-2 py-0.5 rounded-md border text-[11px] font-bold uppercase tracking-wide", meta.badge)}>
            {meta.label} {netSign}{netPct}%
          </span>
          <span className="text-xs text-muted-foreground truncate">· {m.market.city}</span>
        </div>
        <div className="mt-1.5 inline-flex items-center gap-2 rounded border border-border bg-background/60 px-2.5 py-1.5">
          <Snap label="2h ago" value={gap2hPct} />
          <span className={cn("text-base", meta.arrow)}>→</span>
          <Snap label="1h ago" value={gap1hPct} />
          <span className={cn("text-base", meta.arrow)}>→</span>
          <Snap label="Now" value={gapNowPct} bold valueClass={nowColor} />
          <span className="text-[9px] uppercase tracking-wider text-muted-foreground ml-1">Gap #1 vs #2</span>
        </div>
      </div>
      <div className="flex items-center gap-3">
        <div className="text-right">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Entry</div>
          <div className="font-mono-num font-semibold text-foreground">{entryPct}%</div>
        </div>
        <div className="text-right">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Upside</div>
          <div className="font-mono-num font-semibold text-emerald-400">+{upsidePct}%</div>
        </div>
        <button onClick={copy} className="inline-flex items-center gap-1 rounded border border-border bg-background hover:bg-surface-2 px-2 py-1 text-[11px]">
          {copied ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </li>
  );
};

const ExternalRow = ({ m }: { m: ExternalMovement }) => {
  const entryPct = (m.leaderNow * 100).toFixed(1);
  const upsidePct = ((1 - m.leaderNow) * 100).toFixed(1);
  const gap2hPct = (m.gap2h * 100).toFixed(1);
  const gap1hPct = (m.gap1h * 100).toFixed(1);
  const gapNowPct = (m.gapNow * 100).toFixed(1);
  const netSign = m.netDelta >= 0 ? "+" : "";
  const netPct = (m.netDelta * 100).toFixed(1);
  const meta = TRAJ_META[m.trajectory] ?? TRAJ_META.flat;
  const nowColor = m.trajectory === "narrowing" ? "text-red-400" : m.trajectory === "flat" ? "text-foreground" : "text-emerald-400";

  const openRow = () => {
    if (m.polymarket_url) window.open(m.polymarket_url, "_blank", "noopener,noreferrer");
  };

  return (
    <li
      onClick={openRow}
      className={cn(
        "flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3 px-3 sm:px-4 py-3 hover:bg-surface-2/50",
        m.polymarket_url && "cursor-pointer",
      )}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-semibold text-foreground">{m.leader_label}</span>
          <span className="text-xs text-muted-foreground">vs {m.runner_label}</span>
          <span className={cn("inline-flex items-center px-2 py-0.5 rounded-md border text-[11px] font-bold uppercase tracking-wide", meta.badge)}>
            {meta.label} {netSign}{netPct}%
          </span>
          {m.city && <span className="text-xs text-muted-foreground truncate">· {m.city}</span>}
        </div>
        <div className="mt-1.5 inline-flex items-center gap-2 rounded border border-border bg-background/60 px-2.5 py-1.5">
          <Snap label="2h ago" value={gap2hPct} />
          <span className={cn("text-base", meta.arrow)}>→</span>
          <Snap label="1h ago" value={gap1hPct} />
          <span className={cn("text-base", meta.arrow)}>→</span>
          <Snap label="Now" value={gapNowPct} bold valueClass={nowColor} />
          <span className="text-[9px] uppercase tracking-wider text-muted-foreground ml-1">Gap #1 vs #2</span>
        </div>
        <div className="mt-1 text-[10px] text-muted-foreground truncate">{m.event_title}</div>
      </div>
      <div className="flex items-center gap-3">
        <div className="text-right">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Entry</div>
          <div className="font-mono-num font-semibold text-foreground">{entryPct}%</div>
        </div>
        <div className="text-right">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Upside</div>
          <div className="font-mono-num font-semibold text-emerald-400">+{upsidePct}%</div>
        </div>
        <span className="inline-flex items-center gap-1 rounded border border-border bg-background px-2 py-1 text-[11px] text-muted-foreground">
          <ExternalLink className="h-3 w-3" />
          Open
        </span>
      </div>
    </li>
  );
};

const Snap = ({ label, value, bold, valueClass }: { label: string; value: string; bold?: boolean; valueClass?: string }) => (
  <div className="flex flex-col items-center">
    <span className="text-[9px] uppercase tracking-wider text-muted-foreground">{label}</span>
    <span className={cn("font-mono-num text-sm leading-tight", bold ? "font-bold" : "font-semibold", valueClass ?? "text-foreground")}>{value}%</span>
  </div>
);
