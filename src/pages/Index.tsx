import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { MarketMakerPanel } from "@/components/MarketMakerPanel";
import { MyPositionsPanel } from "@/components/MyPositionsPanel";
import { LogOut } from "lucide-react";

const Index = () => {
  const nav = useNavigate();
  const [userId, setUserId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    document.title = "Polymarket Market Maker";

    const { data: sub } = supabase.auth.onAuthStateChange((_e, session) => {
      if (!session) nav("/auth", { replace: true });
      else {
        setUserId(session.user.id);
        setLoading(false);
      }
    });
    supabase.auth.getSession().then(({ data }) => {
      if (!data.session) nav("/auth", { replace: true });
      else {
        setUserId(data.session.user.id);
        setLoading(false);
      }
    });
    return () => sub.subscription.unsubscribe();
  }, [nav]);

  const signOut = async () => {
    await supabase.auth.signOut();
    nav("/auth", { replace: true });
  };

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
              Polymarket Market Maker
            </h1>
          </div>
          <Button variant="ghost" size="sm" onClick={signOut}>
            <LogOut className="h-4 w-4 mr-2" />
            Sign out
          </Button>
        </div>
      </header>

      <main className="container py-6 space-y-6">
        <MarketMakerPanel userId={userId} />
        <MyPositionsPanel userId={userId} />
        <p className="text-[11px] text-muted-foreground text-center pt-2">
          Bot cycles every 30 seconds when enabled. Real limit orders placed on Polymarket — caps enforced server-side.
        </p>
      </main>
    </div>
  );
};

export default Index;
