import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Wallet, Loader2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

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

export const computePositionPlan = (
  bankrollUsdc: number,
  sizePct: number,
  bid: number | null,
  mid: number | null,
) => {
  const positionValue = Math.max(0, (bankrollUsdc * sizePct) / 100);
  const lo = bid ?? (mid != null ? Math.max(0.01, mid - 0.01) : null);
  const hi = mid;
  const entry = lo != null && hi != null ? (lo + hi) / 2 : (mid ?? bid);
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
};

export const PositionCalculator = ({ bankrollUsdc, sizePct, bid, mid }: CalcProps) => {
  const plan = computePositionPlan(bankrollUsdc, sizePct, bid, mid);
  if (sizePct <= 0 || bankrollUsdc <= 0) return null;

  const fmt = (n: number | null | undefined, dp = 2) =>
    n == null || !Number.isFinite(n) ? "—" : n.toFixed(dp);
  const cents = (p: number | null | undefined) =>
    p == null ? "—" : `${(p * 100).toFixed(1)}¢`;

  return (
    <div className="rounded border border-border/60 bg-background/40 px-3 py-2 text-xs space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
          Position Plan ({sizePct}% of ${bankrollUsdc.toLocaleString()})
        </div>
        <div className="font-mono-num font-semibold text-foreground">
          ${fmt(plan.positionValue)}
        </div>
      </div>
      <div className="grid grid-cols-3 gap-2">
        <Stat label="Entry range" value={`${cents(plan.entryLo)}–${cents(plan.entryHi)}`} />
        <Stat label="Mid entry" value={cents(plan.entryMid)} />
        <Stat label="Shares" value={plan.shares.toLocaleString()} />
      </div>
      {plan.shares > 0 && plan.splitBid.shares > 0 && plan.splitMid.shares > 0 && (
        <div className="rounded border border-border/40 bg-surface-2/30 p-2">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
            Suggested split (better fills)
          </div>
          <div className="grid grid-cols-2 gap-2 text-[11px]">
            <div>
              <div className="text-muted-foreground">Order 1 · best bid</div>
              <div className="font-mono-num">
                {plan.splitBid.shares.toLocaleString()} sh @ {cents(plan.splitBid.price)}
              </div>
            </div>
            <div>
              <div className="text-muted-foreground">Order 2 · midpoint</div>
              <div className="font-mono-num">
                {plan.splitMid.shares.toLocaleString()} sh @ {cents(plan.splitMid.price)}
              </div>
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
