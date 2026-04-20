import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Loader2, RefreshCw, TrendingUp, TrendingDown, Minus, Info } from "lucide-react";
import { toast } from "sonner";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

type ClvRow = {
  id: string;
  clv_cents: number;
  entry_price: number;
  closing_price: number;
  side: string;
  scored_at: string;
};

/**
 * CLV (closing-line value) is the only honest measure of edge in betting markets.
 * Positive avg = your fills consistently beat where the market closed = real skill.
 * Near-zero or negative = noise / luck, even if individual trades won.
 */
export const ClvPanel = () => {
  const [rows, setRows] = useState<ClvRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [scoring, setScoring] = useState(false);

  const load = useCallback(async () => {
    const { data } = await supabase
      .from("clv_scores")
      .select("id, clv_cents, entry_price, closing_price, side, scored_at")
      .order("scored_at", { ascending: false })
      .limit(200);
    setRows((data ?? []) as ClvRow[]);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const score = async () => {
    setScoring(true);
    try {
      const { data, error } = await supabase.functions.invoke("weather-clv-backfill");
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      const n = Number(data?.scored ?? 0);
      const skipped = Number(data?.skipped ?? 0);
      if (n === 0 && skipped === 0) {
        toast.message("No new resolved trades to score");
      } else {
        toast.success(`Scored ${n} trade${n === 1 ? "" : "s"}${skipped ? ` (${skipped} skipped)` : ""}`);
      }
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Scoring failed");
    } finally {
      setScoring(false);
    }
  };

  if (loading) return null;

  const last30 = rows.slice(0, 30);
  const n = last30.length;
  const avg = n > 0 ? last30.reduce((s, r) => s + Number(r.clv_cents), 0) / n : 0;
  const beat = last30.filter((r) => Number(r.clv_cents) > 0).length;
  const tone = avg > 0.5 ? "good" : avg < -0.5 ? "bad" : "flat";
  const Icon = tone === "good" ? TrendingUp : tone === "bad" ? TrendingDown : Minus;
  const toneClass =
    tone === "good"
      ? "text-emerald-400 border-emerald-500/30 bg-emerald-500/10"
      : tone === "bad"
      ? "text-red-400 border-red-500/30 bg-red-500/10"
      : "text-muted-foreground border-border bg-surface-2/40";

  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2 flex items-center justify-between gap-3 text-xs">
      <div className="flex items-center gap-2 min-w-0 flex-wrap">
        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded border text-[10px] uppercase tracking-wider ${toneClass}`}>
          <Icon className="h-3 w-3" />
          CLV
        </span>
        {n === 0 ? (
          <span className="text-muted-foreground">
            No scored trades yet. After your weather trades resolve, click <span className="text-foreground font-medium">Score CLV</span> to measure edge vs the closing line.
          </span>
        ) : (
          <>
            <span className="text-muted-foreground">Last {n}:</span>
            <span className={`font-mono-num font-semibold ${tone === "good" ? "text-emerald-400" : tone === "bad" ? "text-red-400" : "text-foreground"}`}>
              avg {avg >= 0 ? "+" : ""}{avg.toFixed(2)}¢
            </span>
            <span className="text-muted-foreground">·</span>
            <span className="font-mono-num text-foreground">{beat}/{n}</span>
            <span className="text-muted-foreground">beat close</span>
            <TooltipProvider delayDuration={150}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button className="text-muted-foreground hover:text-foreground"><Info className="h-3 w-3" /></button>
                </TooltipTrigger>
                <TooltipContent className="max-w-[260px] text-xs leading-relaxed">
                  CLV = (closing price − your entry) × side, in cents.
                  Positive avg means your fills consistently beat where the market settled — the only honest measure of skill in betting markets.
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </>
        )}
      </div>
      <Button size="sm" variant="outline" onClick={score} disabled={scoring} className="shrink-0 h-7 text-xs">
        {scoring ? <Loader2 className="h-3 w-3 animate-spin sm:mr-1" /> : <RefreshCw className="h-3 w-3 sm:mr-1" />}
        <span className="hidden sm:inline">Score CLV</span>
      </Button>
    </div>
  );
};
