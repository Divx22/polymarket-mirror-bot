import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";
import { fmtRelative, shortAddr } from "@/lib/format";
import { RefreshCw, AlertTriangle } from "lucide-react";

type Config = {
  id: string;
  user_id: string;
  target_wallet: string | null;
  enabled: boolean;
  last_seen_ts: number;
  last_polled_at: string | null;
  auto_execute: boolean;
  max_usdc_per_trade: number;
  daily_usdc_limit: number;
  usdc_spent_today: number;
  spent_day: string;
};

export const ConfigCard = ({
  config,
  onChange,
}: {
  config: Config | null;
  onChange: () => void;
}) => {
  const [wallet, setWallet] = useState(config?.target_wallet ?? "");
  const [enabled, setEnabled] = useState(config?.enabled ?? false);
  const [autoExecute, setAutoExecute] = useState(config?.auto_execute ?? false);
  const [maxPerTrade, setMaxPerTrade] = useState(String(config?.max_usdc_per_trade ?? 5));
  const [dailyLimit, setDailyLimit] = useState(String(config?.daily_usdc_limit ?? 50));
  const [saving, setSaving] = useState(false);
  const [polling, setPolling] = useState(false);

  useEffect(() => {
    setWallet(config?.target_wallet ?? "");
    setEnabled(config?.enabled ?? false);
    setAutoExecute(config?.auto_execute ?? false);
    setMaxPerTrade(String(config?.max_usdc_per_trade ?? 5));
    setDailyLimit(String(config?.daily_usdc_limit ?? 50));
  }, [config?.id, config?.target_wallet, config?.enabled, config?.auto_execute, config?.max_usdc_per_trade, config?.daily_usdc_limit]);

  const today = new Date().toISOString().slice(0, 10);
  const spentToday = config?.spent_day === today ? Number(config?.usdc_spent_today ?? 0) : 0;

  const save = async () => {
    if (!config) return;
    setSaving(true);
    const trimmed = wallet.trim().toLowerCase();
    if (trimmed && !/^0x[a-f0-9]{40}$/.test(trimmed)) {
      toast.error("Invalid wallet address");
      setSaving(false);
      return;
    }
    const maxN = Number(maxPerTrade);
    const dailyN = Number(dailyLimit);
    if (!Number.isFinite(maxN) || maxN <= 0 || !Number.isFinite(dailyN) || dailyN <= 0) {
      toast.error("Caps must be positive numbers");
      setSaving(false);
      return;
    }
    const { error } = await supabase
      .from("config")
      .update({
        target_wallet: trimmed || null,
        enabled,
        auto_execute: autoExecute,
        max_usdc_per_trade: maxN,
        daily_usdc_limit: dailyN,
      })
      .eq("id", config.id);
    setSaving(false);
    if (error) return toast.error(error.message);
    toast.success("Saved");
    onChange();
  };

  const checkNow = async () => {
    setPolling(true);
    try {
      const { data, error } = await supabase.functions.invoke("manual-poll", { body: {} });
      if (error) throw error;
      const inserted = data?.results?.[0]?.inserted ?? 0;
      toast.success(
        inserted > 0 ? `${inserted} new trade${inserted > 1 ? "s" : ""}` : "No new trades",
      );
      onChange();
    } catch (e: any) {
      toast.error(e.message ?? "Poll failed");
    } finally {
      setPolling(false);
    }
  };

  return (
    <section className="bg-card border border-border rounded-lg p-5">
      <div className="flex items-start justify-between mb-4">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Target Wallet
          </h2>
          <p className="text-xs text-muted-foreground mt-1">
            Polygon address to mirror. Trades read from Polymarket Data API.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Label htmlFor="enabled" className="text-xs text-muted-foreground">
            Auto-poll
          </Label>
          <Switch id="enabled" checked={enabled} onCheckedChange={setEnabled} />
        </div>
      </div>

      <div className="flex flex-col sm:flex-row gap-2">
        <Input
          value={wallet}
          onChange={(e) => setWallet(e.target.value)}
          placeholder="0x…"
          className="font-mono-num"
        />
        <Button onClick={save} disabled={saving} variant="secondary">
          {saving ? "…" : "Save"}
        </Button>
        <Button onClick={checkNow} disabled={polling || !config?.target_wallet}>
          <RefreshCw className={`h-4 w-4 mr-2 ${polling ? "animate-spin" : ""}`} />
          Check now
        </Button>
      </div>

      {/* Live trading panel */}
      <div className="mt-5 pt-4 border-t border-border">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
              Live Trading
            </h3>
            <p className="text-xs text-muted-foreground mt-1">
              Auto-place real limit orders at the target's fill price.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Label htmlFor="auto-exec" className="text-xs text-muted-foreground">
              Auto-execute
            </Label>
            <Switch id="auto-exec" checked={autoExecute} onCheckedChange={setAutoExecute} />
          </div>
        </div>

        {autoExecute && (
          <div className="flex items-start gap-2 p-3 rounded-md border border-sell/40 bg-sell/10 text-xs mb-3">
            <AlertTriangle className="h-4 w-4 text-sell shrink-0 mt-0.5" />
            <div>
              <strong className="text-sell">Real money, real losses.</strong> Orders are signed with your Polymarket proxy wallet. Slippage vs target is unavoidable. SELL needs existing shares. Caps are your only safety net.
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <Label htmlFor="max-trade" className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Max per trade (USDC)
            </Label>
            <Input
              id="max-trade"
              type="number"
              min="0.01"
              step="0.01"
              value={maxPerTrade}
              onChange={(e) => setMaxPerTrade(e.target.value)}
              className="font-mono-num mt-1"
            />
          </div>
          <div>
            <Label htmlFor="daily-cap" className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Daily limit (USDC)
            </Label>
            <Input
              id="daily-cap"
              type="number"
              min="0.01"
              step="0.01"
              value={dailyLimit}
              onChange={(e) => setDailyLimit(e.target.value)}
              className="font-mono-num mt-1"
            />
          </div>
        </div>

        <div className="text-xs text-muted-foreground mt-3 font-mono-num">
          Spent today: <span className="text-foreground">${spentToday.toFixed(2)}</span> / ${Number(dailyLimit).toFixed(2)}
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 mt-5 pt-4 border-t border-border text-xs">
        <Stat label="Wallet" value={shortAddr(config?.target_wallet)} />
        <Stat
          label="Auto-poll"
          value={enabled ? "Every minute" : "Off"}
          tone={enabled ? "buy" : "muted"}
        />
        <Stat
          label="Last polled"
          value={
            config?.last_polled_at
              ? fmtRelative(new Date(config.last_polled_at).getTime() / 1000)
              : "Never"
          }
        />
      </div>
    </section>
  );
};

const Stat = ({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: string;
  tone?: "default" | "buy" | "muted";
}) => (
  <div>
    <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
      {label}
    </div>
    <div
      className={`font-mono-num mt-1 ${
        tone === "buy" ? "text-buy" : tone === "muted" ? "text-muted-foreground" : ""
      }`}
    >
      {value}
    </div>
  </div>
);
