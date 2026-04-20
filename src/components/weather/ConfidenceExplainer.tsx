import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { confidenceColor, type WeatherSignal, type WeatherOutcome, type WeatherMarket, pct } from "@/lib/weather";
import { Info } from "lucide-react";

type Props = {
  confidence: "high" | "medium" | "low" | null | string;
  signal: WeatherSignal | null;
  outcome: WeatherOutcome;
  market: WeatherMarket;
  className?: string;
};

const titleFor = (c: string) => {
  if (c === "high") return "Why this is HIGH confidence";
  if (c === "medium") return "Why this is MEDIUM confidence";
  if (c === "low") return "Why this is LOW confidence";
  return "Confidence";
};

const oneLiner = (c: string) => {
  if (c === "high") return "Both weather models basically agree. That's a strong sign the forecast is solid.";
  if (c === "medium") return "The two weather models mostly agree but not perfectly. Decent signal, but not bulletproof.";
  if (c === "low") return "The two weather models disagree a lot. The forecast is shaky — be careful.";
  return "";
};

export const ConfidenceExplainer = ({ confidence, signal, outcome, market, className }: Props) => {
  const c = (confidence ?? "").toString();
  if (!c) return null;

  const agreement = signal?.agreement;
  const agreementPct = agreement != null ? Math.round(agreement * 100) : null;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          onClick={(e) => e.stopPropagation()}
          className={cn(
            "inline-flex items-center gap-1 px-2 py-0.5 rounded border text-[10px] uppercase tracking-wider hover:opacity-80 transition-opacity cursor-pointer",
            confidenceColor(c),
            className,
          )}
        >
          {c}
          <Info className="h-2.5 w-2.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="w-80 text-sm"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="space-y-3">
          <div>
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
              {titleFor(c)}
            </div>
            <Badge variant="outline" className={cn("uppercase text-[10px]", confidenceColor(c))}>
              {c} confidence
            </Badge>
          </div>

          <p className="text-foreground leading-relaxed">{oneLiner(c)}</p>

          <div className="rounded border border-border/60 bg-background/40 p-3 space-y-2 text-xs">
            <div className="font-semibold text-foreground">In plain English:</div>
            <p className="text-muted-foreground leading-relaxed">
              We check the weather two different ways — using <span className="text-foreground">ECMWF</span> (51
              simulations of tomorrow's weather, like 51 weather forecasters voting) and{" "}
              <span className="text-foreground">GFS</span> (a separate American model). If they both point to
              the same answer, we trust it more.
            </p>
            {agreementPct != null && (
              <p className="text-muted-foreground leading-relaxed">
                Right now they agree about{" "}
                <span className="text-foreground font-semibold">{agreementPct}%</span> of the way.
                {agreementPct >= 80 && " That's a strong match."}
                {agreementPct >= 50 && agreementPct < 80 && " That's a partial match."}
                {agreementPct < 50 && " That's a weak match — the models disagree."}
              </p>
            )}
          </div>

          <div className="rounded border border-border/60 bg-background/40 p-3 space-y-1 text-xs">
            <div className="font-semibold text-foreground mb-1">What this trade is saying:</div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Weather model thinks:</span>
              <span className="font-mono-num text-foreground">{pct(outcome.p_model, 0)} chance</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Polymarket is pricing:</span>
              <span className="font-mono-num text-foreground">{pct(outcome.polymarket_price, 0)} chance</span>
            </div>
            <div className="flex justify-between border-t border-border/40 pt-1 mt-1">
              <span className="text-muted-foreground">Gap (your edge):</span>
              <span className="font-mono-num font-semibold text-emerald-400">{pct(outcome.edge, 0)}</span>
            </div>
          </div>

          {c === "high" && (
            <p className="text-[11px] text-emerald-400/90 leading-relaxed">
              ✓ Strong forecast agreement + real edge = the cleanest setup you can get. Still size sensibly.
            </p>
          )}
          {c === "medium" && (
            <p className="text-[11px] text-amber-400/90 leading-relaxed">
              ⚠ Some disagreement between models. Treat the suggested size as a ceiling.
            </p>
          )}
          {c === "low" && (
            <p className="text-[11px] text-red-400/90 leading-relaxed">
              ✗ Models disagree. Either skip or take a tiny position only.
            </p>
          )}

          <p className="text-[10px] text-muted-foreground italic">
            For {market.city} · {new Date(market.event_time).toLocaleDateString()}
          </p>
        </div>
      </PopoverContent>
    </Popover>
  );
};
