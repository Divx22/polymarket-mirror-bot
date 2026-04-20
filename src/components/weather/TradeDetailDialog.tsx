import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { ExternalLink, Sparkles } from "lucide-react";
import {
  type WeatherMarket, type WeatherOutcome, type WeatherSignal,
  pct, edgeColor, confidenceColor,
} from "@/lib/weather";
import { cn } from "@/lib/utils";

const computeShares = (bankroll: number, sizePct: number, price: number | null) => {
  const value = Math.max(0, (bankroll * sizePct) / 100);
  if (!price || price <= 0) return { value, shares: 0 };
  return { value, shares: Math.floor(value / price) };
};

export const TradeDetailDialog = ({
  open,
  onOpenChange,
  market,
  outcomes,
  signal,
  bankroll,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  market: WeatherMarket | null;
  outcomes: WeatherOutcome[];
  signal: WeatherSignal | null;
  bankroll: number;
}) => {
  if (!market) return null;

  const sorted = [...outcomes].sort((a, b) => (b.edge ?? -Infinity) - (a.edge ?? -Infinity));
  const best = sorted.find((o) => (o.edge ?? -Infinity) >= 0.07) ?? null;
  const bestPlan = best
    ? computeShares(bankroll, Number(best.suggested_size_percent ?? 0), best.polymarket_price ?? null)
    : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl w-[calc(100vw-1rem)] max-h-[90vh] overflow-y-auto p-3 sm:p-6">
        <DialogHeader>
          <DialogTitle className="text-base pr-6">
            {market.market_question}
          </DialogTitle>
        </DialogHeader>

        {/* Big Polymarket CTA */}
        {market.polymarket_url && (
          <a
            href={market.polymarket_url}
            target="_blank"
            rel="noreferrer"
            className="flex items-center justify-center gap-2 w-full rounded-md bg-primary text-primary-foreground font-semibold py-3 px-4 hover:opacity-90 transition-opacity shadow-sm"
          >
            <ExternalLink className="h-5 w-5" />
            Open on Polymarket
          </a>
        )}

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
          <Stat label="City" value={market.city} />
          <Stat label="Event Time" value={new Date(market.event_time).toLocaleString()} />
          <Stat label="Agreement" value={signal ? pct(signal.agreement, 0) : "—"} />
          <Stat
            label="Confidence"
            value={
              signal?.confidence_level ? (
                <Badge variant="outline" className={confidenceColor(signal.confidence_level)}>
                  {signal.confidence_level}
                </Badge>
              ) : "—"
            }
          />
        </div>

        {signal && (signal.market_favorite_label || signal.model_favorite_label) && (
          <div className="rounded-md border border-border bg-surface-2/40 p-3 space-y-1.5">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Market vs Model</div>
            <div className="grid grid-cols-2 gap-2 text-xs">
              <div>
                <div className="text-muted-foreground">Model says</div>
                <div className="font-medium">
                  {signal.model_favorite_label ?? "—"}{" "}
                  <span className="font-mono-num text-muted-foreground">
                    ({pct(signal.model_favorite_prob, 0)})
                  </span>
                </div>
              </div>
              <div>
                <div className="text-muted-foreground">Market says</div>
                <div className="font-medium">
                  {signal.market_favorite_label ?? "—"}{" "}
                  <span className="font-mono-num text-muted-foreground">
                    ({signal.market_favorite_price != null ? `${(signal.market_favorite_price * 100).toFixed(0)}¢` : "—"})
                  </span>
                </div>
              </div>
            </div>
            {signal.favorite_mismatch && (
              <div className="text-[11px] text-emerald-400 pt-1">
                ⚡ The market is betting on a different outcome than the forecast.
              </div>
            )}
          </div>
        )}

        {best && bestPlan && (
          <div className="border border-emerald-500/30 bg-emerald-500/10 rounded-md p-3 sm:p-4 space-y-3">
            <div className="flex items-center gap-2">
              <Sparkles className="h-5 w-5 text-emerald-400 shrink-0" />
              <div className="font-semibold text-sm sm:text-base">
                Buy YES <span className="text-emerald-400">{best.label}</span>
              </div>
            </div>
            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="bg-background/40 rounded p-2">
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Spend</div>
                <div className="font-mono-num font-bold text-base sm:text-lg">
                  ${bestPlan.value.toFixed(2)}
                </div>
              </div>
              <div className="bg-background/40 rounded p-2">
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Shares</div>
                <div className="font-mono-num font-bold text-base sm:text-lg">
                  {bestPlan.shares.toLocaleString()}
                </div>
              </div>
              <div className="bg-background/40 rounded p-2">
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Price</div>
                <div className="font-mono-num font-bold text-base sm:text-lg">
                  {best.polymarket_price != null ? `${(best.polymarket_price * 100).toFixed(0)}¢` : "—"}
                </div>
              </div>
            </div>
            <div className="text-[11px] text-muted-foreground text-center">
              Edge <span className={cn("font-semibold", edgeColor(best.edge))}>{pct(best.edge)}</span>
              {" · "}Size {best.suggested_size_percent ?? 0}% of ${bankroll.toLocaleString()}
            </div>
          </div>
        )}

        <div className="overflow-x-auto -mx-3 sm:mx-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Outcome</TableHead>
              <TableHead className="text-right">Edge</TableHead>
              <TableHead className="text-right">Price</TableHead>
              <TableHead className="text-right">Spend</TableHead>
              <TableHead className="text-right">Shares</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sorted.map((o) => {
              const isBest = best?.id === o.id;
              const sz = Number(o.suggested_size_percent ?? 0);
              const { value, shares } = computeShares(bankroll, sz, o.polymarket_price ?? null);
              return (
                <TableRow key={o.id} className={cn(isBest && "bg-emerald-500/5")}>
                  <TableCell className="font-medium">
                    {o.label}
                    <div className="text-[10px] text-muted-foreground">
                      Model {pct(o.p_model, 0)} · Mkt {pct(o.polymarket_price, 0)}
                    </div>
                  </TableCell>
                  <TableCell className={cn("text-right font-medium font-mono-num", edgeColor(o.edge))}>
                    {pct(o.edge)}
                  </TableCell>
                  <TableCell className="text-right font-mono-num">
                    {o.polymarket_price != null ? `${(o.polymarket_price * 100).toFixed(0)}¢` : "—"}
                  </TableCell>
                  <TableCell className="text-right font-mono-num">
                    {value > 0 ? `$${value.toFixed(2)}` : "—"}
                  </TableCell>
                  <TableCell className="text-right font-mono-num font-semibold">
                    {shares > 0 ? shares.toLocaleString() : "—"}
                  </TableCell>
                </TableRow>
              );
            })}
            {sorted.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="text-center text-muted-foreground py-8">
                  No outcomes yet. Refresh to compute probabilities.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
        </div>

        <div className="border-t border-border pt-3 text-xs text-muted-foreground">
          <div className="font-medium text-foreground mb-1">How to execute</div>
          Click <span className="text-foreground font-medium">Open on Polymarket</span> above, then place a limit
          order at or just below the listed price for the exact share count shown.
          Scale into the position in 2–3 parts. Re-check the forecast within 6h of event time.
        </div>
      </DialogContent>
    </Dialog>
  );
};

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="border border-border rounded p-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="font-medium">{value}</div>
    </div>
  );
}
