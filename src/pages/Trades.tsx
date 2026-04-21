import { useEffect, useMemo, useState, useCallback } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArrowLeft, BookmarkCheck, Loader2, Trash2, ExternalLink } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { resolveEdgeTrade, deleteEdgeTrade, type EdgeTradeRow, type EdgeTradeStatus } from "@/lib/edgeTrades";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

const STATUS_META: Record<EdgeTradeStatus, { cls: string; label: string }> = {
  open: { cls: "bg-blue-500/15 text-blue-200 border-blue-400/40", label: "OPEN" },
  won:  { cls: "bg-emerald-500/15 text-emerald-200 border-emerald-400/50", label: "WON" },
  lost: { cls: "bg-red-500/15 text-red-200 border-red-400/50", label: "LOST" },
  void: { cls: "bg-muted text-muted-foreground border-border", label: "VOID" },
};

const Trades = () => {
  const nav = useNavigate();
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<EdgeTradeRow[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    document.title = "Edge Trades · Weather Edge";
    supabase.auth.getSession().then(({ data }) => {
      if (!data.session) nav("/auth", { replace: true });
    });
  }, [nav]);

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from("edge_trades")
      .select("*")
      .order("created_at", { ascending: false });
    if (error) toast.error(error.message);
    setRows((data ?? []) as EdgeTradeRow[]);
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  const stats = useMemo(() => {
    let open = 0, won = 0, lost = 0, voidc = 0, pnl = 0, staked = 0;
    for (const r of rows) {
      if (r.status === "open") open++;
      else if (r.status === "won") won++;
      else if (r.status === "lost") lost++;
      else voidc++;
      if (r.status !== "open") pnl += Number(r.pnl_usdc ?? 0);
      staked += Number(r.stake_usdc ?? 0);
    }
    return { open, won, lost, void: voidc, pnl, staked, total: rows.length };
  }, [rows]);

  const setStatus = async (id: string, status: EdgeTradeStatus) => {
    setBusyId(id);
    const r = await resolveEdgeTrade({ id, status });
    setBusyId(null);
    if (!r.ok) toast.error(r.error ?? "Update failed");
    else { toast.success(`Marked ${status.toUpperCase()}`); load(); }
  };
  const remove = async (id: string) => {
    if (!confirm("Delete this trade entry?")) return;
    setBusyId(id);
    const r = await deleteEdgeTrade(id);
    setBusyId(null);
    if (!r.ok) toast.error(r.error ?? "Delete failed");
    else { setRows((p) => p.filter((x) => x.id !== id)); }
  };

  return (
    <div className="min-h-screen">
      <header className="border-b border-border bg-background/80 backdrop-blur sticky top-0 z-10">
        <div className="container py-3 flex items-center gap-3">
          <Link to="/momentum" className="text-muted-foreground hover:text-foreground shrink-0"><ArrowLeft className="h-4 w-4" /></Link>
          <BookmarkCheck className="h-4 w-4 text-primary" />
          <h1 className="text-sm font-semibold tracking-wide">Edge Trades Log</h1>
          <div className="ml-auto text-[11px] text-muted-foreground font-mono-num">
            {stats.total} total · {stats.open} open · {stats.won}W / {stats.lost}L · PnL <span className={cn("font-bold", stats.pnl >= 0 ? "text-emerald-400" : "text-red-400")}>${stats.pnl.toFixed(2)}</span>
          </div>
        </div>
      </header>

      <main className="container py-4 sm:py-6 px-2 sm:px-4">
        {loading ? (
          <div className="flex items-center justify-center py-20 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin mr-2" /> Loading…</div>
        ) : rows.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
            No trades logged yet. Use "Mark as traded" on the <Link to="/momentum" className="text-primary underline">Momentum</Link> page,
            or any opportunity with edge ≥15pp will be auto-logged.
          </div>
        ) : (
          <div className="rounded-lg border border-border bg-card overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-[10px] uppercase tracking-wider text-muted-foreground border-b border-border">
                <tr>
                  <th className="text-left px-3 py-2">When</th>
                  <th className="text-left px-3 py-2">Market</th>
                  <th className="text-left px-3 py-2">Outcome</th>
                  <th className="text-right px-3 py-2">Entry</th>
                  <th className="text-right px-3 py-2">Fair</th>
                  <th className="text-right px-3 py-2">Edge</th>
                  <th className="text-right px-3 py-2">Stake</th>
                  <th className="text-right px-3 py-2">Proj T</th>
                  <th className="text-center px-3 py-2">Source</th>
                  <th className="text-center px-3 py-2">Status</th>
                  <th className="text-right px-3 py-2">PnL</th>
                  <th className="text-right px-3 py-2">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const meta = STATUS_META[r.status];
                  const projDisp = r.projected_temp_c != null
                    ? (r.projected_temp_unit === "F" ? (r.projected_temp_c * 9/5 + 32).toFixed(1) + "°F" : r.projected_temp_c.toFixed(1) + "°C")
                    : "—";
                  return (
                    <tr key={r.id} className="border-b border-border/40 hover:bg-surface-2/30">
                      <td className="px-3 py-2 text-muted-foreground font-mono-num">{new Date(r.created_at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</td>
                      <td className="px-3 py-2 max-w-[260px]">
                        <div className="truncate font-medium" title={r.market_question}>{r.market_question}</div>
                        <div className="text-[10px] text-muted-foreground flex items-center gap-1">
                          {r.city ?? "—"}{r.market_slug && (
                            <a href={`https://polymarket.com/event/${r.market_slug}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 hover:text-foreground"><ExternalLink className="h-2.5 w-2.5" /></a>
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-2 font-medium">{r.outcome_label}</td>
                      <td className="px-3 py-2 text-right font-mono-num">{(r.entry_price * 100).toFixed(0)}%</td>
                      <td className="px-3 py-2 text-right font-mono-num">{r.suggested_price != null ? (r.suggested_price * 100).toFixed(0) + "%" : "—"}</td>
                      <td className={cn("px-3 py-2 text-right font-mono-num font-semibold", (r.edge_pp ?? 0) >= 15 ? "text-emerald-400" : "text-foreground")}>{r.edge_pp != null ? (r.edge_pp >= 0 ? "+" : "") + r.edge_pp : "—"}</td>
                      <td className="px-3 py-2 text-right font-mono-num">${Number(r.stake_usdc ?? 0).toFixed(0)}</td>
                      <td className="px-3 py-2 text-right font-mono-num">{projDisp}</td>
                      <td className="px-3 py-2 text-center text-[10px] uppercase text-muted-foreground">{r.source === "auto_edge" ? "AUTO" : "manual"}</td>
                      <td className="px-3 py-2 text-center"><span className={cn("inline-flex px-2 py-0.5 rounded border text-[10px] font-bold", meta.cls)}>{meta.label}</span></td>
                      <td className={cn("px-3 py-2 text-right font-mono-num font-semibold", r.pnl_usdc == null ? "text-muted-foreground" : Number(r.pnl_usdc) >= 0 ? "text-emerald-400" : "text-red-400")}>{r.pnl_usdc != null ? `$${Number(r.pnl_usdc).toFixed(2)}` : "—"}</td>
                      <td className="px-3 py-2 text-right">
                        <div className="inline-flex gap-1">
                          {r.status === "open" && (
                            <>
                              <button onClick={() => setStatus(r.id, "won")} disabled={busyId === r.id} className="rounded border border-emerald-400/50 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-200 px-2 py-0.5 text-[10px] font-bold">WON</button>
                              <button onClick={() => setStatus(r.id, "lost")} disabled={busyId === r.id} className="rounded border border-red-400/50 bg-red-500/10 hover:bg-red-500/20 text-red-200 px-2 py-0.5 text-[10px] font-bold">LOST</button>
                              <button onClick={() => setStatus(r.id, "void")} disabled={busyId === r.id} className="rounded border border-border bg-background hover:bg-surface-2 text-muted-foreground px-2 py-0.5 text-[10px]">VOID</button>
                            </>
                          )}
                          {r.status !== "open" && (
                            <button onClick={() => setStatus(r.id, "open")} disabled={busyId === r.id} className="rounded border border-border bg-background hover:bg-surface-2 text-muted-foreground px-2 py-0.5 text-[10px]">Reopen</button>
                          )}
                          <button onClick={() => remove(r.id)} disabled={busyId === r.id} className="rounded border border-border bg-background hover:bg-red-500/20 hover:border-red-400/50 text-muted-foreground hover:text-red-300 px-1.5 py-0.5"><Trash2 className="h-3 w-3" /></button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </main>
    </div>
  );
};

export default Trades;
