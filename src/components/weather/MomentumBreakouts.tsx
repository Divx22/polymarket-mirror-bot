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
  const [breakouts, setBreakouts] = useState<Breakout[]>([]);
  const [scannedAt, setScannedAt] = useState<number | null>(null);
  const [progress, setProgress] = useState(0);

  const scan = async () => {
    setScanning(true);
    setBreakouts([]);
    setProgress(0);

    const eligible = markets.filter((m) => {
      const hours = (new Date(m.event_time).getTime() - Date.now()) / 3_600_000;
      return hours > MIN_HOURS_TO_EVENT;
    });

    const found: Breakout[] = [];
    const now = Date.now();
    const targetThen = now - WINDOW_HOURS * 3_600_000;

    let done = 0;
    // Process markets in parallel batches of 4 to avoid hammering the API.
    const BATCH = 4;
    for (let i = 0; i < eligible.length; i += BATCH) {
      const batch = eligible.slice(i, i + BATCH);
      await Promise.all(batch.map(async (m) => {
        const outs = (outcomes[m.id] ?? []).filter(o => o.clob_token_id && o.polymarket_price != null);
        if (outs.length < 2) return;

        // Sort by current price desc.
        const sorted = [...outs].sort((a, b) => (b.polymarket_price ?? 0) - (a.polymarket_price ?? 0));
        const leader = sorted[0];
        const runnerUp = sorted[1] ?? null;
        const priceNow = leader.polymarket_price ?? 0;
        if (priceNow > MAX_ENTRY_PRICE) return;

        const gap = priceNow - (runnerUp?.polymarket_price ?? 0);
        if (gap < GAP_THRESHOLD) return;

        // Need history to compute delta.
        const hist = await fetchHistory(leader.clob_token_id!);
        const priceThen = priceAt(hist, targetThen);
        if (priceThen == null) return;
        const delta = priceNow - priceThen;
        if (delta < RISE_THRESHOLD) return;

        // Passes — fetch live ask for entry guidance.
        const liveAsk = await fetchAsk(leader.clob_token_id!);

        found.push({ market: m, leader, runnerUp, priceNow, priceThen, delta, gap, liveAsk });
      }));
      done += batch.length;
      setProgress(Math.round((done / eligible.length) * 100));
    }

    found.sort((a, b) => b.delta - a.delta);
    setBreakouts(found);
    setScannedAt(Date.now());
    setScanning(false);
    if (found.length === 0) {
      toast.info("No momentum breakouts right now");
    } else {
      toast.success(`${found.length} breakout${found.length > 1 ? "s" : ""} detected`);
    }
  };

  // Auto-scan on mount when markets first load.
  useEffect(() => {
    if (markets.length > 0 && scannedAt == null && !scanning) {
      scan();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [markets.length]);

  return (
    <div className="rounded-lg border border-border bg-card overflow-hidden">
      <div className="flex items-center justify-between gap-2 px-4 py-2.5 border-b border-border bg-surface-2/40">
        <div className="flex items-center gap-2">
          <TrendingUp className="h-4 w-4 text-blue-400" />
          <div>
            <div className="text-xs font-semibold uppercase tracking-wider">Momentum Breakouts</div>
            <div className="text-[10px] text-muted-foreground">
              Leader rose ≥{Math.round(RISE_THRESHOLD * 100)}¢ in {WINDOW_HOURS}h · gap to #2 ≥{Math.round(GAP_THRESHOLD * 100)}¢ · price ≤{Math.round(MAX_ENTRY_PRICE * 100)}¢
            </div>
          </div>
        </div>
        <button
          onClick={scan}
          disabled={scanning}
          className="inline-flex items-center gap-1.5 rounded border border-border bg-background hover:bg-surface-2 px-2.5 py-1 text-[11px] disabled:opacity-50"
        >
          {scanning ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
          {scanning ? `Scanning ${progress}%` : "Rescan"}
        </button>
      </div>

      {scanning && breakouts.length === 0 && (
        <div className="px-4 py-6 text-center text-xs text-muted-foreground">
          Fetching price history for {markets.length} market{markets.length === 1 ? "" : "s"}…
        </div>
      )}

      {!scanning && breakouts.length === 0 && scannedAt != null && (
        <div className="px-4 py-6 text-center text-xs text-muted-foreground">
          No breakouts. Leaders are either flat, too expensive, or the field is too tight.
        </div>
      )}

      {breakouts.length > 0 && (
        <ul className="divide-y divide-border/50">
          {breakouts.map((b) => (
            <BreakoutRow key={b.market.id} b={b} onSelect={onSelect} />
          ))}
        </ul>
      )}
    </div>
  );
};

const BreakoutRow = ({ b, onSelect }: { b: Breakout; onSelect?: (m: WeatherMarket) => void }) => {
  const [copied, setCopied] = useState(false);
  const entryPrice = b.liveAsk ?? b.priceNow;
  const cents = (entryPrice * 100).toFixed(1);
  const upside = (1 - entryPrice) * 100;

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
      className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3 px-3 sm:px-4 py-3 hover:bg-surface-2/50 cursor-pointer"
    >
      <div className="flex items-center gap-2 flex-1 min-w-0">
        <TrendingUp className="h-3.5 w-3.5 text-blue-400 shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-blue-400">{b.leader.label}</span>
            <span className="text-xs text-muted-foreground truncate">
              {b.market.city} · {b.market.market_question}
            </span>
          </div>
          <div className="text-[11px] text-muted-foreground mt-0.5">
            Rose <span className="font-mono-num text-foreground">{(b.priceThen * 100).toFixed(0)}¢ → {(b.priceNow * 100).toFixed(0)}¢</span>
            <span className="text-emerald-400 font-semibold"> (+{(b.delta * 100).toFixed(0)}¢ / 2h)</span>
            {b.runnerUp && (
              <> · #2 <span className="font-mono-num text-foreground">{b.runnerUp.label} {((b.runnerUp.polymarket_price ?? 0) * 100).toFixed(0)}¢</span> · gap <span className="text-foreground font-mono-num">{(b.gap * 100).toFixed(0)}¢</span></>
            )}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-3 pl-5 sm:pl-0">
        <div className="text-right">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Entry</div>
          <div className="font-mono-num font-semibold text-blue-400">{cents}¢</div>
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
