import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { shortAddr } from "@/lib/format";

type Position = {
  id: string;
  asset_id: string;
  market_question: string | null;
  outcome: string | null;
  target_shares: number;
  mirror_shares: number;
  last_target_price: number | null;
  last_reconciled_at: string | null;
};

export const PositionsPanel = ({
  userId,
  mirrorRatio,
}: {
  userId: string | null;
  mirrorRatio: number;
}) => {
  const [positions, setPositions] = useState<Position[]>([]);
  const [running, setRunning] = useState(false);

  const load = async () => {
    if (!userId) return;
    const { data } = await supabase
      .from("positions")
      .select("*")
      .eq("user_id", userId)
      .order("updated_at", { ascending: false });
    setPositions((data ?? []) as Position[]);
  };

  useEffect(() => {
    load();
    if (!userId) return;
    const ch = supabase
      .channel(`positions-${userId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "positions", filter: `user_id=eq.${userId}` },
        () => load(),
      )
      .subscribe();
    return () => {
      supabase.removeChannel(ch);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  const reconcileNow = async () => {
    setRunning(true);
    try {
      const { data, error } = await supabase.functions.invoke("reconcile-positions", {
        body: { user_id: userId },
      });
      if (error) throw error;
      const r = data?.results?.[0];
      toast.success(
        r ? `Scanned ${r.scanned ?? 0}, placed ${r.orders_placed ?? 0}` : "Reconciled",
      );
      load();
    } catch (e: any) {
      toast.error(e.message ?? "Reconcile failed");
    } finally {
      setRunning(false);
    }
  };

  const visible = positions.filter(
    (p) => Math.abs(p.target_shares) > 1e-6 || Math.abs(p.mirror_shares) > 1e-6,
  );

  return (
    <section className="bg-card border border-border rounded-lg p-5">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Positions
          </h2>
          <p className="text-xs text-muted-foreground mt-1">
            Target wallet shares vs your mirror, scaled by{" "}
            <span className="text-foreground font-mono-num">
              {(mirrorRatio * 100).toFixed(2)}%
            </span>
            . Reconciles every 2 minutes.
          </p>
        </div>
        <Button onClick={reconcileNow} disabled={running || !userId} size="sm" variant="secondary">
          <RefreshCw className={`h-4 w-4 mr-2 ${running ? "animate-spin" : ""}`} />
          Reconcile now
        </Button>
      </div>

      {visible.length === 0 ? (
        <div className="text-xs text-muted-foreground py-6 text-center">
          Click Reconcile now to populate from the target's live portfolio.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-[10px] uppercase tracking-wider text-muted-foreground border-b border-border">
              <tr>
                <th className="text-left py-2 pr-2 font-medium">Market</th>
                <th className="text-right py-2 px-2 font-medium">Target</th>
                <th className="text-right py-2 px-2 font-medium">Desired</th>
                <th className="text-right py-2 px-2 font-medium">Mirror</th>
                <th className="text-right py-2 pl-2 font-medium">Drift (USDC)</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((p) => {
                const desired = p.target_shares * mirrorRatio;
                const drift = desired - p.mirror_shares;
                const driftUsdc = drift * Number(p.last_target_price ?? 0);
                const aboveMin = Math.abs(driftUsdc) >= 1;
                return (
                  <tr key={p.id} className="border-b border-border/40">
                    <td className="py-2 pr-2 max-w-[260px]">
                      <div className="truncate text-foreground">
                        {p.market_question ?? shortAddr(p.asset_id)}
                      </div>
                      {p.outcome && (
                        <div className="text-[10px] text-muted-foreground">{p.outcome}</div>
                      )}
                    </td>
                    <td className="text-right font-mono-num py-2 px-2">
                      {p.target_shares.toFixed(2)}
                    </td>
                    <td className="text-right font-mono-num py-2 px-2 text-muted-foreground">
                      {desired.toFixed(2)}
                    </td>
                    <td className="text-right font-mono-num py-2 px-2">
                      {p.mirror_shares.toFixed(2)}
                    </td>
                    <td
                      className={`text-right font-mono-num py-2 pl-2 ${
                        !aboveMin
                          ? "text-muted-foreground"
                          : driftUsdc > 0
                            ? "text-buy"
                            : "text-sell"
                      }`}
                    >
                      {driftUsdc >= 0 ? "+" : ""}
                      {driftUsdc.toFixed(2)}
                      {!aboveMin && <span className="text-[10px] ml-1">·sub-$1</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
};
