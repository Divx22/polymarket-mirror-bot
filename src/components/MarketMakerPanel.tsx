import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";
import { Loader2, Plus, Power, Search, Trash2, AlertTriangle } from "lucide-react";
import { CopyLinkButton } from "./CopyLinkButton";

type Market = {
  id: string;
  asset_id: string;
  market_question: string | null;
  outcome: string | null;
  end_date: string | null;
  active: boolean;
  inventory_shares: number;
  inventory_avg_price: number;
  spread_captured_usdc: number;
  last_bid_price: number | null;
  last_ask_price: number | null;
  last_book_best_bid: number | null;
  last_book_best_ask: number | null;
  last_cycle_at: string | null;
  last_error: string | null;
};

type Cfg = {
  id: string;
  enabled: boolean;
  default_size_usdc: number;
  default_max_inventory_usdc: number;
  total_capital_cap_usdc: number;
  default_spread_offset_ticks: number;
  default_min_existing_spread_ticks: number;
  min_days_to_expiry: number;
  quote_mode: "inside" | "join" | "passive";
  sell_ladder_rungs: number;
  sell_ladder_spacing_ticks: number;
};

type Candidate = {
  asset_id: string;
  market_question: string;
  outcome: string;
  end_date: string | null;
  best_bid: number;
  best_ask: number;
  spread: number;
  spread_pct: number;
  volume_24h: number;
};

export const MarketMakerPanel = ({ userId }: { userId: string | null }) => {
  const [cfg, setCfg] = useState<Cfg | null>(null);
  const [markets, setMarkets] = useState<Market[]>([]);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [loadingCandidates, setLoadingCandidates] = useState(false);
  const [pasteUrl, setPasteUrl] = useState("");
  const [walletAddr, setWalletAddr] = useState("0x6480542954b70a674a74bd1a6015dec362dc8dc5");
  const [importing, setImporting] = useState(false);
  const [adding, setAdding] = useState(false);
  const [running, setRunning] = useState(false);
  const [killing, setKilling] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [walletPreview, setWalletPreview] = useState<Array<{ asset_id: string; market_question: string | null; outcome: string | null; end_date: string | null; shares: number; current_price: number }>>([]);
  const [walletPicked, setWalletPicked] = useState<Set<string>>(new Set());

  const reload = useCallback(async () => {
    if (!userId) return;
    const [c, m] = await Promise.all([
      supabase.from("mm_config").select("*").eq("user_id", userId).maybeSingle(),
      supabase.from("mm_markets").select("*").eq("user_id", userId).order("created_at", { ascending: false }),
    ]);
    setCfg(c.data as any);
    setMarkets((m.data ?? []) as any);
  }, [userId]);

  useEffect(() => {
    reload();
    if (!userId) return;
    const ch = supabase
      .channel(`mm-${userId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "mm_markets", filter: `user_id=eq.${userId}` }, () => reload())
      .on("postgres_changes", { event: "*", schema: "public", table: "mm_config", filter: `user_id=eq.${userId}` }, () => reload())
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [userId, reload]);

  const updateCfg = async (patch: Partial<Cfg>) => {
    if (!cfg) return;
    setCfg({ ...cfg, ...patch });
    const { error } = await supabase.from("mm_config").update(patch).eq("id", cfg.id);
    if (error) {
      toast.error(error.message);
      reload();
    }
  };

  const fetchCandidates = async () => {
    setLoadingCandidates(true);
    try {
      const { data, error } = await supabase.functions.invoke("mm-candidates", { body: {} });
      if (error) throw error;
      setCandidates(data?.candidates ?? []);
    } catch (e: any) {
      toast.error(e.message ?? "Failed to load candidates");
    } finally {
      setLoadingCandidates(false);
    }
  };

  const addMarket = async (payload: any) => {
    setAdding(true);
    try {
      const { data, error } = await supabase.functions.invoke("mm-add-market", { body: payload });
      if (error) throw error;
      if (!data?.ok) throw new Error(data?.error ?? "Add failed");
      toast.success(`Added: ${data.market.market_question?.slice(0, 40) ?? "market"}`);
      setPasteUrl("");
      reload();
    } catch (e: any) {
      toast.error(e.message ?? "Failed to add market");
    } finally {
      setAdding(false);
    }
  };

  const removeMarket = async (id: string) => {
    setMarkets((ms) => ms.filter((m) => m.id !== id));
    const { error } = await supabase.from("mm_markets").delete().eq("id", id);
    if (error) { toast.error(error.message); reload(); }
  };

  const toggleSelect = (id: string) => {
    setSelected((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  };
  const toggleSelectAll = () => {
    setSelected((s) => (s.size === markets.length ? new Set() : new Set(markets.map((m) => m.id))));
  };
  const removeSelected = async () => {
    if (selected.size === 0) return;
    if (!confirm(`Remove ${selected.size} market(s)?`)) return;
    const ids = Array.from(selected);
    setMarkets((ms) => ms.filter((m) => !selected.has(m.id)));
    setSelected(new Set());
    const { error } = await supabase.from("mm_markets").delete().in("id", ids);
    if (error) { toast.error(error.message); reload(); }
    else toast.success(`Removed ${ids.length}`);
  };
  const removeAll = async () => {
    if (markets.length === 0 || !userId) return;
    if (!confirm(`Remove ALL ${markets.length} markets?`)) return;
    setMarkets([]);
    setSelected(new Set());
    const { error } = await supabase.from("mm_markets").delete().eq("user_id", userId);
    if (error) { toast.error(error.message); reload(); }
    else toast.success("Removed all");
  };

  const importFromWallet = async () => {
    setImporting(true);
    setWalletPreview([]);
    setWalletPicked(new Set());
    try {
      const { data, error } = await supabase.functions.invoke("mm-import-wallet", { body: { wallet: walletAddr, preview: true } });
      if (error) throw error;
      if (!data?.ok) throw new Error(data?.error ?? "Preview failed");
      const items = data.preview ?? [];
      if (items.length === 0) {
        toast.info("No eligible markets found in that wallet");
      } else {
        setWalletPreview(items);
        setWalletPicked(new Set(items.map((i: any) => i.asset_id)));
        toast.success(`Found ${items.length} eligible markets — pick which to add`);
      }
    } catch (e: any) {
      toast.error(e.message ?? "Failed to load wallet");
    } finally {
      setImporting(false);
    }
  };

  const confirmWalletImport = async () => {
    if (walletPicked.size === 0) return;
    setImporting(true);
    try {
      const { data, error } = await supabase.functions.invoke("mm-import-wallet", {
        body: { wallet: walletAddr, token_ids: Array.from(walletPicked) },
      });
      if (error) throw error;
      if (!data?.ok) throw new Error(data?.error ?? "Import failed");
      toast.success(`Added ${data.added} markets`);
      setWalletPreview([]);
      setWalletPicked(new Set());
      reload();
    } catch (e: any) {
      toast.error(e.message ?? "Import failed");
    } finally {
      setImporting(false);
    }
  };

  const runCycle = async () => {
    setRunning(true);
    try {
      const { data, error } = await supabase.functions.invoke("mm-cycle", { body: { user_id: userId } });
      if (error) throw error;
      const r = data?.results?.[0];
      toast.success(r ? `Processed ${r.markets_processed}, placed ${r.orders_placed}, cancelled ${r.orders_cancelled}, fills ${r.fills_detected}` : "Cycle done");
    } catch (e: any) {
      toast.error(e.message ?? "Cycle failed");
    } finally {
      setRunning(false);
    }
  };

  const killAll = async () => {
    if (!confirm("Cancel ALL market-maker orders and disable the bot?")) return;
    setKilling(true);
    try {
      const { data, error } = await supabase.functions.invoke("mm-kill", { body: {} });
      if (error) throw error;
      toast.success(`Cancelled ${data?.cancelled ?? 0} orders, bot disabled`);
    } catch (e: any) {
      toast.error(e.message ?? "Kill failed");
    } finally {
      setKilling(false);
    }
  };

  const totalInventoryUsdc = markets.reduce(
    (s, m) => s + Math.abs(m.inventory_shares) * ((m.last_book_best_bid ?? 0) + (m.last_book_best_ask ?? 0)) / 2, 0,
  );
  const totalSpreadCaptured = markets.reduce((s, m) => s + Number(m.spread_captured_usdc ?? 0), 0);

  if (!cfg) return null;

  return (
    <section className="bg-card border border-border rounded-lg p-5">
      <div className="flex items-start justify-between mb-4">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Market Maker
          </h2>
          <p className="text-xs text-muted-foreground mt-1">
            Quotes a bid and ask just inside the best prices on selected markets. Earns the spread when both fill. Runs every 30 seconds.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Label htmlFor="mm-enabled" className="text-xs text-muted-foreground">Bot</Label>
          <Switch id="mm-enabled" checked={cfg.enabled} onCheckedChange={(v) => updateCfg({ enabled: v })} />
        </div>
      </div>

      {cfg.enabled && (
        <div className="flex items-start gap-2 p-3 rounded-md border border-sell/40 bg-sell/10 text-xs mb-4">
          <AlertTriangle className="h-4 w-4 text-sell shrink-0 mt-0.5" />
          <div>
            <strong className="text-sell">Live orders.</strong> The bot places real GTC limit orders sized at your defaults. Inventory you accumulate is real. Hit the Kill switch to cancel everything.
          </div>
        </div>
      )}

      {/* Settings */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
        <SettingNum label="Size / side ($)" value={cfg.default_size_usdc} onChange={(v) => updateCfg({ default_size_usdc: v })} step={0.5} />
        <SettingNum label="Max inv / mkt ($)" value={cfg.default_max_inventory_usdc} onChange={(v) => updateCfg({ default_max_inventory_usdc: v })} step={1} />
        <SettingNum label="Total cap ($)" value={cfg.total_capital_cap_usdc} onChange={(v) => updateCfg({ total_capital_cap_usdc: v })} step={5} />
        <SettingNum label="Min spread (ticks)" value={cfg.default_min_existing_spread_ticks} onChange={(v) => updateCfg({ default_min_existing_spread_ticks: v })} step={1} />
        <div>
          <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">Quote mode</Label>
          <select
            value={cfg.quote_mode}
            onChange={(e) => updateCfg({ quote_mode: e.target.value as Cfg["quote_mode"] })}
            className="mt-1 h-9 w-full rounded-md border border-input bg-background px-2 text-xs"
          >
            <option value="join">join (at best)</option>
            <option value="inside">inside (1 tick in)</option>
            <option value="passive">passive (1 tick out)</option>
          </select>
        </div>
        <SettingNum label="Sell ladder rungs" value={cfg.sell_ladder_rungs} onChange={(v) => updateCfg({ sell_ladder_rungs: v })} step={1} />
        <SettingNum label="Ladder spacing (ticks)" value={cfg.sell_ladder_spacing_ticks} onChange={(v) => updateCfg({ sell_ladder_spacing_ticks: v })} step={1} />
      </div>

      {/* Add markets */}
      <div className="space-y-3 mb-5 pt-4 border-t border-border">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Add markets</h3>
        <div className="flex gap-2">
          <Input
            placeholder="Paste a Polymarket URL (https://polymarket.com/event/…)"
            value={pasteUrl}
            onChange={(e) => setPasteUrl(e.target.value)}
            className="text-xs"
          />
          <Button onClick={() => addMarket({ url: pasteUrl })} disabled={adding || !pasteUrl} size="sm">
            <Plus className="h-4 w-4 mr-1" /> Add
          </Button>
        </div>
        <div className="flex gap-2">
          <Input
            placeholder="Wallet address (0x…) — copy all active markets it holds"
            value={walletAddr}
            onChange={(e) => setWalletAddr(e.target.value)}
            className="text-xs font-mono-num"
          />
          <Button onClick={importFromWallet} disabled={importing || !walletAddr} size="sm" variant="secondary">
            {importing ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Plus className="h-4 w-4 mr-1" />}
            Preview wallet's markets
          </Button>
        </div>
        {walletPreview.length > 0 && (
          <div className="border border-border rounded-md">
            <div className="flex items-center justify-between p-2 border-b border-border bg-muted/30">
              <div className="text-[11px] text-muted-foreground">
                {walletPicked.size} of {walletPreview.length} selected
              </div>
              <div className="flex gap-2">
                <Button size="sm" variant="ghost" onClick={() => setWalletPicked(new Set(walletPreview.map((i) => i.asset_id)))}>
                  All
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setWalletPicked(new Set())}>
                  None
                </Button>
                <Button size="sm" variant="ghost" onClick={() => { setWalletPreview([]); setWalletPicked(new Set()); }}>
                  Cancel
                </Button>
                <Button size="sm" onClick={confirmWalletImport} disabled={importing || walletPicked.size === 0}>
                  {importing ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Plus className="h-4 w-4 mr-1" />}
                  Add {walletPicked.size}
                </Button>
              </div>
            </div>
            <div className="max-h-64 overflow-y-auto">
              <table className="w-full text-[11px]">
                <tbody>
                  {walletPreview.map((p) => (
                    <tr key={p.asset_id} className="border-b border-border/40">
                      <td className="p-2 w-6">
                        <input
                          type="checkbox"
                          checked={walletPicked.has(p.asset_id)}
                          onChange={() => {
                            setWalletPicked((s) => {
                              const n = new Set(s);
                              n.has(p.asset_id) ? n.delete(p.asset_id) : n.add(p.asset_id);
                              return n;
                            });
                          }}
                          className="cursor-pointer"
                        />
                      </td>
                      <td className="p-2">
                        <div className="flex items-center gap-1">
                          <div className="text-foreground flex-1">{p.market_question}</div>
                          <CopyLinkButton text={p.market_question} />
                        </div>
                        <div className="text-[10px] text-muted-foreground">
                          {p.outcome} · ends {p.end_date} · {p.shares.toFixed(0)} shares @ {p.current_price.toFixed(3)}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
        <div>
          <Button onClick={fetchCandidates} disabled={loadingCandidates} size="sm" variant="secondary">
            {loadingCandidates ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Search className="h-4 w-4 mr-2" />}
            Browse good candidates
          </Button>
          {candidates.length > 0 && (
            <div className="mt-2 max-h-64 overflow-y-auto border border-border rounded-md">
              <table className="w-full text-[11px]">
                <thead className="text-[10px] uppercase tracking-wider text-muted-foreground border-b border-border bg-muted/30">
                  <tr>
                    <th className="text-left p-2">Market</th>
                    <th className="text-right p-2">Bid / Ask</th>
                    <th className="text-right p-2">Spread</th>
                    <th className="text-right p-2">Vol 24h</th>
                    <th className="p-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {candidates.map((c) => (
                    <tr key={c.asset_id} className="border-b border-border/40">
                      <td className="p-2 max-w-[280px]">
                        <div className="flex items-center gap-1">
                          <div className="truncate text-foreground flex-1">{c.market_question}</div>
                          <CopyLinkButton text={c.market_question} />
                        </div>
                        <div className="text-[10px] text-muted-foreground">{c.outcome} · ends {c.end_date}</div>
                      </td>
                      <td className="text-right font-mono-num p-2">{c.best_bid.toFixed(3)} / {c.best_ask.toFixed(3)}</td>
                      <td className="text-right font-mono-num p-2 text-buy">{c.spread.toFixed(3)}</td>
                      <td className="text-right font-mono-num p-2">${Math.round(c.volume_24h).toLocaleString()}</td>
                      <td className="p-2">
                        <Button onClick={() => addMarket({ asset_id: c.asset_id })} disabled={adding} size="sm" variant="ghost">
                          <Plus className="h-3 w-3" />
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4 mb-3 pt-4 border-t border-border text-xs">
        <Stat label="Active markets" value={String(markets.filter(m => m.active).length)} />
        <Stat label="Inventory value" value={`$${totalInventoryUsdc.toFixed(2)}`} />
        <Stat label="Spread captured" value={`$${totalSpreadCaptured.toFixed(2)}`} tone={totalSpreadCaptured > 0 ? "buy" : "default"} />
      </div>

      {/* Bulk actions */}
      {markets.length > 0 && (
        <div className="flex items-center gap-2 mb-2">
          <Button onClick={removeSelected} disabled={selected.size === 0} size="sm" variant="destructive">
            <Trash2 className="h-3 w-3 mr-1" /> Remove selected ({selected.size})
          </Button>
          <Button onClick={removeAll} size="sm" variant="outline">
            Remove all
          </Button>
        </div>
      )}

      {/* Live table */}
      {markets.length === 0 ? (
        <div className="text-xs text-muted-foreground py-6 text-center">
          No markets yet. Add one above to start.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-[10px] uppercase tracking-wider text-muted-foreground border-b border-border">
              <tr>
                <th className="py-2 pr-2 w-8">
                  <input
                    type="checkbox"
                    checked={selected.size === markets.length && markets.length > 0}
                    onChange={toggleSelectAll}
                    className="cursor-pointer"
                  />
                </th>
                <th className="text-left py-2 pr-2 font-medium">Market</th>
                <th className="text-right py-2 px-2 font-medium">Book bid/ask</th>
                <th className="text-right py-2 px-2 font-medium">My bid/ask</th>
                <th className="text-right py-2 px-2 font-medium">Inventory</th>
                <th className="text-right py-2 px-2 font-medium">Captured</th>
                <th className="py-2 pl-2"></th>
              </tr>
            </thead>
            <tbody>
              {markets.map((m) => (
                <tr key={m.id} className="border-b border-border/40">
                  <td className="py-2 pr-2">
                    <input
                      type="checkbox"
                      checked={selected.has(m.id)}
                      onChange={() => toggleSelect(m.id)}
                      className="cursor-pointer"
                    />
                  </td>
                  <td className="py-2 pr-2 max-w-[260px]">
                    <div className="truncate text-foreground">{m.market_question}</div>
                    <div className="text-[10px] text-muted-foreground">
                      {m.outcome}{m.end_date ? ` · ends ${m.end_date}` : ""}
                      {m.last_error && <span className="text-sell"> · {m.last_error}</span>}
                    </div>
                  </td>
                  <td className="text-right font-mono-num py-2 px-2 text-muted-foreground">
                    {m.last_book_best_bid?.toFixed(3) ?? "—"} / {m.last_book_best_ask?.toFixed(3) ?? "—"}
                  </td>
                  <td className="text-right font-mono-num py-2 px-2">
                    <span className="text-buy">{m.last_bid_price?.toFixed(3) ?? "—"}</span>
                    {" / "}
                    <span className="text-sell">{m.last_ask_price?.toFixed(3) ?? "—"}</span>
                  </td>
                  <td className="text-right font-mono-num py-2 px-2">
                    {m.inventory_shares.toFixed(2)}
                    {m.inventory_avg_price > 0 && (
                      <div className="text-[10px] text-muted-foreground">@ {m.inventory_avg_price.toFixed(3)}</div>
                    )}
                  </td>
                  <td className={`text-right font-mono-num py-2 px-2 ${m.spread_captured_usdc > 0 ? "text-buy" : "text-muted-foreground"}`}>
                    ${Number(m.spread_captured_usdc).toFixed(2)}
                  </td>
                  <td className="py-2 pl-2 text-right">
                    <Button onClick={() => removeMarket(m.id)} size="sm" variant="ghost">
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex gap-2 mt-4 pt-4 border-t border-border">
        <Button onClick={runCycle} disabled={running || !cfg.enabled} size="sm">
          {running ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
          Run cycle now
        </Button>
        <Button onClick={killAll} disabled={killing} size="sm" variant="destructive">
          <Power className="h-4 w-4 mr-2" />
          Kill switch
        </Button>
      </div>
    </section>
  );
};

const SettingNum = ({ label, value, onChange, step }: { label: string; value: number; onChange: (v: number) => void; step: number }) => (
  <div>
    <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</Label>
    <Input
      type="number"
      value={value}
      step={step}
      min={0}
      onChange={(e) => onChange(Number(e.target.value))}
      className="font-mono-num mt-1 h-9"
    />
  </div>
);

const Stat = ({ label, value, tone = "default" }: { label: string; value: string; tone?: "default" | "buy" }) => (
  <div>
    <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
    <div className={`font-mono-num text-base ${tone === "buy" ? "text-buy" : "text-foreground"}`}>{value}</div>
  </div>
);
