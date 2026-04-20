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

// SIMPLE RULE:
//   Compare the gap between #1 and #2 outcomes 1 hour ago vs now (same two outcomes).
// RULES (newbie-friendly):
//   Round 1: current gap between #1 and #2 outcomes must be ≥ GAP_MIN.
//   Round 2: 1h ago, the SAME two outcomes' gap must ALSO have been ≥ GAP_MIN.
//   Display the change: positive = widening, 0% = flat, negative = narrowing.
const WINDOW_HOURS = 1;
const GAP_MIN = 0.15;          // 15% threshold for both rounds
const MAX_ENTRY_PRICE = 0.95;  // virtually never enter at >95%
const MIN_HOURS_TO_EVENT = 0.5;

type HistPoint = { t: number; p: number };

type Movement = {
  market: WeatherMarket;
  leader: WeatherOutcome;
  runnerUp: WeatherOutcome;
  leaderNow: number;
  gapNow: number;
  gapThen: number;        // qualified — always ≥ GAP_MIN
  gapDelta: number;       // gapNow - gapThen (positive=widening, negative=narrowing)
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
    const targetThen = Date.now() - WINDOW_HOURS * 3_600_000;

    let done = 0;
    const BATCH = 4;
    for (let i = 0; i < eligible.length; i += BATCH) {
      const batch = eligible.slice(i, i + BATCH);
      await Promise.all(batch.map(async (m) => {
        const outs = (outcomes[m.id] ?? []).filter(o => o.clob_token_id);
        if (outs.length < 2) return;

        // Fetch LIVE midpoints for every outcome — DB prices are stale snapshots.
        const liveMids = await Promise.all(outs.map(o => fetchMid(o.clob_token_id!)));
        const enriched = outs.map((o, i) => ({ o, mid: liveMids[i] ?? o.polymarket_price ?? 0 }));
        enriched.sort((a, b) => b.mid - a.mid);

        const leader = enriched[0].o;
        const runnerUp = enriched[1].o;
        const leaderNow = enriched[0].mid;
        const runnerNow = enriched[1].mid;
        const gapNow = leaderNow - runnerNow;

        // Round 1: current gap must qualify.
        if (gapNow < GAP_MIN) return;
        if (leaderNow > MAX_ENTRY_PRICE) return;

        // Round 2: same two outcomes' gap 1h ago must also qualify.
        const [leaderHist, runnerHist] = await Promise.all([
          fetchHistory(leader.clob_token_id!),
          fetchHistory(runnerUp.clob_token_id!),
        ]);
        const leaderThen = priceAt(leaderHist, targetThen);
        const runnerThen = priceAt(runnerHist, targetThen);
        if (leaderThen == null || runnerThen == null) return; // no history → can't qualify
        const gapThen = leaderThen - runnerThen;
        if (gapThen < GAP_MIN) return; // failed Round 2

        const gapDelta = gapNow - gapThen;
        found.push({ market: m, leader, runnerUp, leaderNow, gapNow, gapThen, gapDelta });
      }));
      done += batch.length;
      setProgress(Math.round((done / eligible.length) * 100));
    }

    // Sort by largest positive momentum (widening) first; flat/negative after.
    found.sort((a, b) => b.gapDelta - a.gapDelta);

    setItems(found);
    setScannedAt(Date.now());
    setScanning(false);
    const widening = found.filter(f => f.gapDelta > 0).length;
    if (found.length > 0) {
      toast.success(`${found.length} qualified · ${widening} widening`);
    } else {
      toast.info(`No markets qualified (need gap ≥${Math.round(GAP_MIN * 100)}% now AND 1h ago)`);
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
              #1 vs #2 gap is ≥{Math.round(GAP_MIN * 100)}% now AND was ≥{Math.round(GAP_MIN * 100)}% an hour ago. Change shown as ± vs 1h ago.
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
          No markets qualified — need gap ≥{Math.round(GAP_MIN * 100)}% both now and 1h ago.
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

const Row = ({ m, onSelect }: { m: Movement; onSelect?: (mk: WeatherMarket) => void }) => {
  const [copied, setCopied] = useState(false);
  const entryPct = (m.leaderNow * 100).toFixed(1);
  const upsidePct = ((1 - m.leaderNow) * 100).toFixed(1);
  const gapNowPct = (m.gapNow * 100).toFixed(1);
  const gapThenPct = (m.gapThen * 100).toFixed(1);
  const gapDeltaPct = (m.gapDelta * 100).toFixed(1);
  const isFlat = Math.abs(m.gapDelta) < 0.005; // <0.5% rounds to 0
  const isUp = !isFlat && m.gapDelta > 0;
  const badgeClass = isFlat
    ? "bg-muted text-muted-foreground border-border"
    : isUp
      ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/30"
      : "bg-red-500/15 text-red-400 border-red-500/30";
  const badgeLabel = isFlat ? "Flat 0%" : isUp ? `Widening +${gapDeltaPct}%` : `Narrowing ${gapDeltaPct}%`;

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
          <span className={cn("inline-flex items-center px-1.5 py-0.5 rounded border text-[9px] uppercase tracking-wider", badgeClass)}>
            {badgeLabel}
          </span>
          <span className="text-xs text-muted-foreground truncate">· {m.market.city}</span>
        </div>
        <div className="mt-1.5 inline-flex items-center gap-2 rounded border border-border bg-background/60 px-2.5 py-1.5">
          <div className="flex flex-col items-center">
            <span className="text-[9px] uppercase tracking-wider text-muted-foreground">1h ago</span>
            <span className="font-mono-num text-sm font-semibold text-foreground leading-tight">{gapThenPct}%</span>
          </div>
          <span className={cn("text-base", isFlat ? "text-muted-foreground" : isUp ? "text-emerald-400" : "text-red-400")}>→</span>
          <div className="flex flex-col items-center">
            <span className="text-[9px] uppercase tracking-wider text-muted-foreground">Now</span>
            <span className={cn("font-mono-num text-sm font-bold leading-tight", isFlat ? "text-foreground" : isUp ? "text-emerald-400" : "text-red-400")}>{gapNowPct}%</span>
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
