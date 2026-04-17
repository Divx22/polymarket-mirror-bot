import { cn } from "@/lib/utils";

export const SideBadge = ({ side }: { side: string }) => {
  const isBuy = side?.toUpperCase() === "BUY";
  return (
    <span
      className={cn(
        "inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold tracking-wider font-mono-num",
        isBuy
          ? "bg-buy/15 text-buy border border-buy/30"
          : "bg-sell/15 text-sell border border-sell/30",
      )}
    >
      {isBuy ? "BUY" : "SELL"}
    </span>
  );
};
