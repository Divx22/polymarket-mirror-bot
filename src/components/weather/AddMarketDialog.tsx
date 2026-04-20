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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Plus, Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

export const AddMarketDialog = ({
  userId,
  onAdded,
}: {
  userId: string;
  onAdded: () => void;
}) => {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [city, setCity] = useState("");
  const [lat, setLat] = useState("");
  const [lon, setLon] = useState("");
  const [question, setQuestion] = useState("");
  const [conditionType, setConditionType] = useState("temperature");
  const [tempMin, setTempMin] = useState("");
  const [tempMax, setTempMax] = useState("");
  const [precip, setPrecip] = useState("0.1");
  const [eventTime, setEventTime] = useState("");
  const [url, setUrl] = useState("");
  const [price, setPrice] = useState("");

  const reset = () => {
    setCity(""); setLat(""); setLon(""); setQuestion("");
    setConditionType("temperature"); setTempMin(""); setTempMax("");
    setPrecip("0.1"); setEventTime(""); setUrl(""); setPrice("");
  };

  const range = conditionType === "temperature"
    ? `${tempMin || "?"}–${tempMax || "?"}°C`
    : `rain ≥ ${precip || "0"}mm`;

  const submit = async () => {
    if (!city || !lat || !lon || !question || !eventTime) {
      toast.error("Fill city, coordinates, question, and event time");
      return;
    }
    setSaving(true);
    const { error } = await supabase.from("weather_markets").insert({
      user_id: userId,
      city,
      latitude: Number(lat),
      longitude: Number(lon),
      market_question: question,
      condition_type: conditionType,
      condition_range: range,
      temp_min_c: tempMin ? Number(tempMin) : null,
      temp_max_c: tempMax ? Number(tempMax) : null,
      precip_threshold_mm: precip ? Number(precip) : null,
      event_time: new Date(eventTime).toISOString(),
      polymarket_url: url || null,
      polymarket_price: price ? Number(price) : null,
    });
    setSaving(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Market added");
    reset();
    setOpen(false);
    onAdded();
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
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
          <div className="grid grid-cols-3 gap-2">
            <div className="col-span-3">
              <Label>Market question</Label>
              <Input value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="Will NYC high be 60–65°F on Apr 25?" />
            </div>
            <div>
              <Label>City</Label>
              <Input value={city} onChange={(e) => setCity(e.target.value)} placeholder="NYC" />
            </div>
            <div>
              <Label>Latitude</Label>
              <Input value={lat} onChange={(e) => setLat(e.target.value)} placeholder="40.71" />
            </div>
            <div>
              <Label>Longitude</Label>
              <Input value={lon} onChange={(e) => setLon(e.target.value)} placeholder="-74.01" />
            </div>
            <div className="col-span-3">
              <Label>Condition</Label>
              <Select value={conditionType} onValueChange={setConditionType}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="temperature">Temperature range</SelectItem>
                  <SelectItem value="rain">Rain ≥ threshold</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {conditionType === "temperature" ? (
              <>
                <div>
                  <Label>Min °C</Label>
                  <Input value={tempMin} onChange={(e) => setTempMin(e.target.value)} placeholder="20" />
                </div>
                <div>
                  <Label>Max °C</Label>
                  <Input value={tempMax} onChange={(e) => setTempMax(e.target.value)} placeholder="22" />
                </div>
                <div />
              </>
            ) : (
              <div className="col-span-3">
                <Label>Precip threshold (mm)</Label>
                <Input value={precip} onChange={(e) => setPrecip(e.target.value)} />
              </div>
            )}
            <div className="col-span-3">
              <Label>Event time (UTC)</Label>
              <Input type="datetime-local" value={eventTime} onChange={(e) => setEventTime(e.target.value)} />
            </div>
            <div className="col-span-3">
              <Label>Polymarket URL (optional)</Label>
              <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://polymarket.com/event/..." />
            </div>
            <div className="col-span-3">
              <Label>Current YES price (optional, 0–1)</Label>
              <Input value={price} onChange={(e) => setPrice(e.target.value)} placeholder="0.42" />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={submit} disabled={saving}>
            {saving && <Loader2 className="h-3 w-3 animate-spin mr-1" />}
            Add
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
