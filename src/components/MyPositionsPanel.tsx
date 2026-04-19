import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { fmtRelative } from "@/lib/format";
import { CopyLinkButton } from "./CopyLinkButton";

type Market = {
  id: string;
  asset_id: string;
  market_question: string | null;
  outcome: string | null;
  inventory_shares: number;
  inventory_avg_price: number;
  spread_captured_usdc: number;
  last_book_best_bid: number | null;
  last_book_best_ask: number | null;
};

type Fill = {
  id: string;
  asset_id: string;
  market_question: string | null;
  outcome: string | null;
  side: string;
  price: number;
  shares: number;
  usdc_value: number;
  filled_at: string;
};

export const MyPositionsPanel = ({ userId }: { userId: string | null }) => {
  const [markets, setMarkets] = useState<Market[]>([]);
  const [fills, setFills] = useState<Fill[]>([]);

  const load = useCallback(async () => {
    if (!userId) return;
    const [m, f] = await Promise.all([
      supabase.from("mm_markets").select("id,asset_id,market_question,outcome,inventory_shares,inventory_avg_price,spread_captured_usdc,last_book_best_bid,last_book_best_ask").eq("user_id", userId),
      supabase.from("mm_fills").select("*").eq("user_id", userId).order("filled_at", { ascending: false }).limit(50),
    ]);
    setMarkets((m.data ?? []) as any);
    setFills((f.data ?? []) as any);
  }, [userId]);

  useEffect(() => {
    load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, [load]);

  const positions = markets.filter((m) => Math.abs(m.inventory_shares) > 1e-6);
  let totalValue = 0;
  let totalCost = 0;
  let totalUnrealized = 0;
  for (const p of positions) {
    const mid = ((p.last_book_best_bid ?? 0) + (p.last_book_best_ask ?? 0)) / 2;
    const value = p.inventory_shares * mid;
    const cost = p.inventory_shares * Number(p.inventory_avg_price ?? 0);
    totalValue += value;
    totalCost += cost;
    totalUnrealized += value - cost;
  }
  const totalCaptured = markets.reduce((s, m) => s + Number(m.spread_captured_usdc ?? 0), 0);

  return (
    <section className="bg-card border border-border rounded-lg p-5 space-y-5">
      <header>
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">My live positions</h2>
        <p className="text-xs text-muted-foreground mt-1">Inventory accumulated by the bot, marked to current mid. Auto-refreshes every 10s.</p>
      </header>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-xs">
        <Stat label="Open positions" value={String(positions.length)} />
        <Stat label="Inventory value" value={`$${totalValue.toFixed(2)}`} />
        <Stat label="Unrealized P&L" value={`${totalUnrealized >= 0 ? "+" : ""}$${totalUnrealized.toFixed(2)}`} tone={totalUnrealized >= 0 ? "buy" : "sell"} />
        <Stat label="Spread captured" value={`$${totalCaptured.toFixed(2)}`} tone={totalCaptured > 0 ? "buy" : "default"} />
      </div>

      {positions.length === 0 ? (
        <div className="text-xs text-muted-foreground py-4 text-center">No open inventory yet — fills will appear here once the bot trades.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-[10px] uppercase tracking-wider text-muted-foreground border-b border-border">
              <tr>
                <th className="text-left py-2 pr-2 font-medium">Market</th>
                <th className="text-right py-2 px-2 font-medium">Shares</th>
                <th className="text-right py-2 px-2 font-medium">Avg cost</th>
                <th className="text-right py-2 px-2 font-medium">Mid</th>
                <th className="text-right py-2 px-2 font-medium">Value</th>
                <th className="text-right py-2 pl-2 font-medium">P&L</th>
              </tr>
            </thead>
            <tbody>
              {positions.map((p) => {
                const mid = ((p.last_book_best_bid ?? 0) + (p.last_book_best_ask ?? 0)) / 2;
                const value = p.inventory_shares * mid;
                const cost = p.inventory_shares * Number(p.inventory_avg_price ?? 0);
                const pnl = value - cost;
                return (
                  <tr key={p.id} className="border-b border-border/40">
                    <td className="py-2 pr-2 max-w-[260px]">
                      <div className="flex items-center gap-1">
                        <div className="truncate text-foreground flex-1">{p.market_question ?? p.asset_id}</div>
                        <CopyLinkButton text={p.market_question ?? p.asset_id} />
                      </div>
                      {p.outcome && <div className="text-[10px] text-muted-foreground">{p.outcome}</div>}
                    </td>
                    <td className="text-right font-mono-num py-2 px-2">{p.inventory_shares.toFixed(2)}</td>
                    <td className="text-right font-mono-num py-2 px-2 text-muted-foreground">{Number(p.inventory_avg_price).toFixed(3)}</td>
                    <td className="text-right font-mono-num py-2 px-2 text-muted-foreground">{mid > 0 ? mid.toFixed(3) : "—"}</td>
                    <td className="text-right font-mono-num py-2 px-2">${value.toFixed(2)}</td>
                    <td className={`text-right font-mono-num py-2 pl-2 ${pnl >= 0 ? "text-buy" : "text-sell"}`}>
                      {pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div>
        <h3 className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">Recent fills ({fills.length})</h3>
        {fills.length === 0 ? (
          <div className="text-xs text-muted-foreground py-3 text-center">No fills yet.</div>
        ) : (
          <div className="max-h-72 overflow-y-auto border border-border rounded-md">
            <table className="w-full text-[11px]">
              <tbody>
                {fills.map((f) => (
                  <tr key={f.id} className="border-b border-border/40">
                    <td className="p-2 font-mono-num w-24 whitespace-nowrap" title={new Date(f.filled_at).toLocaleString()}>
                      <div className="text-foreground">{fmtRelative(new Date(f.filled_at).getTime() / 1000)}</div>
                      <div className="text-[9px] text-muted-foreground">{new Date(f.filled_at).toLocaleTimeString()}</div>
                    </td>
                    <td className="p-2 w-12">
                      <span className={`text-[10px] uppercase font-semibold ${f.side === "BUY" ? "text-buy" : "text-sell"}`}>{f.side}</span>
                    </td>
                    <td className="p-2 max-w-[260px]">
                      <div className="flex items-center gap-1">
                        <div className="truncate text-foreground flex-1">{f.market_question ?? f.asset_id}</div>
                        <CopyLinkButton text={f.market_question ?? f.asset_id} />
                      </div>
                      <div className="text-[10px] text-muted-foreground">{f.outcome}</div>
                    </td>
                    <td className="p-2 text-right font-mono-num">{Number(f.shares).toFixed(2)} @ {Number(f.price).toFixed(3)}</td>
                    <td className="p-2 text-right font-mono-num">${Number(f.usdc_value).toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
};

const Stat = ({ label, value, tone = "default" }: { label: string; value: string; tone?: "default" | "buy" | "sell" }) => (
  <div>
    <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
    <div className={`font-mono-num text-base ${tone === "buy" ? "text-buy" : tone === "sell" ? "text-sell" : "text-foreground"}`}>{value}</div>
  </div>
);
