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

type Movement = {
  market: WeatherMarket;
  leader: WeatherOutcome;
  runnerUp: WeatherOutcome | null;
  priceNow: number;       // 0-1
  priceThen: number;      // 0-1, ~2h ago
  delta: number;          // priceNow - priceThen, in price (0-1)
  gap: number;            // priceNow - runnerUp price, in price (0-1)
  liveAsk: number | null; // 0-1
  isBreakout: boolean;    // passes all thresholds
};

// Thresholds (balanced): leader must have risen ≥15¢ in last 2h AND lead #2 by ≥15¢.
const RISE_THRESHOLD = 0.15;
const GAP_THRESHOLD = 0.15;
const WINDOW_HOURS = 2;
// Don't bother once leader is too expensive — no upside left.
const MAX_ENTRY_PRICE = 0.85;
// Skip resolved/about-to-resolve markets (live history would be empty).
const MIN_HOURS_TO_EVENT = 0.5;

type HistPoint = { t: number; p: number };

async function fetchHistory(tokenId: string): Promise<HistPoint[]> {
  // Polymarket prices-history endpoint. interval=1h gives ~hourly samples.
  // fidelity=1 returns minute-level — too noisy. interval=1h is sufficient for 2h delta.
  const url = `https://clob.polymarket.com/prices-history?market=${tokenId}&interval=1h&fidelity=60`;
  try {
    const r = await fetch(url);
    if (!r.ok) return [];
    const j = await r.json();
    const hist: HistPoint[] = (j?.history ?? [])
      .map((h: any) => ({ t: Number(h.t) * 1000, p: Number(h.p) }))
      .filter((h: HistPoint) => Number.isFinite(h.t) && Number.isFinite(h.p));
    return hist.sort((a, b) => a.t - b.t);
  } catch { return []; }
}

async function fetchAsk(tokenId: string): Promise<number | null> {
  try {
    const r = await fetch(`https://clob.polymarket.com/book?token_id=${tokenId}`);
    if (!r.ok) return null;
    const j = await r.json();
    const ask = Number(j?.asks?.[j.asks.length - 1]?.price ?? j?.asks?.[0]?.price);
    return Number.isFinite(ask) ? ask : null;
  } catch { return null; }
}

function priceAt(hist: HistPoint[], targetTs: number): number | null {
  if (hist.length === 0) return null;
  // Find the sample closest to targetTs (within ±30min tolerance).
  let best: HistPoint | null = null;
  let bestDelta = Infinity;
  for (const h of hist) {
    const d = Math.abs(h.t - targetTs);
    if (d < bestDelta) { bestDelta = d; best = h; }
  }
  if (!best || bestDelta > 90 * 60 * 1000) return null; // >90min away → unreliable
  return best.p;
}

export const MomentumBreakouts = ({ markets, outcomes, onSelect }: Props) => {
  const [scanning, setScanning] = useState(false);
  const [breakouts, setBreakouts] = useState<Movement[]>([]);
  const [scannedAt, setScannedAt] = useState<number | null>(null);
  const [progress, setProgress] = useState(0);
  const [showAll, setShowAll] = useState(false);

  const scan = async () => {
    setScanning(true);
    setBreakouts([]);
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
        const outs = (outcomes[m.id] ?? []).filter(o => o.clob_token_id && o.polymarket_price != null);
        if (outs.length < 2) return;

        const sorted = [...outs].sort((a, b) => (b.polymarket_price ?? 0) - (a.polymarket_price ?? 0));
        const leader = sorted[0];
        const runnerUp = sorted[1] ?? null;
        const priceNow = leader.polymarket_price ?? 0;
        const gap = priceNow - (runnerUp?.polymarket_price ?? 0);

        const hist = await fetchHistory(leader.clob_token_id!);
        const priceThen = priceAt(hist, targetThen);
        if (priceThen == null) return; // no history → skip
        const delta = priceNow - priceThen;

        const isBreakout =
          delta >= RISE_THRESHOLD &&
          gap >= GAP_THRESHOLD &&
          priceNow <= MAX_ENTRY_PRICE;

        const liveAsk = isBreakout ? await fetchAsk(leader.clob_token_id!) : null;

        found.push({ market: m, leader, runnerUp, priceNow, priceThen, delta, gap, liveAsk, isBreakout });
      }));
      done += batch.length;
      setProgress(Math.round((done / eligible.length) * 100));
    }

    // Sort by absolute 2h move desc — biggest movers first regardless of direction.
    found.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
    setBreakouts(found);
    setScannedAt(Date.now());
    setScanning(false);
    const breakoutCount = found.filter(f => f.isBreakout).length;
    if (breakoutCount > 0) {
      toast.success(`${breakoutCount} breakout${breakoutCount > 1 ? "s" : ""} detected`);
    } else {
      toast.info(`Scanned ${found.length} market${found.length === 1 ? "" : "s"} — no breakouts`);
    }
  };

  useEffect(() => {
    if (markets.length > 0 && scannedAt == null && !scanning) {
      scan();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [markets.length]);

  const breakoutCount = breakouts.filter(b => b.isBreakout).length;
  const visible = showAll ? breakouts : breakouts.filter(b => b.isBreakout);

  return (
    <div className="rounded-lg border border-border bg-card overflow-hidden">
      <div className="flex items-center justify-between gap-2 px-4 py-2.5 border-b border-border bg-surface-2/40">
        <div className="flex items-center gap-2">
          <TrendingUp className="h-4 w-4 text-blue-400" />
          <div>
            <div className="text-xs font-semibold uppercase tracking-wider">Momentum (All Markets)</div>
            <div className="text-[10px] text-muted-foreground">
              Ranked by 2h price change · Breakout = ≥{Math.round(RISE_THRESHOLD * 100)}¢ rise + gap ≥{Math.round(GAP_THRESHOLD * 100)}¢ + entry ≤{Math.round(MAX_ENTRY_PRICE * 100)}¢
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {breakouts.length > 0 && (
            <button
              onClick={() => setShowAll(v => !v)}
              className="inline-flex items-center gap-1 rounded border border-border bg-background hover:bg-surface-2 px-2.5 py-1 text-[11px]"
            >
              {showAll ? `Breakouts only (${breakoutCount})` : `Show all (${breakouts.length})`}
            </button>
          )}
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

      {scanning && breakouts.length === 0 && (
        <div className="px-4 py-6 text-center text-xs text-muted-foreground">
          Fetching price history for {markets.length} market{markets.length === 1 ? "" : "s"}…
        </div>
      )}

      {!scanning && visible.length === 0 && scannedAt != null && (
        <div className="px-4 py-6 text-center text-xs text-muted-foreground">
          {breakouts.length === 0
            ? "No price history available."
            : `No breakouts. Click "Show all (${breakouts.length})" to see all movers.`}
        </div>
      )}

      {visible.length > 0 && (
        <ul className="divide-y divide-border/50">
          {visible.map((b) => (
            <BreakoutRow key={b.market.id} b={b} onSelect={onSelect} />
          ))}
        </ul>
      )}
    </div>
  );
};


const BreakoutRow = ({ b, onSelect }: { b: Movement; onSelect?: (m: WeatherMarket) => void }) => {
  const [copied, setCopied] = useState(false);
  const entryPrice = b.liveAsk ?? b.priceNow;
  const cents = (entryPrice * 100).toFixed(1);
  const upside = (1 - entryPrice) * 100;
  const isUp = b.delta >= 0;
  const deltaCents = Math.abs(b.delta * 100);

  const copyPrice = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(cents);
      setCopied(true);
      toast.success(`Copied ${cents}¢`);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Copy failed");
    }
  };

  return (
    <li
      onClick={() => onSelect?.(b.market)}
      className={cn(
        "flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3 px-3 sm:px-4 py-3 hover:bg-surface-2/50 cursor-pointer",
        !b.isBreakout && "opacity-70",
      )}
    >
      <div className="flex items-center gap-2 flex-1 min-w-0">
        <TrendingUp className={cn("h-3.5 w-3.5 shrink-0", b.isBreakout ? "text-blue-400" : "text-muted-foreground")} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={cn("font-semibold", b.isBreakout ? "text-blue-400" : "text-foreground")}>{b.leader.label}</span>
            {b.isBreakout && (
              <span className="inline-flex items-center px-1.5 py-0.5 rounded border text-[9px] uppercase tracking-wider bg-blue-500/15 text-blue-400 border-blue-500/30">
                Breakout
              </span>
            )}
            <span className="text-xs text-muted-foreground truncate">
              {b.market.city} · {b.market.market_question}
            </span>
          </div>
          <div className="text-[11px] text-muted-foreground mt-0.5">
            <span className="font-mono-num text-foreground">{(b.priceThen * 100).toFixed(0)}¢ → {(b.priceNow * 100).toFixed(0)}¢</span>
            <span className={cn("font-semibold ml-1", isUp ? "text-emerald-400" : "text-red-400")}>
              ({isUp ? "+" : "−"}{deltaCents.toFixed(0)}¢ / 2h)
            </span>
            {b.runnerUp && (
              <> · #2 <span className="font-mono-num text-foreground">{b.runnerUp.label} {((b.runnerUp.polymarket_price ?? 0) * 100).toFixed(0)}¢</span> · gap <span className="text-foreground font-mono-num">{(b.gap * 100).toFixed(0)}¢</span></>
            )}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-3 pl-5 sm:pl-0">
        <div className="text-right">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Entry</div>
          <div className={cn("font-mono-num font-semibold", b.isBreakout ? "text-blue-400" : "text-foreground")}>{cents}¢</div>
        </div>
        <div className="text-right">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Upside</div>
          <div className={cn("font-mono-num font-semibold", upside >= 30 ? "text-emerald-400" : "text-foreground")}>+{upside.toFixed(0)}¢</div>
        </div>
        <button
          onClick={copyPrice}
          className="inline-flex items-center gap-1 rounded border border-border bg-background hover:bg-surface-2 px-2 py-1 text-[11px]"
        >
          {copied ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </li>
  );
};

