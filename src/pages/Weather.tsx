import { useEffect, useState, useCallback } from "react";
import { useNavigate, Link } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { LogOut, RefreshCw, Loader2, Trash2, ArrowLeft } from "lucide-react";
import { toast } from "sonner";
import { AddMarketDialog } from "@/components/weather/AddMarketDialog";
import { TradeDetailDialog } from "@/components/weather/TradeDetailDialog";
import { WeatherMarket, WeatherSignal, pct, edgeColor, confidenceColor } from "@/lib/weather";

const Weather = () => {
  const nav = useNavigate();
  const [userId, setUserId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [markets, setMarkets] = useState<WeatherMarket[]>([]);
  const [signals, setSignals] = useState<Record<string, WeatherSignal>>({});
  const [refreshing, setRefreshing] = useState<string | null>(null);
  const [refreshingAll, setRefreshingAll] = useState(false);
  const [detailMarket, setDetailMarket] = useState<WeatherMarket | null>(null);

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
    const [{ data: ms }, { data: sigs }] = await Promise.all([
      supabase.from("weather_markets").select("*").eq("active", true).order("event_time"),
      supabase.from("weather_signals").select("*").order("created_at", { ascending: false }),
    ]);
    setMarkets((ms ?? []) as WeatherMarket[]);
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
        await supabase.functions.invoke("weather-refresh-market", {
          body: { market_id: m.id },
        });
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

  return (
    <div className="min-h-screen">
      <header className="border-b border-border bg-background/80 backdrop-blur sticky top-0 z-10">
        <div className="container py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link to="/" className="text-muted-foreground hover:text-foreground">
              <ArrowLeft className="h-4 w-4" />
            </Link>
            <div className="h-2 w-2 rounded-full bg-primary animate-pulse-soft" />
            <h1 className="text-sm font-semibold tracking-wide">Weather Edge Trader</h1>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={refreshAll} disabled={refreshingAll || markets.length === 0}>
              {refreshingAll ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <RefreshCw className="h-3 w-3 mr-1" />}
              Refresh all
            </Button>
            <AddMarketDialog userId={userId} onAdded={load} />
            <Button variant="ghost" size="sm" onClick={signOut}>
              <LogOut className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </header>

      <main className="container py-6 space-y-4">
        <section className="bg-card border border-border rounded-lg overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-[10px] uppercase tracking-wider text-muted-foreground border-b border-border">
                <tr>
                  <th className="text-left px-4 py-2 font-medium">Market</th>
                  <th className="text-left px-3 py-2 font-medium">City</th>
                  <th className="text-left px-3 py-2 font-medium">Event</th>
                  <th className="text-right px-3 py-2 font-medium">NOAA</th>
                  <th className="text-right px-3 py-2 font-medium">ECMWF</th>
                  <th className="text-right px-3 py-2 font-medium">Final</th>
                  <th className="text-right px-3 py-2 font-medium">Market</th>
                  <th className="text-right px-3 py-2 font-medium">Edge</th>
                  <th className="text-right px-3 py-2 font-medium">Size</th>
                  <th className="text-center px-3 py-2 font-medium">Conf.</th>
                  <th className="text-right px-4 py-2 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {markets.length === 0 && (
                  <tr><td colSpan={11} className="text-center py-12 text-muted-foreground">
                    No markets yet. Click "Add market" to get started.
                  </td></tr>
                )}
                {markets.map((m) => {
                  const s = signals[m.id];
                  return (
                    <tr key={m.id} className="border-b border-border/50 hover:bg-surface-2/50">
                      <td className="px-4 py-2.5 max-w-[260px]">
                        <div className="truncate" title={m.market_question}>{m.market_question}</div>
                        <div className="text-[10px] text-muted-foreground">{m.condition_range}</div>
                      </td>
                      <td className="px-3 py-2.5 text-muted-foreground">{m.city}</td>
                      <td className="px-3 py-2.5 text-muted-foreground text-xs">
                        {new Date(m.event_time).toLocaleString()}
                      </td>
                      <td className="px-3 py-2.5 text-right font-mono-num">{pct(s?.p_noaa)}</td>
                      <td className="px-3 py-2.5 text-right font-mono-num">{pct(s?.p_ecmwf)}</td>
                      <td className="px-3 py-2.5 text-right font-mono-num font-semibold">{pct(s?.p_final)}</td>
                      <td className="px-3 py-2.5 text-right font-mono-num">{pct(s?.p_market)}</td>
                      <td className={`px-3 py-2.5 text-right font-mono-num font-semibold ${edgeColor(s?.edge)}`}>
                        {pct(s?.edge)}
                      </td>
                      <td className="px-3 py-2.5 text-right font-mono-num">
                        {s?.suggested_size_percent ? `${s.suggested_size_percent}%` : "—"}
                      </td>
                      <td className="px-3 py-2.5 text-center">
                        {s?.confidence_level ? (
                          <span className={`px-2 py-0.5 rounded border text-[10px] uppercase tracking-wider ${confidenceColor(s.confidence_level)}`}>
                            {s.confidence_level}
                          </span>
                        ) : <span className="text-muted-foreground">—</span>}
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        <div className="inline-flex gap-1">
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
          Manual trading assistant. Forecasts via Open-Meteo (GFS as NOAA proxy + ECMWF ensemble). No auto-execution.
        </p>
      </main>

      <TradeDetailDialog
        open={!!detailMarket}
        onOpenChange={(v) => !v && setDetailMarket(null)}
        market={detailMarket}
        signal={detailMarket ? signals[detailMarket.id] ?? null : null}
      />
    </div>
  );
};

export default Weather;
