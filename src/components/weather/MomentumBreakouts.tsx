import { useEffect, useState } from "react";
import { TrendingUp, Loader2, Copy, Check, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { type WeatherMarket, type WeatherOutcome } from "@/lib/weather";
import { cn } from "@/lib/utils";

type Props = {
  markets: WeatherMarket[];
  outcomes: Record<string, WeatherOutcome[]>;
  onSelect?: (m: WeatherMarket) => void;
};

// RULES:
//   Qualify: gap (#1 vs #2, same outcomes) is ≥ GAP_MIN at all 3 snapshots: 2h ago, 1h ago, now.
//   Trajectory based on the two step deltas (d1 = 1h - 2h, d2 = now - 1h):
//     accelerating  — both d1 and d2 are positive AND d2 ≥ d1 (gap grew faster recently)
//     widening      — net (now - 2h) > FLAT_BAND (steady up trend)
//     flat          — |now - 2h| ≤ FLAT_BAND
//     narrowing     — net (now - 2h) < -FLAT_BAND
const GAP_MIN = 0.15;
const MAX_ENTRY_PRICE = 0.95;
const MIN_HOURS_TO_EVENT = 0.5;
const FLAT_BAND = 0.01; // ±1% rounds to "flat"

type Trajectory = "accelerating" | "widening" | "flat" | "narrowing";
type HistPoint = { t: number; p: number };

type Movement = {
  market: WeatherMarket;
  leader: WeatherOutcome;
  runnerUp: WeatherOutcome;
  leaderNow: number;
  gap2h: number;     // gap 2h ago
  gap1h: number;     // gap 1h ago
  gapNow: number;    // gap now
  netDelta: number;  // gapNow - gap2h
  trajectory: Trajectory;
};

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

// Live midpoint from Polymarket — much more accurate than the cached DB price.
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

export const MomentumBreakouts = ({ markets, outcomes, onSelect }: Props) => {
  const [scanning, setScanning] = useState(false);
  const [items, setItems] = useState<Movement[]>([]);
  const [scannedAt, setScannedAt] = useState<number | null>(null);
  const [progress, setProgress] = useState(0);

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

        if (gapNow < GAP_MIN) return;
        if (leaderNow > MAX_ENTRY_PRICE) return;

        const [leaderHist, runnerHist] = await Promise.all([
          fetchHistory(leader.clob_token_id!),
          fetchHistory(runnerUp.clob_token_id!),
        ]);
        const leader1h = priceAt(leaderHist, target1h);
        const runner1h = priceAt(runnerHist, target1h);
        if (leader1h == null || runner1h == null) return;

        const gap1h = leader1h - runner1h;
        if (gap1h < GAP_MIN) return; // qualify on now + 1h ago only

        // 2h shown for context; falls back to gap1h if unavailable
        const leader2h = priceAt(leaderHist, target2h);
        const runner2h = priceAt(runnerHist, target2h);
        const gap2h = (leader2h != null && runner2h != null) ? (leader2h - runner2h) : gap1h;

        const d1 = gap1h - gap2h;       // change 2h→1h
        const d2 = gapNow - gap1h;      // change 1h→now
        const netDelta = gapNow - gap2h;

        let trajectory: Trajectory;
        if (d1 > 0 && d2 > 0 && d2 >= d1) trajectory = "accelerating";
        else if (netDelta > FLAT_BAND) trajectory = "widening";
        else if (netDelta < -FLAT_BAND) trajectory = "narrowing";
        else trajectory = "flat";

        found.push({ market: m, leader, runnerUp, leaderNow, gap2h, gap1h, gapNow, netDelta, trajectory });
      }));
      done += batch.length;
      setProgress(Math.round((done / eligible.length) * 100));
    }

    // Order: accelerating > widening > flat > narrowing; tiebreak by netDelta.
    const rank: Record<Trajectory, number> = { accelerating: 0, widening: 1, flat: 2, narrowing: 3 };
    found.sort((a, b) => rank[a.trajectory] - rank[b.trajectory] || b.netDelta - a.netDelta);

    setItems(found);
    setScannedAt(Date.now());
    setScanning(false);
    const accel = found.filter(f => f.trajectory === "accelerating").length;
    if (found.length > 0) {
      toast.success(`${found.length} qualified · ${accel} accelerating`);
    } else {
      toast.info(`No markets qualified (need gap ≥${Math.round(GAP_MIN * 100)}% at 2h ago, 1h ago, and now)`);
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
              Gap #1 vs #2 ≥{Math.round(GAP_MIN * 100)}% now AND 1h ago. 2h shown for context.
            </div>
          </div>
        </div>
        <button
          onClick={scan}
          disabled={scanning}
          className="inline-flex items-center gap-1.5 rounded border border-border bg-background hover:bg-surface-2 px-2.5 py-1 text-[11px] disabled:opacity-50"
        >
          {scanning ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
          {scanning ? `${progress}%` : "Rescan"}
        </button>
      </div>

      {scanning && items.length === 0 && (
        <div className="px-4 py-6 text-center text-xs text-muted-foreground">
          Checking {markets.length} market{markets.length === 1 ? "" : "s"}…
        </div>
      )}

      {!scanning && items.length === 0 && scannedAt != null && (
        <div className="px-4 py-6 text-center text-xs text-muted-foreground">
          No markets qualified — need gap ≥{Math.round(GAP_MIN * 100)}% at 2h ago, 1h ago, and now.
        </div>
      )}

      {items.length > 0 && (
        <ul className="divide-y divide-border/50">
          {items.map((m) => <Row key={m.market.id} m={m} onSelect={onSelect} />)}
        </ul>
      )}
    </div>
  );
};

const TRAJ_META: Record<Trajectory, { label: string; badge: string; arrow: string }> = {
  accelerating: {
    label: "Accelerating",
    badge: "bg-emerald-500/20 text-emerald-300 border-emerald-500/40",
    arrow: "text-emerald-400",
  },
  widening: {
    label: "Widening",
    badge: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
    arrow: "text-emerald-400",
  },
  flat: {
    label: "Flat",
    badge: "bg-muted text-muted-foreground border-border",
    arrow: "text-muted-foreground",
  },
  narrowing: {
    label: "Narrowing",
    badge: "bg-red-500/15 text-red-400 border-red-500/30",
    arrow: "text-red-400",
  },
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
  const nowColor = m.trajectory === "narrowing"
    ? "text-red-400"
    : m.trajectory === "flat"
      ? "text-foreground"
      : "text-emerald-400";

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
          <span className={cn("inline-flex items-center px-1.5 py-0.5 rounded border text-[9px] uppercase tracking-wider", meta.badge)}>
            {meta.label} {netSign}{netPct}%
          </span>
          <span className="text-xs text-muted-foreground truncate">· {m.market.city}</span>
        </div>
        <div className="mt-1.5 inline-flex items-center gap-2 rounded border border-border bg-background/60 px-2.5 py-1.5">
          <div className="flex flex-col items-center">
            <span className="text-[9px] uppercase tracking-wider text-muted-foreground">2h ago</span>
            <span className="font-mono-num text-sm font-semibold text-foreground leading-tight">{gap2hPct}%</span>
          </div>
          <span className={cn("text-base", meta.arrow)}>→</span>
          <div className="flex flex-col items-center">
            <span className="text-[9px] uppercase tracking-wider text-muted-foreground">1h ago</span>
            <span className="font-mono-num text-sm font-semibold text-foreground leading-tight">{gap1hPct}%</span>
          </div>
          <span className={cn("text-base", meta.arrow)}>→</span>
          <div className="flex flex-col items-center">
            <span className="text-[9px] uppercase tracking-wider text-muted-foreground">Now</span>
            <span className={cn("font-mono-num text-sm font-bold leading-tight", nowColor)}>{gapNowPct}%</span>
          </div>
          <span className="text-[9px] uppercase tracking-wider text-muted-foreground ml-1">Gap #1 vs #2</span>
        </div>
      </div>
      <div className="flex items-center gap-3 pl-0 sm:pl-0">
        <div className="text-right">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Entry</div>
          <div className="font-mono-num font-semibold text-foreground">{entryPct}%</div>
        </div>
        <div className="text-right">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Upside</div>
          <div className="font-mono-num font-semibold text-emerald-400">+{upsidePct}%</div>
        </div>
        <button
          onClick={copy}
          className="inline-flex items-center gap-1 rounded border border-border bg-background hover:bg-surface-2 px-2 py-1 text-[11px]"
        >
          {copied ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </li>
  );
};
