import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
} from "@/components/ui/dialog";
import { Plus, Loader2, Sparkles } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

type Parsed = {
  question: string;
  city: string | null;
  latitude: number | null;
  longitude: number | null;
  condition_type: "temperature" | "rain" | "other";
  temp_min_c: number | null;
  temp_max_c: number | null;
  precip_threshold_mm: number | null;
  event_time: string | null;
  polymarket_url: string;
  polymarket_price: number | null;
  clob_token_id: string | null;
  condition_range: string;
  missing: string[];
};

const isMissing = (p: Parsed | null, field: string) =>
  !!p && p.missing.includes(field);

export const AddMarketDialog = ({
  userId,
  onAdded,
}: {
  userId: string;
  onAdded: () => void;
}) => {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [analyzing, setAnalyzing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [parsed, setParsed] = useState<Parsed | null>(null);

  const reset = () => {
    setUrl("");
    setParsed(null);
  };

  const analyze = async () => {
    if (!url.trim()) {
      toast.error("Paste a Polymarket URL");
      return;
    }
    setAnalyzing(true);
    try {
      const { data, error } = await supabase.functions.invoke("weather-parse-url", {
        body: { url: url.trim() },
      });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      setParsed(data as Parsed);
      if ((data as Parsed).missing?.length) {
        toast.warning(`Confirm missing: ${(data as Parsed).missing.join(", ")}`);
      } else {
        toast.success("Parsed — review and save");
      }
    } catch (e: any) {
      toast.error(e.message ?? "Parse failed");
    } finally {
      setAnalyzing(false);
    }
  };

  const update = (patch: Partial<Parsed>) => {
    if (!parsed) return;
    const next = { ...parsed, ...patch };
    // recompute missing
    const m: string[] = [];
    if (!next.city) m.push("city");
    if (next.latitude == null || next.longitude == null) m.push("coordinates");
    if (next.condition_type === "temperature" && (next.temp_min_c == null || next.temp_max_c == null)) m.push("temperature_range");
    if (!next.event_time) m.push("event_time");
    next.missing = m;
    next.condition_range = next.condition_type === "temperature"
      ? `${next.temp_min_c?.toFixed(1) ?? "?"}–${next.temp_max_c?.toFixed(1) ?? "?"}°C`
      : next.condition_type === "rain"
        ? `rain ≥ ${next.precip_threshold_mm ?? 0.1}mm`
        : "—";
    setParsed(next);
  };

  const save = async () => {
    if (!parsed) return;
    if (parsed.missing.length) {
      toast.error(`Still missing: ${parsed.missing.join(", ")}`);
      return;
    }
    setSaving(true);
    const { error } = await supabase.from("weather_markets").insert({
      user_id: userId,
      city: parsed.city!,
      latitude: parsed.latitude!,
      longitude: parsed.longitude!,
      market_question: parsed.question,
      condition_type: parsed.condition_type,
      condition_range: parsed.condition_range,
      temp_min_c: parsed.temp_min_c,
      temp_max_c: parsed.temp_max_c,
      precip_threshold_mm: parsed.precip_threshold_mm,
      event_time: parsed.event_time!,
      polymarket_url: parsed.polymarket_url,
      polymarket_price: parsed.polymarket_price,
      clob_token_id: parsed.clob_token_id,
    });
    setSaving(false);
    if (error) { toast.error(error.message); return; }
    toast.success("Market added");
    reset();
    setOpen(false);
    onAdded();
  };

  // datetime-local value helper
  const dtLocal = parsed?.event_time
    ? new Date(parsed.event_time).toISOString().slice(0, 16)
    : "";

  const errCls = (field: string) =>
    isMissing(parsed, field) ? "border-destructive" : "";

  return (
    <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) reset(); }}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus className="h-4 w-4 mr-1" /> Add market
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Add weather market</DialogTitle>
        </DialogHeader>

        <div className="grid gap-3">
          <div>
            <Label>Polymarket URL</Label>
            <div className="flex gap-2 mt-1">
              <Input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://polymarket.com/event/..."
              />
              <Button onClick={analyze} disabled={analyzing}>
                {analyzing ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <Sparkles className="h-3 w-3 mr-1" />}
                Analyze
              </Button>
            </div>
            <p className="text-[11px] text-muted-foreground mt-1">
              Paste any Polymarket weather market URL. We auto-fill everything.
            </p>
          </div>

          {parsed && (
            <div className="border-t border-border pt-3 grid gap-2 text-sm">
              <div>
                <Label>Market question</Label>
                <Input value={parsed.question} onChange={(e) => update({ question: e.target.value })} />
              </div>
              <div className="grid grid-cols-3 gap-2">
                <div>
                  <Label>City {isMissing(parsed,"city") && <span className="text-destructive">*</span>}</Label>
                  <Input className={errCls("city")} value={parsed.city ?? ""} onChange={(e) => update({ city: e.target.value })} />
                </div>
                <div>
                  <Label>Lat {isMissing(parsed,"coordinates") && <span className="text-destructive">*</span>}</Label>
                  <Input className={errCls("coordinates")} value={parsed.latitude ?? ""} onChange={(e) => update({ latitude: e.target.value === "" ? null : Number(e.target.value) })} />
                </div>
                <div>
                  <Label>Lon</Label>
                  <Input className={errCls("coordinates")} value={parsed.longitude ?? ""} onChange={(e) => update({ longitude: e.target.value === "" ? null : Number(e.target.value) })} />
                </div>
              </div>

              {parsed.condition_type === "temperature" ? (
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <Label>Min °C {isMissing(parsed,"temperature_range") && <span className="text-destructive">*</span>}</Label>
                    <Input className={errCls("temperature_range")} value={parsed.temp_min_c ?? ""} onChange={(e) => update({ temp_min_c: e.target.value === "" ? null : Number(e.target.value) })} />
                  </div>
                  <div>
                    <Label>Max °C</Label>
                    <Input className={errCls("temperature_range")} value={parsed.temp_max_c ?? ""} onChange={(e) => update({ temp_max_c: e.target.value === "" ? null : Number(e.target.value) })} />
                  </div>
                </div>
              ) : parsed.condition_type === "rain" ? (
                <div>
                  <Label>Precip threshold (mm)</Label>
                  <Input value={parsed.precip_threshold_mm ?? 0.1} onChange={(e) => update({ precip_threshold_mm: Number(e.target.value) })} />
                </div>
              ) : null}

              <div>
                <Label>Event time (UTC) {isMissing(parsed,"event_time") && <span className="text-destructive">*</span>}</Label>
                <Input
                  type="datetime-local"
                  className={errCls("event_time")}
                  value={dtLocal}
                  onChange={(e) => update({ event_time: e.target.value ? new Date(e.target.value).toISOString() : null })}
                />
              </div>

              <div className="grid grid-cols-2 gap-2 text-xs">
                <div className="bg-surface-2 rounded px-2 py-1">
                  Type: <span className="font-mono-num">{parsed.condition_type}</span>
                </div>
                <div className="bg-surface-2 rounded px-2 py-1">
                  Price: <span className="font-mono-num">{parsed.polymarket_price != null ? `${(parsed.polymarket_price * 100).toFixed(1)}%` : "—"}</span>
                </div>
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => { setOpen(false); reset(); }}>Cancel</Button>
          <Button onClick={save} disabled={!parsed || saving || !!parsed?.missing.length}>
            {saving && <Loader2 className="h-3 w-3 animate-spin mr-1" />}
            Save market
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
