import { useState } from "react";
import { Bug, Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { cn } from "@/lib/utils";

type DebugRow = {
  event_title: string;
  city: string | null;
  bucketCount: number;
  buckets: Array<{ label: string; mid: number }>;
};

/** Debug-only panel: invokes weather-discover-momentum and shows how many
 *  buckets each market returned. Confirms the fix where the edge function
 *  now returns the full sub-market list (not just leader + runner). */
export const MomentumDebugPanel = ({
  gapMin = 0.10,
  maxHours = 12,
}: { gapMin?: number; maxHours?: number }) => {
  const [loading, setLoading] = useState(false);
  const [rows, setRows] = useState<DebugRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});

  const run = async () => {
    setLoading(true);
    setError(null);
    try {
      const { data, error } = await supabase.functions.invoke("weather-discover-momentum", {
        body: { gap_min: gapMin, max_hours: maxHours },
      });
      if (error) throw error;
      const results = (data?.results ?? []) as any[];
      const out: DebugRow[] = results.map((r) => {
        const buckets = Array.isArray(r.buckets) ? r.buckets : [];
        return {
          event_title: String(r.event_title ?? "Untitled"),
          city: r.city ?? null,
          bucketCount: buckets.length,
          buckets: buckets.map((b: any) => ({
            label: String(b.label ?? "?"),
            mid: Number(b.mid ?? 0),
          })),
        };
      });
      out.sort((a, b) => b.bucketCount - a.bucketCount);
      setRows(out);
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setLoading(false);
    }
  };

  const moreThanTwo = rows?.filter((r) => r.bucketCount > 2).length ?? 0;
  const total = rows?.length ?? 0;

  return (
    <div className="rounded-lg border border-border bg-card overflow-hidden">
      <div className="flex items-center justify-between gap-2 px-4 py-2.5 border-b border-border bg-surface-2/40">
        <div className="flex items-center gap-2">
          <Bug className="h-4 w-4 text-amber-400" />
          <div>
            <div className="text-xs font-semibold uppercase tracking-wider">Debug · Bucket Counts</div>
            <div className="text-[10px] text-muted-foreground">
              Calls discover with gap≥{Math.round(gapMin * 100)}% / {maxHours}h and reports how many buckets each market returned.
            </div>
          </div>
        </div>
        <button
          onClick={run}
          disabled={loading}
          className="inline-flex items-center gap-1.5 rounded border border-border bg-background hover:bg-surface-2 px-2.5 py-1 text-[11px] disabled:opacity-50"
        >
          {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Bug className="h-3 w-3" />}
          {loading ? "Running…" : "Run debug"}
        </button>
      </div>

      {error && (
        <div className="px-4 py-3 text-xs text-destructive">Error: {error}</div>
      )}

      {rows && (
        <div className="px-4 py-3 space-y-3">
          <div className="text-[11px] text-muted-foreground font-mono-num">
            {total} markets returned · {moreThanTwo} with &gt;2 buckets ·{" "}
            <span className={cn(moreThanTwo > 0 ? "text-emerald-400" : "text-destructive")}>
              {moreThanTwo > 0 ? "✓ confirmed" : "✗ still only 2"}
            </span>
          </div>
          {rows.length === 0 ? (
            <div className="text-xs text-muted-foreground">No qualifying markets.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[11px] font-mono-num">
                <thead>
                  <tr className="text-left text-muted-foreground border-b border-border">
                    <th className="py-1 pr-2">#</th>
                    <th className="py-1 pr-2">Buckets</th>
                    <th className="py-1 pr-2">City</th>
                    <th className="py-1 pr-2">Market</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <>
                      <tr
                        key={i}
                        className="border-b border-border/40 hover:bg-surface-2/40 cursor-pointer"
                        onClick={() => setExpanded((p) => ({ ...p, [i]: !p[i] }))}
                      >
                        <td className="py-1 pr-2 text-muted-foreground">{i + 1}</td>
                        <td
                          className={cn(
                            "py-1 pr-2 font-semibold",
                            r.bucketCount > 2 ? "text-emerald-400" : "text-amber-400",
                          )}
                        >
                          {r.bucketCount}
                        </td>
                        <td className="py-1 pr-2 text-muted-foreground">{r.city ?? "—"}</td>
                        <td className="py-1 pr-2 text-foreground/90 truncate max-w-[420px]">{r.event_title}</td>
                      </tr>
                      {expanded[i] && (
                        <tr key={`${i}-x`} className="bg-surface-2/30">
                          <td colSpan={4} className="py-2 px-3">
                            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-1">
                              {r.buckets.map((b, j) => (
                                <div
                                  key={j}
                                  className="flex justify-between gap-2 rounded border border-border bg-background px-2 py-0.5"
                                >
                                  <span className="truncate text-foreground/80">{b.label}</span>
                                  <span className="text-muted-foreground">
                                    {(b.mid * 100).toFixed(1)}%
                                  </span>
                                </div>
                              ))}
                            </div>
                          </td>
                        </tr>
                      )}
                    </>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
