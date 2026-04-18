import { useState } from "react";
import { SideBadge } from "./SideBadge";
import { fmtPrice, fmtNum, fmtUsd } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { ExternalLink, Loader2 } from "lucide-react";

type Order = {
  id: string;
  side: string;
  market_question: string | null;
  outcome: string | null;
  intended_price: number | null;
  intended_size: number | null;
  intended_usdc: number | null;
  status: string;
  note: string | null;
  created_at: string;
  executed_tx_hash?: string | null;
  error?: string | null;
};

const statusStyles: Record<string, string> = {
  simulated: "bg-muted text-muted-foreground",
  submitted: "bg-buy/15 text-buy",
  filled: "bg-buy/25 text-buy",
  failed: "bg-sell/20 text-sell",
};

const StatusBadge = ({ status }: { status: string }) => (
  <span className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded font-medium ${statusStyles[status] ?? "bg-muted text-muted-foreground"}`}>
    {status}
  </span>
);

export const PaperLedger = ({ orders, onChange }: { orders: Order[]; onChange?: () => void }) => {
  const [executing, setExecuting] = useState<string | null>(null);

  const execute = async (id: string) => {
    setExecuting(id);
    try {
      const { data, error } = await supabase.functions.invoke("execute-order", {
        body: { paper_order_id: id },
      });
      if (error) throw error;
      if (!data?.ok) throw new Error(data?.error ?? "Execution failed");
      toast.success(`Order ${data.status}`);
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
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Paper Ledger
          </h2>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            Mirror orders — simulated unless live trading is on.
          </p>
        </div>
        <span className="text-xs text-muted-foreground font-mono-num">
          {orders.length} orders
        </span>
      </header>
      <div className="overflow-x-auto">
        <TooltipProvider>
          <table className="w-full text-sm">
            <thead className="text-[10px] uppercase tracking-wider text-muted-foreground border-b border-border">
              <tr>
                <th className="text-left px-5 py-2 font-medium">When</th>
                <th className="text-left px-3 py-2 font-medium">Side</th>
                <th className="text-left px-3 py-2 font-medium">Market</th>
                <th className="text-right px-3 py-2 font-medium">Price</th>
                <th className="text-right px-3 py-2 font-medium">Size</th>
                <th className="text-right px-3 py-2 font-medium">USDC</th>
                <th className="text-left px-3 py-2 font-medium">Status</th>
                <th className="text-right px-5 py-2 font-medium">Action</th>
              </tr>
            </thead>
            <tbody>
              {orders.length === 0 && (
                <tr>
                  <td colSpan={8} className="text-center py-10 text-muted-foreground">
                    No mirrored orders yet.
                  </td>
                </tr>
              )}
              {orders.map((o) => (
                <tr
                  key={o.id}
                  className="border-b border-border/50 hover:bg-surface-2/50 animate-slide-in"
                >
                  <td className="px-5 py-2.5 text-muted-foreground font-mono-num text-xs">
                    {new Date(o.created_at).toLocaleTimeString()}
                  </td>
                  <td className="px-3 py-2.5">
                    <SideBadge side={o.side} />
                  </td>
                  <td className="px-3 py-2.5 max-w-[260px] truncate">
                    <div>{o.market_question ?? "—"}</div>
                    {o.outcome && (
                      <div className="text-[11px] text-muted-foreground">{o.outcome}</div>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-right font-mono-num">
                    {fmtPrice(o.intended_price)}
                  </td>
                  <td className="px-3 py-2.5 text-right font-mono-num">
                    {fmtNum(o.intended_size, 2)}
                  </td>
                  <td className="px-3 py-2.5 text-right font-mono-num">
                    {fmtUsd(o.intended_usdc)}
                  </td>
                  <td className="px-3 py-2.5">
                    {o.status === "failed" && o.error ? (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span><StatusBadge status={o.status} /></span>
                        </TooltipTrigger>
                        <TooltipContent className="max-w-xs">
                          <p className="text-xs break-words">{o.error}</p>
                        </TooltipContent>
                      </Tooltip>
                    ) : (
                      <StatusBadge status={o.status} />
                    )}
                  </td>
                  <td className="px-5 py-2.5 text-right">
                    {o.status === "simulated" && (
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={executing === o.id}
                        onClick={() => execute(o.id)}
                      >
                        {executing === o.id ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          "Execute"
                        )}
                      </Button>
                    )}
                    {o.executed_tx_hash && (
                      <a
                        href={`https://polygonscan.com/tx/${o.executed_tx_hash}`}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-xs text-buy hover:underline font-mono-num"
                      >
                        tx <ExternalLink className="h-3 w-3" />
                      </a>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TooltipProvider>
      </div>
    </section>
  );
};
