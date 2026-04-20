import { useEffect, useRef } from "react";
import { toast } from "sonner";
import type { WeatherMarket, WeatherOutcome } from "@/lib/weather";

type Args = {
  markets: WeatherMarket[];
  outcomes: Record<string, WeatherOutcome[]>;
  modelMin?: number;   // default 0.5
  marketMax?: number;  // default 0.5
  onClick?: (m: WeatherMarket) => void;
};

/**
 * Fires a toast whenever ANY outcome has p_model > modelMin
 * while polymarket_price < marketMax. Once per outcome per session.
 */
export const useModelEdgeAlerts = ({
  markets, outcomes, modelMin = 0.5, marketMax = 0.5, onClick,
}: Args) => {
  const seen = useRef<Set<string>>(new Set());

  useEffect(() => {
    const byId = new Map(markets.map((m) => [m.id, m]));
    for (const m of markets) {
      const outs = outcomes[m.id] ?? [];
      for (const o of outs) {
        const pm = Number(o.p_model ?? 0);
        const pp = Number(o.polymarket_price ?? 1);
        if (!(pm > modelMin && pp < marketMax)) continue;
        if (seen.current.has(o.id)) continue;
        seen.current.add(o.id);

        const market = byId.get(m.id);
        toast.success(
          `${m.city}: ${o.label}`,
          {
            description: `Model ${(pm * 100).toFixed(0)}% vs Market ${(pp * 100).toFixed(0)}% — disagreement`,
            duration: 10000,
            action: market && onClick
              ? { label: "View", onClick: () => onClick(market) }
              : undefined,
          },
        );
      }
    }
  }, [markets, outcomes, modelMin, marketMax, onClick]);
};
