import { useEffect, useState, useCallback } from "react";
import { useNavigate, Link } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { ArrowLeft, TrendingUp } from "lucide-react";
import { MomentumBreakouts } from "@/components/weather/MomentumBreakouts";
import { WeatherMarket, WeatherOutcome } from "@/lib/weather";

const Momentum = () => {
  const nav = useNavigate();
  const [userId, setUserId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [markets, setMarkets] = useState<WeatherMarket[]>([]);
  const [outcomes, setOutcomes] = useState<Record<string, WeatherOutcome[]>>({});
  const [bankroll, setBankroll] = useState<number>(1000);
  const [maxTradePct, setMaxTradePct] = useState<number>(2);

  useEffect(() => {
    document.title = "Momentum · Weather Edge Trader";
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
    const [{ data: ms }, { data: os }, { data: cfg }] = await Promise.all([
      supabase.from("weather_markets").select("*").eq("active", true).order("event_time"),
      supabase.from("weather_outcomes").select("*").order("display_order"),
      supabase.from("config").select("bankroll_usdc, max_trade_pct").eq("user_id", userId).maybeSingle(),
    ]);
    setMarkets((ms ?? []) as WeatherMarket[]);
    const grouped: Record<string, WeatherOutcome[]> = {};
    (os ?? []).forEach((o: any) => {
      (grouped[o.market_id] ??= []).push(o as WeatherOutcome);
    });
    setOutcomes(grouped);
    if (cfg) {
      setBankroll(Number(cfg.bankroll_usdc ?? 1000));
      setMaxTradePct(Number(cfg.max_trade_pct ?? 2));
    }
  }, [userId]);

  useEffect(() => { load(); }, [load]);

  if (loading) return <div className="min-h-screen flex items-center justify-center text-muted-foreground">Loading…</div>;

  // Cap at the lower of user's max_trade_pct and 3% (long-term momentum strategy guardrail).
  const stakeCapPct = Math.min(maxTradePct, 3);

  return (
    <div className="min-h-screen">
      <header className="border-b border-border bg-background/80 backdrop-blur sticky top-0 z-10">
        <div className="container py-3 flex items-center gap-3">
          <Link to="/weather" className="text-muted-foreground hover:text-foreground shrink-0">
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <TrendingUp className="h-4 w-4 text-primary" />
          <h1 className="text-sm font-semibold tracking-wide">Momentum Scanner</h1>
          <Link to="/trades" className="ml-auto text-[11px] rounded border border-border bg-background hover:bg-surface-2 px-2 py-1 text-muted-foreground hover:text-foreground">
            Trades log
          </Link>
          <div className="text-[10px] text-muted-foreground font-mono-num">
            Bankroll ${bankroll.toLocaleString()} · max {stakeCapPct}%/trade
          </div>
        </div>
      </header>

      <main className="container py-4 sm:py-6 space-y-4 px-2 sm:px-4">
        <p className="text-xs text-muted-foreground">
          Scans your saved markets and (via Discover) every active Polymarket weather market in the next 48h.
          Suggested stake is based on your bankroll, capped at {stakeCapPct}% of capital, and scaled by momentum score.
        </p>
        <MomentumBreakouts
          markets={markets}
          outcomes={outcomes}
          bankroll={bankroll}
          stakeCapPct={stakeCapPct}
        />
      </main>
    </div>
  );
};

export default Momentum;
