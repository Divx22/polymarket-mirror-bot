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

export const TradeDetailDialog = ({
  open,
  onOpenChange,
  market,
  outcomes,
  signal,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  market: WeatherMarket | null;
  outcomes: WeatherOutcome[];
  signal: WeatherSignal | null;
}) => {
  if (!market) return null;

  const sorted = [...outcomes].sort((a, b) => (b.edge ?? -Infinity) - (a.edge ?? -Infinity));
  const best = sorted.find((o) => (o.edge ?? -Infinity) >= 0.07) ?? null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl w-[calc(100vw-1rem)] max-h-[90vh] overflow-y-auto p-3 sm:p-6">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            {market.market_question}
            {market.polymarket_url && (
              <a href={market.polymarket_url} target="_blank" rel="noreferrer"
                 className="text-muted-foreground hover:text-foreground">
                <ExternalLink className="h-4 w-4" />
              </a>
            )}
          </DialogTitle>
        </DialogHeader>

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

        {best && (
          <div className="border border-emerald-500/30 bg-emerald-500/10 rounded p-3 flex items-center gap-3">
            <Sparkles className="h-5 w-5 text-emerald-400" />
            <div className="flex-1">
              <div className="text-xs text-muted-foreground">Best Trade Opportunity</div>
              <div className="font-medium">
                Buy YES <span className="text-emerald-400">{best.label}</span>
                {" — Edge "}
                <span className={edgeColor(best.edge)}>{pct(best.edge)}</span>
                {" — Size "}{best.suggested_size_percent ?? 0}%
              </div>
            </div>
          </div>
        )}

        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Outcome</TableHead>
              <TableHead className="text-right">Model %</TableHead>
              <TableHead className="text-right">Market %</TableHead>
              <TableHead className="text-right">Edge %</TableHead>
              <TableHead className="text-right">Size %</TableHead>
              <TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sorted.map((o) => {
              const isBest = best?.id === o.id;
              return (
                <TableRow key={o.id} className={cn(isBest && "bg-emerald-500/5")}>
                  <TableCell className="font-medium">{o.label}</TableCell>
                  <TableCell className="text-right">{pct(o.p_model)}</TableCell>
                  <TableCell className="text-right">{pct(o.polymarket_price)}</TableCell>
                  <TableCell className={cn("text-right font-medium", edgeColor(o.edge))}>
                    {pct(o.edge)}
                  </TableCell>
                  <TableCell className="text-right">
                    {o.suggested_size_percent ? `${o.suggested_size_percent}%` : "—"}
                  </TableCell>
                  <TableCell>
                    {o.clob_token_id && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => navigator.clipboard.writeText(o.clob_token_id!)}
                      >
                        Copy token
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
            {sorted.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="text-center text-muted-foreground py-8">
                  No outcomes yet. Refresh to compute probabilities.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>

        <div className="border-t border-border pt-3 text-sm text-muted-foreground">
          <div className="font-medium text-foreground mb-1">Manual execution</div>
          Place limit orders below ask. Scale into position in 2–3 parts. Re-check
          forecast within 6h of event time.
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
