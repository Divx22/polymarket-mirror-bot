import { useEffect, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { ConfigCard } from "@/components/ConfigCard";
import { TradesFeed } from "@/components/TradesFeed";
import { PaperLedger } from "@/components/PaperLedger";
import { StatsRow } from "@/components/StatsRow";
import { LogOut } from "lucide-react";

const Index = () => {
  const nav = useNavigate();
  const [userId, setUserId] = useState<string | null>(null);
  const [config, setConfig] = useState<any>(null);
  const [trades, setTrades] = useState<any[]>([]);
  const [orders, setOrders] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    document.title = "Polymarket Copy-Trader — Dry Run";

    const { data: sub } = supabase.auth.onAuthStateChange((_e, session) => {
      if (!session) nav("/auth", { replace: true });
      else setUserId(session.user.id);
    });
    supabase.auth.getSession().then(({ data }) => {
      if (!data.session) nav("/auth", { replace: true });
      else setUserId(data.session.user.id);
    });
    return () => sub.subscription.unsubscribe();
  }, [nav]);

  const reload = useCallback(async () => {
    if (!userId) return;
    const [c, t, o] = await Promise.all([
      supabase.from("config").select("*").eq("user_id", userId).maybeSingle(),
      supabase
        .from("detected_trades")
        .select("*")
        .eq("user_id", userId)
        .order("trade_ts", { ascending: false })
        .limit(25),
      supabase
        .from("paper_orders")
        .select("*")
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .limit(25),
    ]);
    setConfig(c.data);
    setTrades(t.data ?? []);
    setOrders(o.data ?? []);
    setLoading(false);
  }, [userId]);

  useEffect(() => {
    if (!userId) return;
    reload();
    const ch = supabase
      .channel(`user-${userId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "detected_trades", filter: `user_id=eq.${userId}` },
        () => reload(),
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "paper_orders", filter: `user_id=eq.${userId}` },
        () => reload(),
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "config", filter: `user_id=eq.${userId}` },
        () => reload(),
      )
      .subscribe();
    return () => {
      supabase.removeChannel(ch);
    };
  }, [userId, reload]);

  const signOut = async () => {
    await supabase.auth.signOut();
    nav("/auth", { replace: true });
  };

  const dayAgo = Date.now() / 1000 - 86400;
  const tradesToday = trades.filter((t) => t.trade_ts >= dayAgo).length;
  const ordersToday = orders.filter(
    (o) => new Date(o.created_at).getTime() / 1000 >= dayAgo,
  ).length;
  const volumeToday = orders
    .filter((o) => new Date(o.created_at).getTime() / 1000 >= dayAgo)
    .reduce((s, o) => s + Number(o.intended_usdc ?? 0), 0);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center text-muted-foreground">
        Loading…
      </div>
    );
  }

  return (
    <div className="min-h-screen">
      <header className="border-b border-border bg-background/80 backdrop-blur sticky top-0 z-10">
        <div className="container py-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="h-2 w-2 rounded-full bg-primary animate-pulse-soft" />
            <h1 className="text-sm font-semibold tracking-wide">
              Polymarket Mirror{" "}
              <span className="text-muted-foreground font-normal">
                · dry-run
              </span>
            </h1>
          </div>
          <Button variant="ghost" size="sm" onClick={signOut}>
            <LogOut className="h-4 w-4 mr-2" />
            Sign out
          </Button>
        </div>
      </header>

      <main className="container py-6 space-y-6">
        <StatsRow
          tradesToday={tradesToday}
          ordersToday={ordersToday}
          volumeToday={volumeToday}
          totalTrades={trades.length}
        />
        <ConfigCard config={config} onChange={reload} />
        <TradesFeed trades={trades} />
        <PaperLedger orders={orders} onChange={reload} />
        <p className="text-[11px] text-muted-foreground text-center pt-2">
          Auto-poll runs every 1 minute when enabled. Live trading places real
          limit orders on Polymarket — caps enforced server-side.
        </p>
      </main>
    </div>
  );
};

export default Index;
