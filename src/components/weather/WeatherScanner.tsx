import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Loader2, RefreshCw, Search, Sparkles, AlertCircle } from "lucide-react";
import { toast } from "sonner";
import {
  type WeatherMarket, type WeatherOutcome, type WeatherSignal,
  pct, edgeColor,
} from "@/lib/weather";
import { cn } from "@/lib/utils";
import { ConfidenceExplainer } from "./ConfidenceExplainer";

const PAGE_SIZE = 15;
const AUTO_REFRESH_MS = 90_000;

type Row = {
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
  onReload: () => void | Promise<void>;
  onSelect?: (m: WeatherMarket) => void;
};

export const WeatherScanner = ({ markets, outcomes, signals, bankroll, minVolume = 0, mismatchOnly = false, onReload, onSelect }: Props) => {
  const [scanning, setScanning] = useState(false);
  const [refreshingAll, setRefreshingAll] = useState(false);
  const [autoOn, setAutoOn] = useState(false);
  const [pageCount, setPageCount] = useState(1);
  const [lastScanAt, setLastScanAt] = useState<Date | null>(null);

  // Build ranked rows: every outcome with edge >= 7%, then apply volume + mismatch filters,
  // sort by mismatch first, then edge desc.
  const ranked: Row[] = useMemo(() => {
    const rows: Row[] = [];
    for (const m of markets) {
      const vol = Number(m.event_volume_24h ?? 0);
      if (vol < minVolume) continue;
      const sig = signals[m.id] ?? null;
      if (mismatchOnly && !sig?.favorite_mismatch) continue;
      const outs = outcomes[m.id] ?? [];
      for (const o of outs) {
        if ((o.edge ?? -Infinity) >= 0.07) {
          rows.push({ outcome: o, market: m, signal: sig });
        }
      }
    }
    rows.sort((a, b) => {
      const ma = a.signal?.favorite_mismatch ? 1 : 0;
      const mb = b.signal?.favorite_mismatch ? 1 : 0;
      if (ma !== mb) return mb - ma;
      return (b.outcome.edge ?? -Infinity) - (a.outcome.edge ?? -Infinity);
    });
    return rows;
  }, [markets, outcomes, signals, minVolume, mismatchOnly]);

  const visible = ranked.slice(0, pageCount * PAGE_SIZE);

  const runScan = async () => {
    setScanning(true);
    try {
      const { data, error } = await supabase.functions.invoke("weather-scan");
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      toast.success(
        `Scanned: ${data?.events_discovered ?? 0} events → ${data?.markets_upserted ?? 0} markets, ${data?.outcomes_upserted ?? 0} outcomes`,
      );
      setLastScanAt(new Date());
      await onReload();
      // Auto-refresh forecasts for all newly active markets
      await refreshAllInternal(true);
    } catch (e: any) {
      toast.error(e.message ?? "Scan failed");
    } finally {
      setScanning(false);
    }
  };

  const refreshAllInternal = async (silent = false) => {
    setRefreshingAll(true);
    const { data: ms } = await supabase
      .from("weather_markets").select("id").eq("active", true);
    const ids = (ms ?? []).map((m: any) => m.id as string);
    for (const id of ids) {
      try {
        await supabase.functions.invoke("weather-refresh-market", { body: { market_id: id } });
      } catch { /* skip */ }
    }
    setRefreshingAll(false);
    if (!silent) toast.success("All forecasts refreshed");
    await onReload();
  };

  // Auto-refresh loop
  useEffect(() => {
    if (!autoOn) return;
    const id = setInterval(() => { runScan(); }, AUTO_REFRESH_MS);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoOn]);

  return (
    <div className="space-y-3">
      {/* Control bar */}
      <div className="rounded-lg border border-border bg-card p-3 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <Search className="h-4 w-4 text-primary shrink-0" />
          <div className="min-w-0">
            <div className="text-sm font-semibold">Polymarket Weather Scanner</div>
            <div className="text-[11px] text-muted-foreground">
              {ranked.length} actionable now · auto-discovers all active markets
            </div>
          </div>
        </div>
        <div className="w-full sm:w-auto sm:ml-auto flex items-center gap-2 sm:gap-3 flex-wrap">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="hidden sm:inline">Auto 90s</span>
            <span className="sm:hidden">Auto</span>
            <Switch checked={autoOn} onCheckedChange={setAutoOn} />
          </div>
          <Button
            size="sm" variant="outline"
            onClick={() => refreshAllInternal(false)}
            disabled={refreshingAll || markets.length === 0}
          >
            {refreshingAll
              ? <Loader2 className="h-3 w-3 animate-spin sm:mr-1" />
              : <RefreshCw className="h-3 w-3 sm:mr-1" />}
            <span className="hidden sm:inline">Refresh forecasts</span>
            <span className="sm:hidden">Refresh</span>
          </Button>
          <Button size="sm" onClick={runScan} disabled={scanning}>
            {scanning
              ? <Loader2 className="h-3 w-3 animate-spin sm:mr-1" />
              : <Search className="h-3 w-3 sm:mr-1" />}
            Scan
          </Button>
        </div>
        {lastScanAt && (
          <div className="w-full text-[10px] text-muted-foreground">
            Last scan: {lastScanAt.toLocaleTimeString()}
          </div>
        )}
      </div>

      {/* Top edges */}
      <div className="rounded-lg border border-border bg-card overflow-hidden">
        <div className="px-4 py-2.5 flex items-center gap-2 border-b border-border bg-surface-2/40">
          <Sparkles className="h-3.5 w-3.5 text-emerald-400" />
          <div className="text-xs font-semibold uppercase tracking-wider">
            Top Weather Edges
          </div>
          <div className="ml-auto text-[10px] text-muted-foreground">
            Showing {visible.length} of {ranked.length}
          </div>
        </div>

        {ranked.length === 0 ? (
          <div className="px-4 py-10 flex items-center justify-center gap-3 text-sm text-muted-foreground">
            <AlertCircle className="h-4 w-4" />
            <div>
              No edges ≥ 7% right now.{" "}
              <button onClick={runScan} className="underline text-foreground">
                Run a scan
              </button>{" "}
              to discover markets.
            </div>
          </div>
        ) : (
          <>
            {/* Mobile: stacked cards */}
            <div className="sm:hidden divide-y divide-border">
              {visible.map((r, i) => {
                const conf = r.signal?.confidence_level ?? null;
                const verify =
                  (r.outcome.p_model ?? 0) > 0.8 &&
                  (r.outcome.polymarket_price ?? 1) < 0.3;
                const sz = Number(r.outcome.suggested_size_percent ?? 0);
                const tradeVal = (bankroll * sz) / 100;
                return (
                  <div
                    key={r.outcome.id}
                    onClick={() => onSelect?.(r.market)}
                    className="p-3 active:bg-surface-2/50 cursor-pointer"
                  >
                    <div className="flex items-start justify-between gap-2 mb-2">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] font-mono-num text-muted-foreground">#{i + 1}</span>
                          <span className="font-medium text-sm truncate">{r.market.city}</span>
                          <span className="text-[10px] text-muted-foreground shrink-0">
                            {new Date(r.market.event_time).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                          </span>
                        </div>
                        <div className="text-xs font-medium mt-0.5 truncate" title={r.outcome.label}>
                          {r.outcome.label}
                        </div>
                      </div>
                      <div onClick={(e) => e.stopPropagation()} className="shrink-0">
                        {verify ? (
                          <span className="px-1.5 py-0.5 rounded border text-[9px] uppercase tracking-wider bg-amber-500/15 text-amber-400 border-amber-500/30">
                            Verify
                          </span>
                        ) : conf ? (
                          <ConfidenceExplainer
                            confidence={conf}
                            signal={r.signal}
                            outcome={r.outcome}
                            market={r.market}
                          />
                        ) : null}
                      </div>
                    </div>
                    <div className="grid grid-cols-4 gap-2 text-center">
                      <div>
                        <div className="text-[9px] uppercase text-muted-foreground tracking-wider">Edge</div>
                        <div className={cn("text-sm font-mono-num font-semibold", edgeColor(r.outcome.edge))}>
                          {pct(r.outcome.edge, 0)}
                        </div>
                      </div>
                      <div>
                        <div className="text-[9px] uppercase text-muted-foreground tracking-wider">Model</div>
                        <div className="text-sm font-mono-num">{pct(r.outcome.p_model, 0)}</div>
                      </div>
                      <div>
                        <div className="text-[9px] uppercase text-muted-foreground tracking-wider">Market</div>
                        <div className="text-sm font-mono-num text-muted-foreground">{pct(r.outcome.polymarket_price, 0)}</div>
                      </div>
                      <div>
                        <div className="text-[9px] uppercase text-muted-foreground tracking-wider">Trade</div>
                        <div className="text-sm font-mono-num font-semibold">
                          {tradeVal > 0 ? `$${tradeVal.toFixed(0)}` : `${sz}%`}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Desktop: table */}
            <div className="hidden sm:block overflow-x-auto">
              <table className="w-full text-sm min-w-[800px]">
                <thead className="text-[10px] uppercase tracking-wider text-muted-foreground border-b border-border">
                  <tr>
                    <th className="text-left px-4 py-2 font-medium">#</th>
                    <th className="text-left px-3 py-2 font-medium">City · Date</th>
                    <th className="text-left px-3 py-2 font-medium">Outcome</th>
                    <th className="text-right px-3 py-2 font-medium">Model</th>
                    <th className="text-right px-3 py-2 font-medium">Market</th>
                    <th className="text-right px-3 py-2 font-medium">Edge</th>
                    <th className="text-right px-3 py-2 font-medium">Size</th>
                    <th className="text-right px-3 py-2 font-medium">Trade $</th>
                    <th className="text-center px-3 py-2 font-medium">Conf.</th>
                    <th className="text-right px-4 py-2 font-medium" />
                  </tr>
                </thead>
                <tbody>
                  {visible.map((r, i) => {
                    const conf = r.signal?.confidence_level ?? null;
                    const verify =
                      (r.outcome.p_model ?? 0) > 0.8 &&
                      (r.outcome.polymarket_price ?? 1) < 0.3;
                    return (
                      <tr
                        key={r.outcome.id}
                        onClick={() => onSelect?.(r.market)}
                        className="border-b border-border/50 hover:bg-surface-2/50 cursor-pointer"
                      >
                        <td className="px-4 py-2.5 text-muted-foreground font-mono-num">{i + 1}</td>
                        <td className="px-3 py-2.5">
                          <div className="font-medium">{r.market.city}</div>
                          <div className="text-[10px] text-muted-foreground">
                            {new Date(r.market.event_time).toLocaleDateString(undefined, {
                              month: "short", day: "numeric",
                            })}
                          </div>
                        </td>
                        <td className="px-3 py-2.5 max-w-[260px]">
                          <div className="truncate font-medium" title={r.outcome.label}>
                            {r.outcome.label}
                          </div>
                          <div className="truncate text-[10px] text-muted-foreground" title={r.market.market_question}>
                            {r.market.market_question}
                          </div>
                        </td>
                        <td className="px-3 py-2.5 text-right font-mono-num">{pct(r.outcome.p_model, 0)}</td>
                        <td className="px-3 py-2.5 text-right font-mono-num text-muted-foreground">
                          {pct(r.outcome.polymarket_price, 0)}
                        </td>
                        <td className={cn("px-3 py-2.5 text-right font-mono-num font-semibold", edgeColor(r.outcome.edge))}>
                          {pct(r.outcome.edge, 0)}
                        </td>
                        <td className="px-3 py-2.5 text-right font-mono-num">
                          {r.outcome.suggested_size_percent ?? 0}%
                        </td>
                        <td className="px-3 py-2.5 text-right font-mono-num font-semibold text-foreground">
                          {(() => {
                            const sz = Number(r.outcome.suggested_size_percent ?? 0);
                            const v = (bankroll * sz) / 100;
                            return v > 0 ? `$${v.toFixed(2)}` : "—";
                          })()}
                        </td>
                        <td className="px-3 py-2.5 text-center" onClick={(e) => e.stopPropagation()}>
                          {verify ? (
                            <span className="px-2 py-0.5 rounded border text-[10px] uppercase tracking-wider bg-amber-500/15 text-amber-400 border-amber-500/30">
                              Verify
                            </span>
                          ) : conf ? (
                            <ConfidenceExplainer
                              confidence={conf}
                              signal={r.signal}
                              outcome={r.outcome}
                              market={r.market}
                            />
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                        <td className="px-4 py-2.5 text-right">
                          <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); onSelect?.(r.market); }}>
                            View
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {visible.length < ranked.length && (
              <div className="px-4 py-3 border-t border-border bg-surface-2/30 flex justify-center">
                <Button size="sm" variant="outline" onClick={() => setPageCount((p) => p + 1)}>
                  Show more ({ranked.length - visible.length} remaining)
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
};
