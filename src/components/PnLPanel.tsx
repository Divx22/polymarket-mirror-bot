import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { fmtUsd, fmtPrice, fmtNum } from "@/lib/format";
import { RefreshCw, TrendingUp, TrendingDown } from "lucide-react";
import { cn } from "@/lib/utils";

type Bucket = { period: string; realized: number; trades: number };
type Position = {
  asset_id: string;
  market_question: string | null;
  outcome: string | null;
  shares: number;
  avg_cost: number;
  current_price: number | null;
  unrealized: number | null;
};
type Summary = {
  realized_total: number;
  unrealized_total: number;
  net_total: number;
  daily: Bucket[];
  weekly: Bucket[];
  monthly: Bucket[];
  positions: Position[];
  fills_count: number;
};

const pnlClass = (n: number | null | undefined) =>
  n == null
    ? "text-muted-foreground"
    : n > 0
      ? "text-emerald-500"
      : n < 0
        ? "text-rose-500"
        : "text-foreground";

export const PnLPanel = () => {
  const [data, setData] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke("pnl-summary");
      if (error) throw error;
      setData(data as Summary);
    } catch (e) {
      console.error("pnl-summary", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, [load]);

  const renderBuckets = (rows: Bucket[]) => (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Period</TableHead>
          <TableHead className="text-right">Realized</TableHead>
          <TableHead className="text-right">Trades</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.length === 0 ? (
          <TableRow>
            <TableCell colSpan={3} className="text-center text-muted-foreground">
              No realized P&L yet.
            </TableCell>
          </TableRow>
        ) : (
          rows.map((r) => (
            <TableRow key={r.period}>
              <TableCell className="font-mono text-xs">{r.period}</TableCell>
              <TableCell className={cn("text-right font-medium", pnlClass(r.realized))}>
                {fmtUsd(r.realized)}
              </TableCell>
              <TableCell className="text-right text-muted-foreground">{r.trades}</TableCell>
            </TableRow>
          ))
        )}
      </TableBody>
    </Table>
  );

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <TrendingUp className="h-4 w-4 text-primary" />
          P&L
        </CardTitle>
        <Button variant="ghost" size="sm" onClick={load} disabled={loading}>
          <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-3 gap-3">
          <div className="rounded-md border border-border p-3">
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
              Realized
            </div>
            <div className={cn("text-lg font-semibold", pnlClass(data?.realized_total))}>
              {fmtUsd(data?.realized_total ?? 0)}
            </div>
          </div>
          <div className="rounded-md border border-border p-3">
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
              Unrealized
            </div>
            <div className={cn("text-lg font-semibold", pnlClass(data?.unrealized_total))}>
              {fmtUsd(data?.unrealized_total ?? 0)}
            </div>
          </div>
          <div className="rounded-md border border-border p-3">
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Net</div>
            <div
              className={cn(
                "text-lg font-semibold flex items-center gap-1",
                pnlClass(data?.net_total),
              )}
            >
              {(data?.net_total ?? 0) >= 0 ? (
                <TrendingUp className="h-4 w-4" />
              ) : (
                <TrendingDown className="h-4 w-4" />
              )}
              {fmtUsd(data?.net_total ?? 0)}
            </div>
          </div>
        </div>

        <Tabs defaultValue="day">
          <TabsList className="grid grid-cols-3 w-full sm:w-[300px]">
            <TabsTrigger value="day">Daily</TabsTrigger>
            <TabsTrigger value="week">Weekly</TabsTrigger>
            <TabsTrigger value="month">Monthly</TabsTrigger>
          </TabsList>
          <TabsContent value="day">{renderBuckets(data?.daily ?? [])}</TabsContent>
          <TabsContent value="week">{renderBuckets(data?.weekly ?? [])}</TabsContent>
          <TabsContent value="month">{renderBuckets(data?.monthly ?? [])}</TabsContent>
        </Tabs>

        <div>
          <div className="text-xs font-medium text-muted-foreground mb-2">Open positions</div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Market</TableHead>
                <TableHead>Outcome</TableHead>
                <TableHead className="text-right">Shares</TableHead>
                <TableHead className="text-right">Avg</TableHead>
                <TableHead className="text-right">Now</TableHead>
                <TableHead className="text-right">Unrealized</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {!data?.positions?.length ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-muted-foreground">
                    No open positions.
                  </TableCell>
                </TableRow>
              ) : (
                data.positions.map((p) => (
                  <TableRow key={p.asset_id}>
                    <TableCell className="max-w-[260px] truncate text-xs">
                      {p.market_question ?? p.asset_id.slice(0, 10)}
                    </TableCell>
                    <TableCell className="text-xs">{p.outcome ?? "—"}</TableCell>
                    <TableCell className="text-right font-mono text-xs">
                      {fmtNum(p.shares, 2)}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs">
                      {fmtPrice(p.avg_cost)}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs">
                      {fmtPrice(p.current_price)}
                    </TableCell>
                    <TableCell
                      className={cn(
                        "text-right font-mono text-xs font-medium",
                        pnlClass(p.unrealized),
                      )}
                    >
                      {p.unrealized == null ? "—" : fmtUsd(p.unrealized)}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
};
