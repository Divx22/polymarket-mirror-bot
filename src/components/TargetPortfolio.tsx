import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { RefreshCw } from "lucide-react";
import { toast } from "sonner";

type TP = {
  asset: string;
  title: string;
  outcome: string;
  size: number;
  avgPrice: number;
  curPrice: number;
  currentValue: number;
  cashPnl: number;
  percentPnl: number;
  redeemable: boolean;
  endDate: string | null;
};

export const TargetPortfolio = ({ targetWallet }: { targetWallet: string | null }) => {
  const [positions, setPositions] = useState<TP[]>([]);
  const [loading, setLoading] = useState(false);
  const [walletShown, setWalletShown] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke("target-portfolio", { body: {} });
      if (error) throw error;
      setPositions(data?.positions ?? []);
      setWalletShown(data?.wallet ?? null);
    } catch (e: any) {
      toast.error(e.message ?? "Failed to load target portfolio");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load, targetWallet]);

  const totalValue = positions.reduce((s, p) => s + p.currentValue, 0);
  const totalPnl = positions.reduce((s, p) => s + p.cashPnl, 0);

  return (
    <section className="bg-card border border-border rounded-lg p-5">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Target Portfolio
          </h2>
          <p className="text-xs text-muted-foreground mt-1">
            {walletShown ? (
              <>Live open positions for{" "}
                <span className="font-mono-num text-foreground">
                  {walletShown.slice(0, 6)}…{walletShown.slice(-4)}
                </span>
              </>
            ) : (
              "Set a target wallet in Config to view their portfolio."
            )}
          </p>
        </div>
        <Button onClick={load} disabled={loading} size="sm" variant="secondary">
          <RefreshCw className={`h-4 w-4 mr-2 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {walletShown && positions.length > 0 && (
        <div className="grid grid-cols-3 gap-4 mb-4 text-xs">
          <div>
            <div className="text-muted-foreground">Markets</div>
            <div className="font-mono-num text-foreground text-base">{positions.length}</div>
          </div>
          <div>
            <div className="text-muted-foreground">Total value</div>
            <div className="font-mono-num text-foreground text-base">
              ${totalValue.toFixed(2)}
            </div>
          </div>
          <div>
            <div className="text-muted-foreground">Unrealized PnL</div>
            <div
              className={`font-mono-num text-base ${
                totalPnl > 0 ? "text-buy" : totalPnl < 0 ? "text-sell" : "text-foreground"
              }`}
            >
              {totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(2)}
            </div>
          </div>
        </div>
      )}

      {!walletShown ? null : positions.length === 0 ? (
        <div className="text-xs text-muted-foreground py-6 text-center">
          {loading ? "Loading…" : "No open positions for this wallet."}
        </div>
      ) : (
        <div className="overflow-x-auto max-h-[480px]">
          <table className="w-full text-xs">
            <thead className="text-[10px] uppercase tracking-wider text-muted-foreground border-b border-border sticky top-0 bg-card">
              <tr>
                <th className="text-left py-2 pr-2 font-medium">Market</th>
                <th className="text-right py-2 px-2 font-medium">Size</th>
                <th className="text-right py-2 px-2 font-medium">Avg</th>
                <th className="text-right py-2 px-2 font-medium">Now</th>
                <th className="text-right py-2 px-2 font-medium">Value</th>
                <th className="text-right py-2 pl-2 font-medium">PnL</th>
              </tr>
            </thead>
            <tbody>
              {positions.map((p) => (
                <tr key={p.asset} className="border-b border-border/40">
                  <td className="py-2 pr-2 max-w-[320px]">
                    <div className="truncate text-foreground">{p.title}</div>
                    <div className="text-[10px] text-muted-foreground flex gap-2">
                      <span>{p.outcome}</span>
                      {p.redeemable && (
                        <span className="text-buy">· redeemable</span>
                      )}
                      {p.endDate && <span>· ends {p.endDate}</span>}
                    </div>
                  </td>
                  <td className="text-right font-mono-num py-2 px-2">
                    {p.size.toFixed(2)}
                  </td>
                  <td className="text-right font-mono-num py-2 px-2 text-muted-foreground">
                    {p.avgPrice > 0 ? p.avgPrice.toFixed(3) : "—"}
                  </td>
                  <td className="text-right font-mono-num py-2 px-2">
                    {p.curPrice.toFixed(3)}
                  </td>
                  <td className="text-right font-mono-num py-2 px-2">
                    ${p.currentValue.toFixed(2)}
                  </td>
                  <td
                    className={`text-right font-mono-num py-2 pl-2 ${
                      p.cashPnl > 0 ? "text-buy" : p.cashPnl < 0 ? "text-sell" : "text-muted-foreground"
                    }`}
                  >
                    {p.cashPnl >= 0 ? "+" : ""}${p.cashPnl.toFixed(2)}
                    {p.percentPnl !== 0 && (
                      <div className="text-[10px]">
                        {p.percentPnl >= 0 ? "+" : ""}
                        {(p.percentPnl * 100).toFixed(1)}%
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
};
