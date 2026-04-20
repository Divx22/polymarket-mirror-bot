import { useEffect, useState } from "react";
import { Sparkles, TrendingUp, AlertCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  type WeatherMarket, type WeatherOutcome, type WeatherSignal,
  pct, edgeColor, confidenceColor,
} from "@/lib/weather";
import { cn } from "@/lib/utils";

export type ScoredOutcome = {
  outcome: WeatherOutcome;
  market: WeatherMarket;
  signal: WeatherSignal | null;
};

type Props = {
  markets: WeatherMarket[];
  outcomes: Record<string, WeatherOutcome[]>;
  signals: Record<string, WeatherSignal>;
  onSelect?: (market: WeatherMarket) => void;
};

const MIN_EDGE = 0.07;

export const BestTradeSignal = ({ markets, outcomes, signals, onSelect }: Props) => {
  // Flatten all outcomes with their parent market + signal context, filter by edge
  const scored: ScoredOutcome[] = [];
  for (const m of markets) {
    const outs = outcomes[m.id] ?? [];
    const sig = signals[m.id] ?? null;
    for (const o of outs) {
      if ((o.edge ?? -Infinity) >= MIN_EDGE) {
        scored.push({ outcome: o, market: m, signal: sig });
      }
    }
  }
  scored.sort((a, b) => (b.outcome.edge ?? -Infinity) - (a.outcome.edge ?? -Infinity));

  if (scored.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-card p-5 flex items-center gap-3">
        <AlertCircle className="h-5 w-5 text-muted-foreground" />
        <div>
          <div className="text-sm font-semibold">No clear edge right now</div>
          <div className="text-xs text-muted-foreground">
            All tracked markets have edge below 7%. Refresh forecasts or add new markets.
          </div>
        </div>
      </div>
    );
  }

  const best = scored[0];
  const others = scored.slice(1, 6);

  return (
    <div className="space-y-3">
      <BestCard pick={best} onSelect={onSelect} />
      {others.length > 0 && (
        <div className="rounded-lg border border-border bg-card overflow-hidden">
          <div className="px-4 py-2 text-[10px] uppercase tracking-wider text-muted-foreground border-b border-border bg-surface-2/40">
            Other Opportunities
          </div>
          <ul className="divide-y divide-border/50">
            {others.map((p) => (
              <li
                key={p.outcome.id}
                onClick={() => onSelect?.(p.market)}
                className="flex items-center gap-3 px-4 py-2.5 text-sm hover:bg-surface-2/50 cursor-pointer"
              >
                <TrendingUp className="h-3.5 w-3.5 text-emerald-400 shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="truncate font-medium">{p.outcome.label}</div>
                  <div className="truncate text-[11px] text-muted-foreground">
                    {p.market.city} · {p.market.market_question}
                  </div>
                </div>
                <div className="flex items-center gap-4 text-xs font-mono-num">
                  <span className="text-muted-foreground">
                    M {pct(p.outcome.p_model, 0)}
                  </span>
                  <span className="text-muted-foreground">
                    P {pct(p.outcome.polymarket_price, 0)}
                  </span>
                  <span className={cn("font-semibold w-14 text-right", edgeColor(p.outcome.edge))}>
                    {pct(p.outcome.edge)}
                  </span>
                  <span className="w-10 text-right">
                    {p.outcome.suggested_size_percent ?? 0}%
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
};

const BestCard = ({ pick, onSelect }: { pick: ScoredOutcome; onSelect?: (m: WeatherMarket) => void }) => {
  const { outcome: o, market: m, signal } = pick;
  const conf = signal?.confidence_level ?? null;
  const [book, setBook] = useState<{ bid: number | null; ask: number | null } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setBook(null);
    if (!o.clob_token_id) return;
    (async () => {
      try {
        const r = await fetch(`https://clob.polymarket.com/book?token_id=${o.clob_token_id}`);
        if (!r.ok) return;
        const j = await r.json();
        const bid = Number(j?.bids?.[j.bids.length - 1]?.price ?? j?.bids?.[0]?.price);
        const ask = Number(j?.asks?.[j.asks.length - 1]?.price ?? j?.asks?.[0]?.price);
        if (!cancelled) {
          setBook({
            bid: Number.isFinite(bid) ? bid : null,
            ask: Number.isFinite(ask) ? ask : null,
          });
        }
      } catch { /* ignore */ }
    })();
    return () => { cancelled = true; };
  }, [o.clob_token_id]);

  const mid = o.polymarket_price ?? null;
  const bid = book?.bid ?? null;
  const lo = bid != null ? bid : mid != null ? Math.max(0, mid - 0.01) : null;
  const hi = mid;

  return (
    <div
      onClick={() => onSelect?.(m)}
      className="rounded-lg border border-emerald-500/40 bg-gradient-to-br from-emerald-500/10 via-emerald-500/5 to-transparent p-5 cursor-pointer hover:border-emerald-500/60 transition-colors"
    >
      <div className="flex items-start justify-between gap-4 mb-4">
        <div className="flex items-center gap-2">
          <Sparkles className="h-5 w-5 text-emerald-400" />
          <div>
            <div className="text-[10px] uppercase tracking-[0.15em] text-emerald-400 font-semibold">
              Best Trade
            </div>
            <div className="text-xs text-muted-foreground truncate max-w-[420px]">
              {m.city} · {m.market_question}
            </div>
          </div>
        </div>
        {conf && (
          <Badge variant="outline" className={cn("uppercase text-[10px] tracking-wider", confidenceColor(conf))}>
            {conf}
          </Badge>
        )}
      </div>

      <div className="flex items-baseline gap-3 mb-5">
        <div className="text-3xl font-bold">Buy YES</div>
        <div className="text-3xl font-bold text-emerald-400">{o.label}</div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
        <Metric label="Model Prob." value={pct(o.p_model, 1)} />
        <Metric label="Market Price" value={pct(o.polymarket_price, 1)} />
        <Metric
          label="Edge"
          value={pct(o.edge, 1)}
          valueClass={cn("font-semibold", edgeColor(o.edge))}
        />
        <Metric
          label="Suggested Size"
          value={`${o.suggested_size_percent ?? 0}%`}
          sub="of bankroll"
        />
      </div>

      <div className="rounded border border-border/60 bg-background/40 px-3 py-2 text-xs">
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-0.5">
          Entry Guidance
        </div>
        {lo != null && hi != null ? (
          <div>
            Place limit orders between{" "}
            <span className="font-mono-num font-semibold text-foreground">
              {(lo * 100).toFixed(1)}¢
            </span>
            {" and "}
            <span className="font-mono-num font-semibold text-foreground">
              {(hi * 100).toFixed(1)}¢
            </span>
            {book?.ask != null && (
              <span className="text-muted-foreground">
                {" "}· ask {(book.ask * 100).toFixed(1)}¢
              </span>
            )}
          </div>
        ) : (
          <div className="text-muted-foreground">Fetching live book…</div>
        )}
      </div>
    </div>
  );
};

const Metric = ({
  label, value, sub, valueClass,
}: { label: string; value: React.ReactNode; sub?: string; valueClass?: string }) => (
  <div className="rounded border border-border/60 bg-background/40 px-3 py-2">
    <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
    <div className={cn("text-lg font-mono-num", valueClass)}>{value}</div>
    {sub && <div className="text-[10px] text-muted-foreground">{sub}</div>}
  </div>
);
