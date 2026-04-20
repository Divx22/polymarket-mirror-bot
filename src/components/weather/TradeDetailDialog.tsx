import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ExternalLink } from "lucide-react";
import { WeatherMarket, WeatherSignal, pct, edgeColor, confidenceColor } from "@/lib/weather";

export const TradeDetailDialog = ({
  open,
  onOpenChange,
  market,
  signal,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  market: WeatherMarket | null;
  signal: WeatherSignal | null;
}) => {
  if (!market) return null;
  const direction = signal?.edge != null && signal.edge > 0 ? "BUY YES" : "BUY NO";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-base">{market.market_question}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 text-sm">
          <div className="flex justify-between text-muted-foreground">
            <span>{market.city} · {market.condition_range}</span>
            <span>{new Date(market.event_time).toLocaleString()}</span>
          </div>

          <div className="grid grid-cols-2 gap-3 rounded-lg border border-border p-3">
            <Stat label="NOAA" value={pct(signal?.p_noaa)} />
            <Stat label="ECMWF" value={pct(signal?.p_ecmwf)} />
            <Stat label="Final" value={pct(signal?.p_final)} />
            <Stat label="Market" value={pct(signal?.p_market)} />
            <Stat label="Agreement" value={pct(signal?.agreement)} />
            <Stat
              label="Edge"
              value={pct(signal?.edge)}
              className={edgeColor(signal?.edge)}
            />
          </div>

          {signal?.suggested_size_percent != null && signal.suggested_size_percent > 0 ? (
            <div className="rounded-lg border border-border p-3 space-y-2">
              <div className="flex justify-between items-center">
                <span className="text-muted-foreground">Suggested action</span>
                <span className={`px-2 py-0.5 rounded border text-xs uppercase tracking-wider ${confidenceColor(signal?.confidence_level)}`}>
                  {signal?.confidence_level ?? "—"}
                </span>
              </div>
              <div className="font-semibold">
                {direction} — size {signal.suggested_size_percent}% of bankroll
              </div>
              <p className="text-muted-foreground text-xs">
                Place limit orders below ask. Scale into position in 2–3 parts.
              </p>
            </div>
          ) : (
            <div className="rounded-lg border border-border p-3 text-muted-foreground text-xs">
              Edge is below the 7% threshold — no trade suggested.
            </div>
          )}

          {market.polymarket_url && (
            <a
              href={market.polymarket_url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-primary hover:underline text-xs"
            >
              Open on Polymarket <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
};

const Stat = ({ label, value, className = "" }: { label: string; value: string; className?: string }) => (
  <div>
    <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
    <div className={`font-mono-num text-base ${className}`}>{value}</div>
  </div>
);
