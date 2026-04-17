import { fmtUsd } from "@/lib/format";

export const StatsRow = ({
  tradesToday,
  ordersToday,
  volumeToday,
  totalTrades,
}: {
  tradesToday: number;
  ordersToday: number;
  volumeToday: number;
  totalTrades: number;
}) => {
  const items = [
    { label: "Trades today", value: tradesToday.toString() },
    { label: "Mirrored today", value: ordersToday.toString() },
    { label: "Mirrored volume (24h)", value: fmtUsd(volumeToday) },
    { label: "Trades all time", value: totalTrades.toString() },
  ];
  return (
    <section className="grid grid-cols-2 lg:grid-cols-4 gap-3">
      {items.map((it) => (
        <div
          key={it.label}
          className="bg-card border border-border rounded-lg px-4 py-3"
        >
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
            {it.label}
          </div>
          <div className="font-mono-num text-xl mt-1">{it.value}</div>
        </div>
      ))}
    </section>
  );
};
