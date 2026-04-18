import { useState } from "react";
import { SideBadge } from "./SideBadge";
import { fmtPrice, fmtNum, fmtUsd, fmtRelative, shortHash } from "@/lib/format";
import { ExternalLink, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

type Trade = {
  id: string;
  tx_hash: string;
  trade_ts: number;
  side: string;
  market_question: string | null;
  outcome: string | null;
  price: number | null;
  size: number | null;
  usdc_size: number | null;
  order_id?: string | null;
  order_original_size?: number | null;
  order_original_usdc?: number | null;
  is_partial_fill?: boolean | null;
};

export const TradesFeed = ({
  trades,
  onChange,
}: {
  trades: Trade[];
  onChange?: () => void;
}) => {
  const [executing, setExecuting] = useState<string | null>(null);

  const mirror = async (tradeId: string) => {
    setExecuting(tradeId);
    try {
      const { data, error } = await supabase.functions.invoke("execute-order", {
        body: { detected_trade_id: tradeId },
      });
      if (error) throw error;
      if (!data?.ok) throw new Error(data?.error ?? "Execution failed");
      toast.success(`Order ${data.status}`, {
        description: data.txHash ? `tx ${data.txHash.slice(0, 10)}…` : undefined,
      });
      onChange?.();
    } catch (e: any) {
      toast.error(e.message ?? "Execute failed");
      onChange?.();
    } finally {
      setExecuting(null);
    }
  };

  return (
    <section className="bg-card border border-border rounded-lg overflow-hidden">
      <header className="px-5 py-3 border-b border-border flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Detected Trades
        </h2>
        <span className="text-xs text-muted-foreground font-mono-num">
          {trades.length} shown
        </span>
      </header>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-[10px] uppercase tracking-wider text-muted-foreground border-b border-border">
            <tr>
              <th className="text-left px-5 py-2 font-medium">Time</th>
              <th className="text-left px-3 py-2 font-medium">Side</th>
              <th className="text-left px-3 py-2 font-medium">Market</th>
              <th className="text-left px-3 py-2 font-medium">Outcome</th>
              <th className="text-right px-3 py-2 font-medium">Price</th>
              <th className="text-right px-3 py-2 font-medium">Size</th>
              <th className="text-right px-3 py-2 font-medium">USDC</th>
              <th className="text-right px-3 py-2 font-medium">Order</th>
              <th className="text-right px-3 py-2 font-medium">Tx</th>
              <th className="text-right px-5 py-2 font-medium">Mirror</th>
            </tr>
          </thead>
          <tbody>
            {trades.length === 0 && (
              <tr>
                <td colSpan={10} className="text-center py-12 text-muted-foreground">
                  No trades detected yet. Set a target wallet and click "Check now".
                </td>
              </tr>
            )}
            {trades.map((t) => (
              <tr
                key={t.id}
                className="border-b border-border/50 hover:bg-surface-2/50 animate-slide-in"
              >
                <td className="px-5 py-2.5 text-muted-foreground font-mono-num text-xs">
                  {fmtRelative(t.trade_ts)}
                </td>
                <td className="px-3 py-2.5">
                  <SideBadge side={t.side} />
                </td>
                <td className="px-3 py-2.5 max-w-[280px] truncate">
                  {t.market_question ?? "—"}
                </td>
                <td className="px-3 py-2.5 text-muted-foreground">
                  {t.outcome ?? "—"}
                </td>
                <td className="px-3 py-2.5 text-right font-mono-num">
                  {fmtPrice(t.price)}
                </td>
                <td className="px-3 py-2.5 text-right font-mono-num">
                  {fmtNum(t.size, 2)}
                </td>
                <td className="px-3 py-2.5 text-right font-mono-num">
                  {fmtUsd(t.usdc_size)}
                </td>
                <td className="px-3 py-2.5 text-right">
                  <a
                    href={`https://polygonscan.com/tx/${t.tx_hash}`}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground font-mono-num text-xs"
                  >
                    {shortHash(t.tx_hash)}
                    <ExternalLink className="h-3 w-3" />
                  </a>
                </td>
                <td className="px-5 py-2.5 text-right">
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={executing === t.id}
                    onClick={() => mirror(t.id)}
                  >
                    {executing === t.id ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      "Mirror"
                    )}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
};
