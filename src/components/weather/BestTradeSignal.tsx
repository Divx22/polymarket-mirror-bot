import { useEffect, useState } from "react";
import { Sparkles, TrendingUp, AlertCircle, Copy, Check } from "lucide-react";
import { toast } from "sonner";
import {
  type WeatherMarket, type WeatherOutcome, type WeatherSignal,
  pct, edgeColor, isSettlementRisk,
} from "@/lib/weather";
import { cn } from "@/lib/utils";
import { PositionCalculator } from "./PositionCalculator";
import { ConfidenceExplainer } from "./ConfidenceExplainer";

export type ScoredOutcome = {
  outcome: WeatherOutcome;
  market: WeatherMarket;
  signal: WeatherSignal | null;
};

type Props = {
  markets: WeatherMarket[];
  outcomes: Record<string, WeatherOutcome[]>;
  signals: Record<string, WeatherSignal>;
  bankroll: number;
  minVolume?: number;
  mismatchOnly?: boolean;
  maxTradePct?: number;
  onSelect?: (market: WeatherMarket) => void;
};

const MIN_EDGE = 0.07;

export const BestTradeSignal = ({ markets, outcomes, signals, bankroll, minVolume = 0, mismatchOnly = false, maxTradePct = 2, onSelect }: Props) => {
  // Flatten all outcomes with their parent market + signal context, filter by edge + volume + mismatch
  const scored: ScoredOutcome[] = [];
  for (const m of markets) {
    const vol = Number(m.event_volume_24h ?? 0);
    if (vol < minVolume) continue;
    // Skip markets within the settlement-risk window — apparent edge here is
    // almost always a settlement quirk, not real alpha.
    if (isSettlementRisk(m.event_time)) continue;
    const sig = signals[m.id] ?? null;
    if (mismatchOnly && !sig?.favorite_mismatch) continue;
    const outs = outcomes[m.id] ?? [];
    for (const o of outs) {
      if ((o.edge ?? -Infinity) >= MIN_EDGE) {
        scored.push({ outcome: o, market: m, signal: sig });
      }
    }
  }
  scored.sort((a, b) => {
    const ma = a.signal?.favorite_mismatch ? 1 : 0;
    const mb = b.signal?.favorite_mismatch ? 1 : 0;
    if (ma !== mb) return mb - ma;
    return (b.outcome.edge ?? -Infinity) - (a.outcome.edge ?? -Infinity);
  });

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
      <BestCard pick={best} bankroll={bankroll} maxTradePct={maxTradePct} onSelect={onSelect} />
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
                className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3 px-3 sm:px-4 py-2.5 text-sm hover:bg-surface-2/50 cursor-pointer"
              >
                <div className="flex items-center gap-2 flex-1 min-w-0">
                  <TrendingUp className="h-3.5 w-3.5 text-emerald-400 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="truncate font-medium">{p.outcome.label}</div>
                    <div className="truncate text-[11px] text-muted-foreground">
                      {p.market.city} · {p.market.market_question}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-3 sm:gap-4 text-xs font-mono-num pl-5 sm:pl-0">
                  <span className="text-muted-foreground">
                    M {pct(p.outcome.p_model, 0)}
                  </span>
                  <span className="text-muted-foreground">
                    P {pct(p.outcome.polymarket_price, 0)}
                  </span>
                  <span className={cn("font-semibold w-12 sm:w-14 text-right", edgeColor(p.outcome.edge))}>
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

const BestCard = ({ pick, bankroll, maxTradePct = 2, onSelect }: { pick: ScoredOutcome; bankroll: number; maxTradePct?: number; onSelect?: (m: WeatherMarket) => void }) => {
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
  const ask = book?.ask ?? null;
  // Exact instruction: place a limit BUY at the current best ask (fills immediately).
  // If you want to be patient and save 1 tick, use ask - 0.01 (may not fill).
  const limitPrice = ask ?? mid;
  const patientPrice = limitPrice != null ? Math.max(0.01, limitPrice - 0.01) : null;

  return (
    <div
      onClick={() => onSelect?.(m)}
      className="rounded-lg border border-emerald-500/40 bg-gradient-to-br from-emerald-500/10 via-emerald-500/5 to-transparent p-3 sm:p-5 cursor-pointer hover:border-emerald-500/60 transition-colors"
    >
      {signal?.favorite_mismatch && signal.market_favorite_label && (
        <div className="mb-3 rounded border border-emerald-500/40 bg-emerald-500/10 px-3 py-1.5 text-[11px] text-emerald-300 leading-relaxed flex items-start gap-1.5">
          <span>⚡</span>
          <span>
            Market favorite is <span className="font-semibold text-foreground">{signal.market_favorite_label}</span> — your model disagrees.
          </span>
        </div>
      )}
      {signal?.distribution?.sources?.provider_disagreement && (
        <div className="mb-3 rounded border border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-[11px] text-amber-300 leading-relaxed flex items-start gap-1.5">
          <span>⚠</span>
          <span>
            <span className="font-semibold text-foreground">Provider disagreement</span> — independent forecast{(signal.distribution.sources.disagreements?.length ?? 0) > 1 ? "s" : ""} differ from primary by &gt;2°C
            {(signal.distribution.sources.disagreements ?? []).map((d, i) => (
              <span key={d.source} className="text-foreground">
                {i === 0 ? ": " : ", "}
                {d.source === "nbm" ? "NBM" : d.source === "visual_crossing" ? "Visual Crossing" : d.source} {d.delta_c > 0 ? "+" : ""}{d.delta_c.toFixed(1)}°C
              </span>
            ))}
            . Treat edge with caution.
          </span>
        </div>
      )}
      <div className="flex items-start justify-between gap-3 mb-3 sm:mb-4">
        <div className="flex items-center gap-2 min-w-0">
          <Sparkles className="h-5 w-5 text-emerald-400 shrink-0" />
          <div className="min-w-0">
            <div className="text-[10px] uppercase tracking-[0.15em] text-emerald-400 font-semibold">
              Best Trade
            </div>
            <div className="text-xs text-muted-foreground truncate max-w-[260px] sm:max-w-[420px]">
              {m.city} · {m.market_question}
            </div>
          </div>
        </div>
        {conf && (
          <ConfidenceExplainer
            confidence={conf}
            signal={signal}
            outcome={o}
            market={m}
          />
        )}
      </div>

      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 mb-4 sm:mb-5">
        <div className="text-2xl sm:text-3xl font-bold">Buy YES</div>
        <div className="text-2xl sm:text-3xl font-bold text-emerald-400 break-words">{o.label}</div>
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

      {o.p_model != null && o.p_model > 0.8 && o.polymarket_price != null && o.polymarket_price < 0.3 && (
        <div className="rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-300 mb-2 leading-relaxed">
          <span className="font-semibold">⚠ VERIFY before sizing up.</span> Model says &gt;80% but market is &lt;30%.
          Likely causes: resolution window (station vs. grid), forecast lag, or microclimate near a temperature threshold.
          Treat suggested size as a ceiling, not a target.
        </div>
      )}

      <div className="rounded border border-border/60 bg-background/40 px-3 py-2 text-[11px] text-muted-foreground mb-2 leading-relaxed">
        <span className="text-foreground font-medium">How edge is computed:</span>{" "}
        <span className="text-foreground">Model Prob.</span> = share of the live{" "}
        <span className="text-foreground">ECMWF 51-member ensemble</span> (Open-Meteo) whose daily-max
        temperature lands in this bucket. GFS is <span className="text-foreground">not blended into
        probability</span> — it's a single deterministic run, so it only adjusts{" "}
        <span className="text-foreground">Confidence</span> via agreement with ECMWF.{" "}
        <span className="text-foreground">Edge = Model Prob − Market Price.</span>{" "}
        Positive = market underprices vs. ensemble consensus.
      </div>

      {limitPrice != null && (
        <div className="rounded border border-border/60 bg-background/40 px-3 py-2 text-xs">
          <div className="flex items-center justify-between gap-2 mb-1">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Entry Guidance
            </div>
            <CopyPriceButton priceCents={limitPrice * 100} />
          </div>
          <div className="leading-relaxed">
            Place a <span className="font-semibold text-foreground">limit BUY</span> at{" "}
            <span className="font-mono-num font-semibold text-emerald-400">
              {(limitPrice * 100).toFixed(1)}¢
            </span>{" "}
            <span className="text-muted-foreground">(current best ask — fills now).</span>
            {patientPrice != null && patientPrice < limitPrice && (
              <div className="text-muted-foreground mt-0.5">
                Patient: try{" "}
                <span className="font-mono-num text-foreground">
                  {(patientPrice * 100).toFixed(1)}¢
                </span>{" "}
                to save 1¢ (may not fill).
              </div>
            )}
          </div>
        </div>
      )}

      <div className="mt-2">
        <PositionCalculator
          bankrollUsdc={bankroll}
          sizePct={Number(o.suggested_size_percent ?? 0)}
          bid={bid}
          mid={mid}
          maxTradePct={maxTradePct}
        />
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

const CopyPriceButton = ({ priceCents }: { priceCents: number }) => {
  const [copied, setCopied] = useState(false);
  const text = priceCents.toFixed(1); // e.g. "24.5" — paste-ready into Polymarket cents field
  const onClick = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      toast.success(`Copied ${text}¢`);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Copy failed");
    }
  };
  return (
    <button
      onClick={onClick}
      className="inline-flex items-center gap-1 rounded border border-border/60 bg-background/60 hover:bg-surface-2 px-2 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors"
    >
      {copied ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
      {copied ? "Copied" : "Copy price"}
    </button>
  );
};

