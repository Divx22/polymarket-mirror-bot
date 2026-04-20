import { useEffect, useState, useCallback } from "react";
import { useNavigate, Link } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { LogOut, RefreshCw, Loader2, Trash2, ArrowLeft, Sparkles, Zap } from "lucide-react";
import { toast } from "sonner";
import { AddMarketDialog } from "@/components/weather/AddMarketDialog";
import { TradeDetailDialog } from "@/components/weather/TradeDetailDialog";
import { BestTradeSignal } from "@/components/weather/BestTradeSignal";
import { WeatherScanner } from "@/components/weather/WeatherScanner";
import { BankrollInput, MinVolumeInput, MaxTradeCapInput } from "@/components/weather/PositionCalculator";
import { StationOverridePicker } from "@/components/weather/StationOverridePicker";
import { ClvPanel } from "@/components/weather/ClvPanel";
import { BiasPanel } from "@/components/weather/BiasPanel";
import {
  WeatherMarket, WeatherOutcome, WeatherSignal,
  pct, edgeColor, confidenceColor, formatVolume, applyMaxTradeCap,
  isSettlementRisk, hoursToResolution,
} from "@/lib/weather";
import { cn } from "@/lib/utils";

const Weather = () => {
  const nav = useNavigate();
  const [userId, setUserId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [markets, setMarkets] = useState<WeatherMarket[]>([]);
  const [outcomes, setOutcomes] = useState<Record<string, WeatherOutcome[]>>({});
  const [signals, setSignals] = useState<Record<string, WeatherSignal>>({});
  const [refreshing, setRefreshing] = useState<string | null>(null);
  const [refreshingAll, setRefreshingAll] = useState(false);
  const [detailMarket, setDetailMarket] = useState<WeatherMarket | null>(null);
  const [bankroll, setBankroll] = useState<number>(1000);
  const [minVolume, setMinVolume] = useState<number>(25000);
  const [maxTradePct, setMaxTradePct] = useState<number>(2);
  const [mismatchOnly, setMismatchOnly] = useState(false);

  useEffect(() => {
    document.title = "Weather Edge Trader";
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => {
      if (!s) nav("/auth", { replace: true });
      else { setUserId(s.user.id); setLoading(false); }
    });
    supabase.auth.getSession().then(({ data }) => {
      if (!data.session) nav("/auth", { replace: true });
      else { setUserId(data.session.user.id); setLoading(false); }
    });
    return () => sub.subscription.unsubscribe();
  }, [nav]);

  const load = useCallback(async () => {
    if (!userId) return;
    const [{ data: ms }, { data: os }, { data: sigs }, { data: cfg }] = await Promise.all([
      supabase.from("weather_markets").select("*").eq("active", true).order("event_time"),
      supabase.from("weather_outcomes").select("*").order("display_order"),
      supabase.from("weather_signals").select("*").order("created_at", { ascending: false }),
      supabase.from("config").select("bankroll_usdc, min_volume_usd, max_trade_pct").eq("user_id", userId).maybeSingle(),
    ]);
    if (cfg?.bankroll_usdc != null) setBankroll(Number(cfg.bankroll_usdc));
    if ((cfg as any)?.min_volume_usd != null) setMinVolume(Number((cfg as any).min_volume_usd));
    if ((cfg as any)?.max_trade_pct != null) setMaxTradePct(Number((cfg as any).max_trade_pct));
    setMarkets((ms ?? []) as WeatherMarket[]);
    const grouped: Record<string, WeatherOutcome[]> = {};
    (os ?? []).forEach((o: any) => {
      (grouped[o.market_id] ??= []).push(o as WeatherOutcome);
    });
    setOutcomes(grouped);
    const latest: Record<string, WeatherSignal> = {};
    (sigs ?? []).forEach((s: any) => {
      if (!latest[s.market_id]) latest[s.market_id] = s as WeatherSignal;
    });
    setSignals(latest);
  }, [userId]);

  useEffect(() => { load(); }, [load]);

  const refresh = async (id: string) => {
    setRefreshing(id);
    try {
      const { data, error } = await supabase.functions.invoke("weather-refresh-market", {
        body: { market_id: id },
      });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      toast.success("Forecast refreshed");
      await load();
    } catch (e: any) {
      toast.error(e.message ?? "Refresh failed");
    } finally {
      setRefreshing(null);
    }
  };

  const refreshAll = async () => {
    setRefreshingAll(true);
    for (const m of markets) {
      try {
        await supabase.functions.invoke("weather-refresh-market", { body: { market_id: m.id } });
      } catch { /* skip */ }
    }
    setRefreshingAll(false);
    toast.success("All markets refreshed");
    load();
  };

  const remove = async (id: string) => {
    if (!confirm("Delete this market?")) return;
    await supabase.from("weather_markets").delete().eq("id", id);
    load();
  };

  const signOut = async () => {
    await supabase.auth.signOut();
    nav("/auth", { replace: true });
  };

  if (loading || !userId) {
    return <div className="min-h-screen flex items-center justify-center text-muted-foreground">Loading…</div>;
  }

  // Best opportunity per market = highest positive edge among its outcomes (>= 7%)
  const bestFor = (mid: string) => {
    const list = outcomes[mid] ?? [];
    const best = [...list].sort((a, b) => (b.edge ?? -Infinity) - (a.edge ?? -Infinity))[0];
    if (!best || (best.edge ?? -Infinity) < 0.07) return null;
    return best;
  };

  // Apply volume filter + mismatch toggle, then sort by mismatch → edge → volume.
  // Rule: only HIDE rows where there's a tradable edge AND volume is too low.
  // Rows without edge are kept regardless so users see why nothing qualifies.
  const visibleMarkets = (() => {
    const filtered = markets.filter((m) => {
      const best = bestFor(m.id);
      const vol = Number(m.event_volume_24h ?? 0);
      const sig = signals[m.id];
      if (best && vol < minVolume) return false;
      if (mismatchOnly && !sig?.favorite_mismatch) return false;
      return true;
    });
    return filtered.sort((a, b) => {
      const sa = signals[a.id];
      const sb = signals[b.id];
      const ma = sa?.favorite_mismatch ? 1 : 0;
      const mb = sb?.favorite_mismatch ? 1 : 0;
      if (ma !== mb) return mb - ma;
      const ea = bestFor(a.id)?.edge ?? -Infinity;
      const eb = bestFor(b.id)?.edge ?? -Infinity;
      if (ea !== eb) return eb - ea;
      return Number(b.event_volume_24h ?? 0) - Number(a.event_volume_24h ?? 0);
    });
  })();

  return (
    <div className="min-h-screen">
      <header className="border-b border-border bg-background/80 backdrop-blur sticky top-0 z-10">
        <div className="container py-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
          <div className="flex items-center gap-3 min-w-0">
            <Link to="/" className="text-muted-foreground hover:text-foreground shrink-0">
              <ArrowLeft className="h-4 w-4" />
            </Link>
            <div className="h-2 w-2 rounded-full bg-primary animate-pulse-soft shrink-0" />
            <h1 className="text-sm font-semibold tracking-wide truncate">Weather Edge Trader</h1>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <BankrollInput userId={userId} bankroll={bankroll} onChange={setBankroll} />
            <MinVolumeInput userId={userId} minVolume={minVolume} onChange={setMinVolume} />
            <MaxTradeCapInput userId={userId} maxPct={maxTradePct} onChange={setMaxTradePct} />
            <div className="flex items-center gap-1.5 rounded-md border border-border bg-surface-2/40 px-2 py-1">
              <Zap className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Mismatch</span>
              <Switch checked={mismatchOnly} onCheckedChange={setMismatchOnly} />
            </div>
            <Button variant="outline" size="sm" onClick={refreshAll} disabled={refreshingAll || markets.length === 0}>
              {refreshingAll ? <Loader2 className="h-3 w-3 animate-spin sm:mr-1" /> : <RefreshCw className="h-3 w-3 sm:mr-1" />}
              <span className="hidden sm:inline">Refresh all</span>
            </Button>
            <AddMarketDialog userId={userId} onAdded={load} />
            <Button variant="ghost" size="sm" onClick={signOut}>
              <LogOut className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </header>

      <main className="container py-4 sm:py-6 space-y-4 px-2 sm:px-4">
        <WeatherScanner
          markets={markets}
          outcomes={outcomes}
          signals={signals}
          bankroll={bankroll}
          minVolume={minVolume}
          mismatchOnly={mismatchOnly}
          onReload={load}
          onSelect={(m) => setDetailMarket(m)}
        />

        <BestTradeSignal
          markets={markets}
          outcomes={outcomes}
          signals={signals}
          bankroll={bankroll}
          minVolume={minVolume}
          mismatchOnly={mismatchOnly}
          maxTradePct={maxTradePct}
          onSelect={(m) => setDetailMarket(m)}
        />

        <ClvPanel />
        <BiasPanel />

        <section className="bg-card border border-border rounded-lg overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[960px]">
              <thead className="text-[10px] uppercase tracking-wider text-muted-foreground border-b border-border">
                <tr>
                  <th className="text-left px-4 py-2 font-medium">Market</th>
                  <th className="text-left px-3 py-2 font-medium">City</th>
                  <th className="text-left px-3 py-2 font-medium">Event</th>
                  <th className="text-right px-3 py-2 font-medium">Volume</th>
                  <th className="text-left px-3 py-2 font-medium">Best Trade</th>
                  <th className="text-right px-3 py-2 font-medium">Edge</th>
                  <th className="text-right px-3 py-2 font-medium">Size %</th>
                  <th className="text-right px-3 py-2 font-medium">Trade $</th>
                  <th className="text-center px-3 py-2 font-medium">Conf.</th>
                  <th className="text-right px-4 py-2 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {visibleMarkets.length === 0 && (
                  <tr><td colSpan={10} className="text-center py-12 text-muted-foreground">
                    {markets.length === 0
                      ? `No markets yet. Click "Add market" to get started.`
                      : `No markets match current filters (min vol $${minVolume.toLocaleString()}${mismatchOnly ? ", mismatches only" : ""}).`}
                  </td></tr>
                )}
                {visibleMarkets.map((m) => {
                  const s = signals[m.id];
                  const best = bestFor(m.id);
                  const isMismatch = !!s?.favorite_mismatch;
                  return (
                    <tr
                      key={m.id}
                      className={cn(
                        "border-b border-border/50 hover:bg-surface-2/50",
                        isMismatch && "bg-emerald-500/5",
                      )}
                    >
                      <td className="px-4 py-2.5 max-w-[260px]">
                        <div className="truncate" title={m.market_question}>{m.market_question}</div>
                        <div className="text-[10px] text-muted-foreground">{m.condition_type}</div>
                      </td>
                      <td className="px-3 py-2.5 text-muted-foreground">{m.city}</td>
                      <td className="px-3 py-2.5 text-muted-foreground text-xs">
                        <div>{new Date(m.event_time).toLocaleString()}</div>
                        {(() => {
                          const risk = isSettlementRisk(m.event_time);
                          if (!risk) return null;
                          const h = hoursToResolution(m.event_time);
                          const label = h == null ? "<6h" : h < 0 ? "resolving" : `${h.toFixed(1)}h left`;
                          return (
                            <span
                              className="mt-0.5 inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[9px] uppercase tracking-wider bg-red-500/15 text-red-400 border-red-500/30"
                              title="Within 6h of resolution — forecast uncertainty has collapsed; apparent edge is likely a settlement quirk."
                            >
                              ⚠ {label}
                            </span>
                          );
                        })()}
                      </td>
                      <td className="px-3 py-2.5 text-right font-mono-num text-muted-foreground">
                        {formatVolume(m.event_volume_24h)}
                      </td>
                      <td className="px-3 py-2.5">
                        {best ? (
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <Sparkles className="h-3 w-3 text-emerald-400" />
                            <span className="font-medium text-emerald-400">{best.label}</span>
                            {isMismatch && (
                              <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded border text-[9px] uppercase tracking-wider bg-emerald-500/15 text-emerald-400 border-emerald-500/30">
                                <Zap className="h-2.5 w-2.5" /> Mismatch
                              </span>
                            )}
                          </div>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className={`px-3 py-2.5 text-right font-mono-num font-semibold ${edgeColor(best?.edge)}`}>
                        {pct(best?.edge)}
                      </td>
                      <td className="px-3 py-2.5 text-right font-mono-num">
                        {best?.suggested_size_percent ? `${best.suggested_size_percent}%` : "—"}
                      </td>
                      <td className="px-3 py-2.5 text-right font-mono-num font-semibold text-foreground">
                        {(() => {
                          if (!best?.suggested_size_percent) return "—";
                          const { capped, wasCapped } = applyMaxTradeCap(best.suggested_size_percent, maxTradePct);
                          const dollars = (bankroll * capped) / 100;
                          return (
                            <span title={wasCapped ? `Capped from ${best.suggested_size_percent}% to ${maxTradePct}%` : undefined}>
                              ${dollars.toFixed(2)}
                              {wasCapped && <span className="ml-1 text-[9px] text-amber-400">⛨</span>}
                            </span>
                          );
                        })()}
                      </td>
                      <td className="px-3 py-2.5 text-center">
                        {s?.confidence_level ? (
                          <span className={`px-2 py-0.5 rounded border text-[10px] uppercase tracking-wider ${confidenceColor(s.confidence_level)}`}>
                            {s.confidence_level}
                          </span>
                        ) : <span className="text-muted-foreground">—</span>}
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        <div className="inline-flex items-center gap-1">
                          <StationOverridePicker
                            marketId={m.id}
                            city={m.city}
                            currentCode={m.resolution_station_code}
                            currentName={m.resolution_station_name}
                            onChange={load}
                          />
                          <Button size="sm" variant="ghost" disabled={refreshing === m.id} onClick={() => refresh(m.id)}>
                            {refreshing === m.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                          </Button>
                          <Button size="sm" variant="secondary" onClick={() => setDetailMarket(m)}>
                            View
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => remove(m.id)}>
                            <Trash2 className="h-3 w-3" />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
        <p className="text-[11px] text-muted-foreground text-center">
          Manual trading assistant. ECMWF ensemble distribution + GFS sanity check via Open-Meteo. No auto-execution.
        </p>
      </main>

      <TradeDetailDialog
        open={!!detailMarket}
        onOpenChange={(v) => !v && setDetailMarket(null)}
        market={detailMarket}
        outcomes={detailMarket ? outcomes[detailMarket.id] ?? [] : []}
        signal={detailMarket ? signals[detailMarket.id] ?? null : null}
        bankroll={bankroll}
      />
    </div>
  );
};

export default Weather;
