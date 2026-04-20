import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Loader2, RefreshCw, TrendingUp, TrendingDown, Minus, Info, ChevronDown, ChevronUp } from "lucide-react";
import { toast } from "sonner";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

type ClvRow = {
  id: string;
  clv_cents: number | null;
  entry_price: number;
  closing_price: number | null;
  side: string;
  scored_at: string;
  detected_trade_id: string | null;
  kind: string | null;
  edge_at_entry: number | null;
};

/**
 * CLV (closing-line value) is the only honest measure of edge in betting markets.
 * Now also tracks PAPER entries auto-logged each refresh, broken out by:
 *   - kind = qualified (>=7% edge) vs sub_threshold (positive but <7%)
 *   - edge bucket (0-3%, 3-5%, 5-7%, >=7%)
 * If sub-threshold rows show ~0 avg CLV over 50+ samples, the 7% floor is empirically right.
 * If they show meaningfully positive CLV, the floor is too high.
 */
export const ClvPanel = () => {
  const [rows, setRows] = useState<ClvRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [scoring, setScoring] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const load = useCallback(async () => {
    const { data } = await supabase
      .from("clv_scores")
      .select("id, clv_cents, entry_price, closing_price, side, scored_at, detected_trade_id, kind, edge_at_entry")
      .order("scored_at", { ascending: false })
      .limit(1000);
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
      const p = Number(data?.paper_scored ?? 0);
      const skipped = Number(data?.skipped ?? 0);
      if (n === 0 && p === 0 && skipped === 0) toast.message("No new resolved markets to score");
      else toast.success(`Scored ${n} real + ${p} paper${skipped ? ` (${skipped} skipped)` : ""}`);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Scoring failed");
    } finally {
      setScoring(false);
    }
  };

  if (loading) return null;

  // Real (live) trades — only those with a detected_trade_id and a closing price
  const real = rows.filter((r) => r.detected_trade_id && r.clv_cents != null);
  // Paper, scored
  const paper = rows.filter((r) => !r.detected_trade_id && r.clv_cents != null);
  const paperPending = rows.filter((r) => !r.detected_trade_id && r.clv_cents == null);

  const stat = (arr: ClvRow[]) => {
    const n = arr.length;
    if (!n) return { n: 0, avg: 0, beat: 0 };
    const avg = arr.reduce((s, r) => s + Number(r.clv_cents ?? 0), 0) / n;
    const beat = arr.filter((r) => Number(r.clv_cents ?? 0) > 0).length;
    return { n, avg, beat };
  };

  const realStats = stat(real.slice(0, 30));
  const paperQualified = paper.filter((r) => r.kind === "qualified");
  const paperSub = paper.filter((r) => r.kind === "sub_threshold");

  // Edge buckets across paper rows
  const buckets = [
    { label: "0–3%", min: 0, max: 0.03 },
    { label: "3–5%", min: 0.03, max: 0.05 },
    { label: "5–7%", min: 0.05, max: 0.07 },
    { label: "≥7%", min: 0.07, max: Infinity },
  ];
  const bucketStats = buckets.map((b) => {
    const items = paper.filter((r) => {
      const e = Number(r.edge_at_entry ?? -1);
      return e >= b.min && e < b.max;
    });
    return { ...b, ...stat(items) };
  });

  const tone = realStats.avg > 0.5 ? "good" : realStats.avg < -0.5 ? "bad" : "flat";
  const Icon = tone === "good" ? TrendingUp : tone === "bad" ? TrendingDown : Minus;
  const toneClass =
    tone === "good"
      ? "text-emerald-400 border-emerald-500/30 bg-emerald-500/10"
      : tone === "bad"
      ? "text-red-400 border-red-500/30 bg-red-500/10"
      : "text-muted-foreground border-border bg-surface-2/40";

  const fmtCents = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}¢`;
  const cellTone = (v: number, n: number) => {
    if (n < 5) return "text-muted-foreground";
    if (v > 0.5) return "text-emerald-400";
    if (v < -0.5) return "text-red-400";
    return "text-foreground";
  };

  return (
    <div className="rounded-lg border border-border bg-card overflow-hidden">
      {/* Header / one-line summary */}
      <div className="px-3 py-2 flex items-center justify-between gap-3 text-xs">
        <div className="flex items-center gap-2 min-w-0 flex-wrap">
          <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded border text-[10px] uppercase tracking-wider ${toneClass}`}>
            <Icon className="h-3 w-3" />
            CLV
          </span>
          {realStats.n === 0 ? (
            <span className="text-muted-foreground">
              No live trades scored yet. Paper auto-log: <span className="text-foreground font-medium">{paper.length} scored</span>, <span className="text-foreground font-medium">{paperPending.length} pending</span>.
            </span>
          ) : (
            <>
              <span className="text-muted-foreground">Live last {realStats.n}:</span>
              <span className={`font-mono-num font-semibold ${tone === "good" ? "text-emerald-400" : tone === "bad" ? "text-red-400" : "text-foreground"}`}>
                avg {fmtCents(realStats.avg)}
              </span>
              <span className="text-muted-foreground">·</span>
              <span className="font-mono-num text-foreground">{realStats.beat}/{realStats.n}</span>
              <span className="text-muted-foreground">beat close</span>
            </>
          )}
          <TooltipProvider delayDuration={150}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button className="text-muted-foreground hover:text-foreground"><Info className="h-3 w-3" /></button>
              </TooltipTrigger>
              <TooltipContent className="max-w-[300px] text-xs leading-relaxed">
                CLV = (close − entry) × side, in cents. Paper rows are auto-logged each refresh (1/outcome/day) to test whether sub-threshold edges are real signal or noise.
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <Button size="sm" variant="outline" onClick={score} disabled={scoring} className="h-7 text-xs">
            {scoring ? <Loader2 className="h-3 w-3 animate-spin sm:mr-1" /> : <RefreshCw className="h-3 w-3 sm:mr-1" />}
            <span className="hidden sm:inline">Score</span>
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setExpanded((v) => !v)} className="h-7 px-2 text-xs">
            {expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
          </Button>
        </div>
      </div>

      {/* Calibration breakdown */}
      {expanded && (
        <div className="border-t border-border px-3 py-3 space-y-3 bg-surface-2/30">
          {/* Qualified vs sub-threshold */}
          <div>
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5">Paper CLV by kind</div>
            <div className="grid grid-cols-2 gap-2">
              <CalibCard
                title="Qualified (≥7%)"
                stats={stat(paperQualified)}
                hint="Should be clearly positive if model has real edge"
              />
              <CalibCard
                title="Sub-threshold (>0, <7%)"
                stats={stat(paperSub)}
                hint="Near zero = floor is right. Positive = lower the floor"
              />
            </div>
          </div>

          {/* Edge buckets */}
          <div>
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5">Paper CLV by edge band</div>
            <div className="rounded border border-border/60 overflow-hidden">
              <table className="w-full text-xs">
                <thead className="bg-surface-2/50 text-[10px] uppercase tracking-wider text-muted-foreground">
                  <tr>
                    <th className="text-left px-2 py-1.5 font-medium">Edge band</th>
                    <th className="text-right px-2 py-1.5 font-medium">N</th>
                    <th className="text-right px-2 py-1.5 font-medium">Avg CLV</th>
                    <th className="text-right px-2 py-1.5 font-medium">Beat close</th>
                  </tr>
                </thead>
                <tbody>
                  {bucketStats.map((b) => (
                    <tr key={b.label} className="border-t border-border/40">
                      <td className="px-2 py-1.5">{b.label}</td>
                      <td className="px-2 py-1.5 text-right font-mono-num text-muted-foreground">{b.n}</td>
                      <td className={cn("px-2 py-1.5 text-right font-mono-num font-semibold", cellTone(b.avg, b.n))}>
                        {b.n > 0 ? fmtCents(b.avg) : "—"}
                      </td>
                      <td className="px-2 py-1.5 text-right font-mono-num text-muted-foreground">
                        {b.n > 0 ? `${b.beat}/${b.n}` : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mt-1.5 text-[10px] text-muted-foreground leading-relaxed">
              {paper.length < 30
                ? `${paper.length}/30 paper samples. Need 30+ for any band to be meaningful, 100+ to draw conclusions.`
                : `Read: if 3–5% and 5–7% bands are flat (≈0¢) and ≥7% is clearly positive, your floor is well-calibrated.`}
            </div>
          </div>
          {paperPending.length > 0 && (
            <div className="text-[10px] text-muted-foreground">
              {paperPending.length} paper {paperPending.length === 1 ? "row" : "rows"} pending (event hasn't passed yet, or no closing price available).
            </div>
          )}
        </div>
      )}
    </div>
  );
};

const CalibCard = ({ title, stats, hint }: { title: string; stats: { n: number; avg: number; beat: number }; hint: string }) => {
  const tone = stats.n < 10 ? "muted" : stats.avg > 0.5 ? "good" : stats.avg < -0.5 ? "bad" : "flat";
  const cls = tone === "good"
    ? "text-emerald-400"
    : tone === "bad"
    ? "text-red-400"
    : tone === "muted"
    ? "text-muted-foreground"
    : "text-foreground";
  return (
    <div className="rounded border border-border/60 bg-background/40 px-2.5 py-2">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{title}</div>
      <div className="flex items-baseline gap-2 mt-0.5">
        <span className={cn("text-lg font-mono-num font-semibold", cls)}>
          {stats.n > 0 ? `${stats.avg >= 0 ? "+" : ""}${stats.avg.toFixed(2)}¢` : "—"}
        </span>
        <span className="text-[10px] text-muted-foreground font-mono-num">
          n={stats.n}{stats.n > 0 && ` · ${stats.beat}/${stats.n}`}
        </span>
      </div>
      <div className="text-[10px] text-muted-foreground mt-1 leading-snug">{hint}</div>
    </div>
  );
};
