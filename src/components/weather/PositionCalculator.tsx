import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Wallet, Loader2, Droplet, Shield } from "lucide-react";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { applyMaxTradeCap } from "@/lib/weather";

type Props = {
  userId: string;
  bankroll: number;
  onChange: (n: number) => void;
};

export const BankrollInput = ({ userId, bankroll, onChange }: Props) => {
  const [value, setValue] = useState(String(bankroll));
  const [saving, setSaving] = useState(false);

  useEffect(() => { setValue(String(bankroll)); }, [bankroll]);

  const save = async () => {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0 || n > 10_000_000) {
      toast.error("Enter a bankroll between 0 and 10,000,000");
      return;
    }
    setSaving(true);
    const { error } = await supabase
      .from("config").update({ bankroll_usdc: n }).eq("user_id", userId);
    setSaving(false);
    if (error) { toast.error(error.message); return; }
    onChange(n);
    toast.success(`Bankroll set to $${n.toLocaleString()}`);
  };

  return (
    <div className="flex items-center gap-1.5 rounded-md border border-border bg-surface-2/40 px-2 py-1">
      <Wallet className="h-3.5 w-3.5 text-muted-foreground" />
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Bankroll</span>
      <span className="text-xs text-muted-foreground">$</span>
      <Input
        value={value}
        onChange={(e) => setValue(e.target.value.replace(/[^0-9.]/g, ""))}
        onBlur={save}
        onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
        inputMode="decimal"
        className="h-6 w-24 px-1.5 text-xs font-mono-num bg-transparent border-0 focus-visible:ring-0"
      />
      {saving && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
    </div>
  );
};

export const MinVolumeInput = ({
  userId, minVolume, onChange,
}: { userId: string; minVolume: number; onChange: (n: number) => void }) => {
  const [value, setValue] = useState(String(minVolume));
  const [saving, setSaving] = useState(false);

  useEffect(() => { setValue(String(minVolume)); }, [minVolume]);

  const save = async () => {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0 || n > 100_000_000) {
      toast.error("Enter a min volume between 0 and 100,000,000");
      return;
    }
    setSaving(true);
    const { error } = await supabase
      .from("config").update({ min_volume_usd: n }).eq("user_id", userId);
    setSaving(false);
    if (error) { toast.error(error.message); return; }
    onChange(n);
    toast.success(`Min volume set to $${n.toLocaleString()}`);
  };

  return (
    <div className="flex items-center gap-1.5 rounded-md border border-border bg-surface-2/40 px-2 py-1">
      <Droplet className="h-3.5 w-3.5 text-muted-foreground" />
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Min Vol</span>
      <span className="text-xs text-muted-foreground">$</span>
      <Input
        value={value}
        onChange={(e) => setValue(e.target.value.replace(/[^0-9.]/g, ""))}
        onBlur={save}
        onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
        inputMode="decimal"
        className="h-6 w-20 px-1.5 text-xs font-mono-num bg-transparent border-0 focus-visible:ring-0"
      />
      {saving && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
    </div>
  );
};

// Cap on max single-trade size as % of bankroll. Variance protection — even with
// a 90%-suggested edge, capping at 2% prevents one bad resolution from wiping months.
export const MaxTradeCapInput = ({
  userId, maxPct, onChange,
}: { userId: string; maxPct: number; onChange: (n: number) => void }) => {
  const [value, setValue] = useState(String(maxPct));
  const [saving, setSaving] = useState(false);

  useEffect(() => { setValue(String(maxPct)); }, [maxPct]);

  const save = async () => {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0 || n > 100) {
      toast.error("Enter a cap between 0 and 100 (%)");
      return;
    }
    setSaving(true);
    const { error } = await supabase
      .from("config").update({ max_trade_pct: n }).eq("user_id", userId);
    setSaving(false);
    if (error) { toast.error(error.message); return; }
    onChange(n);
    toast.success(`Max trade capped at ${n}%`);
  };

  return (
    <div className="flex items-center gap-1.5 rounded-md border border-border bg-surface-2/40 px-2 py-1">
      <Shield className="h-3.5 w-3.5 text-muted-foreground" />
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Max Trade</span>
      <Input
        value={value}
        onChange={(e) => setValue(e.target.value.replace(/[^0-9.]/g, ""))}
        onBlur={save}
        onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
        inputMode="decimal"
        className="h-6 w-12 px-1.5 text-xs font-mono-num bg-transparent border-0 focus-visible:ring-0"
      />
      <span className="text-xs text-muted-foreground">%</span>
      {saving && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
    </div>
  );
};

export const computePositionPlan = (
  bankrollUsdc: number,
  sizePct: number,
  bid: number | null,
  mid: number | null,
  ask: number | null = null,
) => {
  const positionValue = Math.max(0, (bankrollUsdc * sizePct) / 100);
  // Realistic fill price = current best ASK (what you actually pay to buy now).
  // The stale `mid` (last trade) can be wildly off for thin books — never use it
  // as the entry estimate when an ask is available.
  const lo = bid ?? (mid != null ? Math.max(0.01, mid - 0.01) : null);
  const hi = ask ?? mid;
  const entry = ask ?? (lo != null && hi != null ? (lo + hi) / 2 : (mid ?? bid));
  const shares = entry && entry > 0 ? Math.floor(positionValue / entry) : 0;
  // Split 50/50 (rounded down). Remainder added to mid leg so totals match.
  const halfBid = lo != null ? Math.floor(shares / 2) : 0;
  const halfMid = shares - halfBid;
  return {
    positionValue,
    entryLo: lo,
    entryHi: hi,
    entryMid: entry,
    shares,
    splitBid: { price: lo, shares: halfBid },
    splitMid: { price: hi ?? mid, shares: halfMid },
  };
};

type CalcProps = {
  bankrollUsdc: number;
  sizePct: number;
  bid: number | null;
  mid: number | null;
  maxTradePct?: number;
};

export const PositionCalculator = ({ bankrollUsdc, sizePct, bid, mid, maxTradePct = 2 }: CalcProps) => {
  const { capped: effectivePct, wasCapped } = applyMaxTradeCap(sizePct, maxTradePct);
  const plan = computePositionPlan(bankrollUsdc, effectivePct, bid, mid);
  if (effectivePct <= 0 || bankrollUsdc <= 0) return null;

  const fmt = (n: number | null | undefined, dp = 2) =>
    n == null || !Number.isFinite(n) ? "—" : n.toFixed(dp);
  const cents = (p: number | null | undefined) =>
    p == null ? "—" : `${(p * 100).toFixed(1)}¢`;

  const totalCost = plan.shares * (plan.entryMid ?? 0);
  const payoutIfWin = plan.shares * 1; // each share pays $1 if YES wins
  const profitIfWin = payoutIfWin - totalCost;

  return (
    <div className="rounded border border-border/60 bg-background/40 px-3 py-2 text-xs space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
          How much to bet ({effectivePct}% of ${bankrollUsdc.toLocaleString()})
        </div>
        <div className="font-mono-num font-semibold text-foreground">
          ${fmt(plan.positionValue)}
        </div>
      </div>

      {wasCapped && (
        <div className="rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-[10px] text-amber-300 leading-relaxed flex items-center gap-1">
          <Shield className="h-3 w-3 shrink-0" />
          <span>
            Capped from <span className="font-semibold">{sizePct}%</span> → <span className="font-semibold">{maxTradePct}%</span> (variance protection).
          </span>
        </div>
      )}

      <div className="rounded bg-surface-2/40 p-2 leading-relaxed">
        Spend about <span className="font-semibold text-foreground">${fmt(totalCost)}</span> to buy{" "}
        <span className="font-semibold text-foreground">{plan.shares.toLocaleString()} YES contracts</span>{" "}
        at around <span className="font-mono-num text-foreground">{cents(plan.entryMid)}</span> each.
        If YES wins, each contract pays $1 →{" "}
        <span className="font-semibold text-emerald-400">
          ${fmt(payoutIfWin)} back (${fmt(profitIfWin)} profit)
        </span>.
        If it loses, you lose what you spent.
      </div>

      {plan.shares > 0 && plan.splitBid.shares > 0 && plan.splitMid.shares > 0 && (
        <div className="rounded border border-border/40 bg-surface-2/30 p-2 space-y-1.5">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
            Tip: split into 2 orders for better prices
          </div>
          <div className="leading-relaxed text-[11px]">
            <div>
              <span className="text-muted-foreground">Order 1 (cheaper, may not fill):</span>{" "}
              buy <span className="font-semibold text-foreground">{plan.splitBid.shares.toLocaleString()}</span>{" "}
              at <span className="font-mono-num text-foreground">{cents(plan.splitBid.price)}</span>
            </div>
            <div>
              <span className="text-muted-foreground">Order 2 (fills now):</span>{" "}
              buy <span className="font-semibold text-foreground">{plan.splitMid.shares.toLocaleString()}</span>{" "}
              at <span className="font-mono-num text-foreground">{cents(plan.splitMid.price)}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

const Stat = ({ label, value }: { label: string; value: string }) => (
  <div>
    <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
    <div className="font-mono-num text-foreground">{value}</div>
  </div>
);
