import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Loader2, RefreshCw, ChevronDown, ChevronUp, Info } from "lucide-react";
import { toast } from "sonner";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

type BiasRow = {
  station_code: string;
  model_name: string;
  forecast_temp_c: number;
  actual_temp_c: number;
  error_c: number;
  valid_at: string;
};

type Snap = { resolved: boolean };

type Agg = {
  station_code: string;
  model_name: string;
  n: number;
  meanErr: number;
  absMeanErr: number;
  std: number;
};

const MODEL_LABEL: Record<string, string> = {
  ecmwf_ifs025: "ECMWF IFS",
  ecmwf_aifs025: "ECMWF AIFS",
  graphcast: "GraphCast",
  gfs_seamless: "GFS",
  nws: "NWS",
  nbm: "NBM",
};

/**
 * Per-station, per-model forecast bias.
 * Mean error >0 = model runs HOT for that station (predicted higher than actual).
 * The refresh function subtracts mean error before bucketing, so this is YOUR
 * proprietary edge once 30+ samples accumulate per cell.
 */
export const BiasPanel = () => {
  const [bias, setBias] = useState<BiasRow[]>([]);
  const [snaps, setSnaps] = useState<Snap[]>([]);
  const [loading, setLoading] = useState(true);
  const [resolving, setResolving] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const load = useCallback(async () => {
    const [{ data: b }, { data: s }] = await Promise.all([
      supabase
        .from("forecast_bias")
        .select("station_code, model_name, forecast_temp_c, actual_temp_c, error_c, valid_at")
        .order("valid_at", { ascending: false })
        .limit(2000),
      supabase
        .from("forecast_snapshots")
        .select("resolved")
        .returns<Snap[]>(),
    ]);
    setBias((b ?? []) as BiasRow[]);
    setSnaps((s ?? []) as Snap[]);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const runResolve = async () => {
    setResolving(true);
    try {
      const { data, error } = await supabase.functions.invoke("weather-resolve-bias");
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      const r = Number(data?.resolved ?? 0);
      const sk = Number(data?.skipped ?? 0);
      if (r === 0 && sk === 0) toast.message("No resolved markets to score");
      else toast.success(`Resolved ${r} snapshot${r === 1 ? "" : "s"}${sk ? ` (${sk} skipped)` : ""}`);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Resolve failed");
    } finally {
      setResolving(false);
    }
  };

  if (loading) return null;

  const totalSnaps = snaps.length;
  const pendingSnaps = snaps.filter((s) => !s.resolved).length;

  // Aggregate (station, model) → stats
  const grouped = new Map<string, BiasRow[]>();
  for (const r of bias) {
    const k = `${r.station_code}|${r.model_name}`;
    const arr = grouped.get(k) ?? [];
    arr.push(r);
    grouped.set(k, arr);
  }
  const aggs: Agg[] = Array.from(grouped.entries()).map(([k, rows]) => {
    const [station_code, model_name] = k.split("|");
    const n = rows.length;
    const meanErr = rows.reduce((s, r) => s + Number(r.error_c), 0) / n;
    const absMeanErr = rows.reduce((s, r) => s + Math.abs(Number(r.error_c)), 0) / n;
    const variance = rows.reduce((s, r) => s + (Number(r.error_c) - meanErr) ** 2, 0) / n;
    return { station_code, model_name, n, meanErr, absMeanErr, std: Math.sqrt(variance) };
  });
  aggs.sort((a, b) => b.n - a.n || Math.abs(b.meanErr) - Math.abs(a.meanErr));

  // Big-picture stat: any (station,model) with n >= 10 is starting to be useful
  const usefulCells = aggs.filter((a) => a.n >= 10).length;
  const strongCells = aggs.filter((a) => a.n >= 30).length;

  const fmt = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}°C`;
  const cellTone = (mean: number, n: number) => {
    if (n < 10) return "text-muted-foreground";
    if (Math.abs(mean) < 0.3) return "text-foreground";
    if (Math.abs(mean) < 0.8) return "text-amber-400";
    return Math.sign(mean) > 0 ? "text-red-400" : "text-emerald-400";
  };

  return (
    <div className="rounded-lg border border-border bg-card overflow-hidden">
      <div className="px-3 py-2 flex items-center justify-between gap-3 text-xs">
        <div className="flex items-center gap-2 min-w-0 flex-wrap">
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded border border-border bg-surface-2/40 text-[10px] uppercase tracking-wider text-muted-foreground">
            Bias
          </span>
          {bias.length === 0 ? (
            <span className="text-muted-foreground">
              No bias data yet. {totalSnaps > 0 ? (
                <>{pendingSnaps}/{totalSnaps} snapshots pending.{" "}</>
              ) : (
                <>Snapshots are captured each refresh.{" "}</>
              )}
              Click <span className="text-foreground font-medium">Resolve</span> after markets pass their event time.
            </span>
          ) : (
            <>
              <span className="text-muted-foreground">{bias.length} samples ·</span>
              <span className="font-mono-num text-foreground">{usefulCells}</span>
              <span className="text-muted-foreground">cells with n≥10 ·</span>
              <span className="font-mono-num text-foreground">{strongCells}</span>
              <span className="text-muted-foreground">with n≥30</span>
              {pendingSnaps > 0 && (
                <>
                  <span className="text-muted-foreground">·</span>
                  <span className="text-amber-400">{pendingSnaps} pending</span>
                </>
              )}
            </>
          )}
          <TooltipProvider delayDuration={150}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button className="text-muted-foreground hover:text-foreground"><Info className="h-3 w-3" /></button>
              </TooltipTrigger>
              <TooltipContent className="max-w-[300px] text-xs leading-relaxed">
                Per-station, per-model bias. Mean error &gt;0 means the model runs HOT for that station. The refresh function subtracts mean error from forecasts before bucketing, so n≥30 cells become real edge.
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <Button size="sm" variant="outline" onClick={runResolve} disabled={resolving} className="h-7 text-xs">
            {resolving ? <Loader2 className="h-3 w-3 animate-spin sm:mr-1" /> : <RefreshCw className="h-3 w-3 sm:mr-1" />}
            <span className="hidden sm:inline">Resolve</span>
          </Button>
          {aggs.length > 0 && (
            <Button size="sm" variant="ghost" onClick={() => setExpanded((v) => !v)} className="h-7 px-2 text-xs">
              {expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
            </Button>
          )}
        </div>
      </div>

      {expanded && aggs.length > 0 && (
        <div className="border-t border-border px-3 py-3 bg-surface-2/30">
          <div className="rounded border border-border/60 overflow-hidden">
            <table className="w-full text-xs">
              <thead className="bg-surface-2/50 text-[10px] uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="text-left px-2 py-1.5 font-medium">Station</th>
                  <th className="text-left px-2 py-1.5 font-medium">Model</th>
                  <th className="text-right px-2 py-1.5 font-medium">N</th>
                  <th className="text-right px-2 py-1.5 font-medium">Mean err</th>
                  <th className="text-right px-2 py-1.5 font-medium">|Avg|</th>
                  <th className="text-right px-2 py-1.5 font-medium">Std</th>
                </tr>
              </thead>
              <tbody>
                {aggs.slice(0, 50).map((a) => (
                  <tr key={`${a.station_code}|${a.model_name}`} className="border-t border-border/40">
                    <td className="px-2 py-1.5 font-mono-num">{a.station_code}</td>
                    <td className="px-2 py-1.5 text-muted-foreground">{MODEL_LABEL[a.model_name] ?? a.model_name}</td>
                    <td className="px-2 py-1.5 text-right font-mono-num text-muted-foreground">{a.n}</td>
                    <td className={cn("px-2 py-1.5 text-right font-mono-num font-semibold", cellTone(a.meanErr, a.n))}>
                      {fmt(a.meanErr)}
                    </td>
                    <td className="px-2 py-1.5 text-right font-mono-num text-muted-foreground">
                      {a.absMeanErr.toFixed(2)}°C
                    </td>
                    <td className="px-2 py-1.5 text-right font-mono-num text-muted-foreground">
                      {a.std.toFixed(2)}°C
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-2 text-[10px] text-muted-foreground leading-relaxed">
            Read: green/red mean values are statistically meaningful (n≥10). The refresh function already applies these corrections — once a cell has n≥30, the correction starts being trustworthy edge.
          </div>
        </div>
      )}
    </div>
  );
};
