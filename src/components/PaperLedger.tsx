import { SideBadge } from "./SideBadge";
import { fmtPrice, fmtNum, fmtUsd } from "@/lib/format";

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
};

export const PaperLedger = ({ orders }: { orders: Order[] }) => {
  return (
    <section className="bg-card border border-border rounded-lg overflow-hidden">
      <header className="px-5 py-3 border-b border-border flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Paper Ledger
          </h2>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            Simulated mirror orders — no real money placed.
          </p>
        </div>
        <span className="text-xs text-muted-foreground font-mono-num">
          {orders.length} orders
        </span>
      </header>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-[10px] uppercase tracking-wider text-muted-foreground border-b border-border">
            <tr>
              <th className="text-left px-5 py-2 font-medium">When</th>
              <th className="text-left px-3 py-2 font-medium">Side</th>
              <th className="text-left px-3 py-2 font-medium">Market</th>
              <th className="text-right px-3 py-2 font-medium">Price</th>
              <th className="text-right px-3 py-2 font-medium">Size</th>
              <th className="text-right px-5 py-2 font-medium">USDC</th>
            </tr>
          </thead>
          <tbody>
            {orders.length === 0 && (
              <tr>
                <td colSpan={6} className="text-center py-10 text-muted-foreground">
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
                <td className="px-3 py-2.5 max-w-[280px] truncate">
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
                <td className="px-5 py-2.5 text-right font-mono-num">
                  {fmtUsd(o.intended_usdc)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
};
