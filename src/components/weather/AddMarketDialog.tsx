import { useEffect, useState } from "react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, PlusCircle, Sparkles, AlertCircle } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";

type ParsedOutcome = {
  label: string;
  sub_market_question: string | null;
  clob_token_id: string | null;
  condition_id: string | null;
  bucket_min_c: number | null;
  bucket_max_c: number | null;
  polymarket_price: number | null;
  display_order: number;
};

type Parsed = {
  question: string;
  city: string | null;
  latitude: number | null;
  longitude: number | null;
  condition_type: string;
  event_time: string | null;
  polymarket_url: string;
  event_slug: string | null;
  outcomes: ParsedOutcome[];
  missing: string[];
};

export const AddMarketDialog = ({
  userId,
  onAdded,
}: {
  userId: string;
  onAdded: () => void;
}) => {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [parsing, setParsing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [parsed, setParsed] = useState<Parsed | null>(null);
  const [city, setCity] = useState("");
  const [eventTime, setEventTime] = useState("");

  useEffect(() => {
    if (!open) {
      setUrl(""); setParsed(null); setCity(""); setEventTime("");
    }
  }, [open]);

  async function handleAnalyze() {
    if (!url.trim()) return;
    setParsing(true);
    try {
      const { data, error } = await supabase.functions.invoke("weather-parse-url", { body: { url } });
      if (error) throw error;
      if ((data as any)?.error) throw new Error((data as any).error);
      const p = data as Parsed;
      setParsed(p);
      setCity(p.city ?? "");
      setEventTime(p.event_time ? p.event_time.slice(0, 16) : "");
    } catch (e: any) {
      toast.error(e.message ?? "Failed to parse URL");
    } finally {
      setParsing(false);
    }
  }

  async function handleSave() {
    if (!parsed) return;
    if (!city || !parsed.latitude || !parsed.longitude || !eventTime) {
      toast.error("Please fill in all required fields");
      return;
    }
    setSaving(true);
    try {
      const { data: market, error: mErr } = await supabase
        .from("weather_markets")
        .insert({
          user_id: userId,
          city,
          latitude: parsed.latitude,
          longitude: parsed.longitude,
          market_question: parsed.question,
          condition_type: parsed.condition_type,
          event_time: new Date(eventTime).toISOString(),
          polymarket_url: parsed.polymarket_url,
          polymarket_event_slug: parsed.event_slug,
        })
        .select()
        .single();
      if (mErr) throw mErr;

      const rows = parsed.outcomes.map((o) => ({
        market_id: market.id,
        user_id: userId,
        label: o.label,
        bucket_min_c: o.bucket_min_c,
        bucket_max_c: o.bucket_max_c,
        sub_market_question: o.sub_market_question,
        clob_token_id: o.clob_token_id,
        condition_id: o.condition_id,
        polymarket_price: o.polymarket_price,
        display_order: o.display_order,
      }));
      if (rows.length) {
        const { error: oErr } = await supabase.from("weather_outcomes").insert(rows);
        if (oErr) throw oErr;
      }

      // Auto-refresh forecast right after save
      await supabase.functions.invoke("weather-refresh-market", { body: { market_id: market.id } });

      toast.success(`Added market with ${rows.length} outcomes`);
      setOpen(false);
      onAdded();
    } catch (e: any) {
      toast.error(e.message ?? "Failed to save market");
    } finally {
      setSaving(false);
    }
  }

  const isMissing = (k: string) => parsed?.missing?.includes(k);
  const errCls = (k: string) => (isMissing(k) ? "border-destructive/50" : "");

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm"><PlusCircle className="mr-2 h-4 w-4" /> Add market</Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add Polymarket Weather Event</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <Label htmlFor="url">Polymarket Event URL</Label>
            <div className="flex gap-2 mt-1">
              <Input
                id="url"
                placeholder="https://polymarket.com/event/highest-temp-in-toronto-on-april-20"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
              />
              <Button onClick={handleAnalyze} disabled={parsing || !url.trim()}>
                {parsing ? <Loader2 className="animate-spin" /> : <Sparkles />}
                Analyze
              </Button>
            </div>
          </div>

          {parsed && (
            <div className="space-y-3 border-t border-border pt-4">
              <div className="text-sm font-medium">{parsed.question}</div>

              {parsed.missing?.length > 0 && (
                <div className="flex items-start gap-2 p-3 bg-amber-500/10 border border-amber-500/30 rounded text-sm">
                  <AlertCircle className="h-4 w-4 mt-0.5 text-amber-500" />
                  <div>
                    <div className="font-medium text-amber-400">Missing fields</div>
                    <div className="text-muted-foreground">Fill in the highlighted fields below.</div>
                  </div>
                </div>
              )}

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>City</Label>
                  <Input className={errCls("city")} value={city} onChange={(e) => setCity(e.target.value)} />
                </div>
                <div>
                  <Label>Event Time (UTC)</Label>
                  <Input
                    type="datetime-local"
                    className={errCls("event_time")}
                    value={eventTime}
                    onChange={(e) => setEventTime(e.target.value)}
                  />
                </div>
                <div>
                  <Label>Latitude</Label>
                  <Input className={errCls("coordinates")} value={parsed.latitude ?? ""} readOnly />
                </div>
                <div>
                  <Label>Longitude</Label>
                  <Input className={errCls("coordinates")} value={parsed.longitude ?? ""} readOnly />
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between mb-2">
                  <Label>Outcomes ({parsed.outcomes.length})</Label>
                  {isMissing("outcomes") && (
                    <Badge variant="destructive">No outcomes parsed</Badge>
                  )}
                </div>
                <div className="border border-border rounded-md max-h-60 overflow-y-auto divide-y divide-border">
                  {parsed.outcomes.map((o, i) => (
                    <div key={i} className="flex justify-between items-center px-3 py-2 text-sm">
                      <div>
                        <div className="font-medium">{o.label}</div>
                        <div className="text-xs text-muted-foreground">
                          {o.bucket_min_c != null ? `${o.bucket_min_c.toFixed(1)}°C` : "−∞"}
                          {" – "}
                          {o.bucket_max_c != null ? `${o.bucket_max_c.toFixed(1)}°C` : "+∞"}
                        </div>
                      </div>
                      <div className="text-muted-foreground">
                        {o.polymarket_price != null ? `${(o.polymarket_price * 100).toFixed(1)}%` : "—"}
                      </div>
                    </div>
                  ))}
                  {parsed.outcomes.length === 0 && (
                    <div className="px-3 py-4 text-sm text-muted-foreground text-center">No outcomes detected.</div>
                  )}
                </div>
              </div>

              <Button onClick={handleSave} disabled={saving} className="w-full">
                {saving && <Loader2 className="animate-spin mr-2 h-4 w-4" />}
                Save Market & Refresh Forecast
              </Button>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
};
