import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader2, MapPin } from "lucide-react";
import { toast } from "sonner";

type Station = {
  city: string;
  station_name: string;
  station_code: string;
  latitude: number;
  longitude: number;
  timezone: string;
};

type Props = {
  marketId: string;
  city: string;
  currentCode: string | null;
  currentName: string | null;
  onChange: () => void;
};

/**
 * Lets you override the resolution station for a single market.
 * Defaults to the city's seeded station; you can pick any seeded station
 * or enter a custom ICAO code + lat/lon for stations Polymarket settles on
 * that we haven't seeded (e.g. KORD instead of KMDW for Chicago).
 */
export const StationOverridePicker = ({ marketId, city, currentCode, currentName, onChange }: Props) => {
  const [open, setOpen] = useState(false);
  const [stations, setStations] = useState<Station[]>([]);
  const [saving, setSaving] = useState(false);
  const [customCode, setCustomCode] = useState("");
  const [customLat, setCustomLat] = useState("");
  const [customLon, setCustomLon] = useState("");

  useEffect(() => {
    if (!open) return;
    supabase.from("stations").select("*").order("city").then(({ data }) => {
      setStations((data ?? []) as Station[]);
    });
  }, [open]);

  const apply = async (
    code: string | null,
    name: string | null,
    lat: number | null,
    lon: number | null,
  ) => {
    setSaving(true);
    const { error } = await supabase
      .from("weather_markets")
      .update({
        resolution_station_code: code,
        resolution_station_name: name,
        resolution_lat: lat,
        resolution_lon: lon,
      })
      .eq("id", marketId);
    setSaving(false);
    if (error) { toast.error(error.message); return; }
    toast.success(code ? `Station set to ${code}` : "Reset to city default");
    setOpen(false);
    onChange();
  };

  const applyCustom = () => {
    const lat = Number(customLat);
    const lon = Number(customLon);
    const code = customCode.trim().toUpperCase();
    if (!code || !Number.isFinite(lat) || !Number.isFinite(lon)) {
      toast.error("Enter ICAO code + valid lat/lon");
      return;
    }
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      toast.error("Coordinates out of range");
      return;
    }
    apply(code, code, lat, lon);
  };

  // Show stations from same city first, then everything else
  const cityStations = stations.filter((s) => s.city.toLowerCase() === city.toLowerCase());
  const otherStations = stations.filter((s) => s.city.toLowerCase() !== city.toLowerCase());

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 px-1.5 gap-1 text-[10px] uppercase tracking-wider text-muted-foreground hover:text-foreground"
          title="Resolution station override"
        >
          <MapPin className="h-3 w-3" />
          {currentCode ?? "default"}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-0" align="end">
        <div className="px-3 py-2 border-b border-border">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
            Resolution station
          </div>
          <div className="text-xs text-foreground mt-0.5">
            Currently: {currentName ? `${currentName} (${currentCode})` : `default for ${city}`}
          </div>
        </div>

        <div className="max-h-64 overflow-y-auto">
          <button
            disabled={saving}
            onClick={() => apply(null, null, null, null)}
            className="w-full text-left px-3 py-2 text-xs hover:bg-surface-2/50 border-b border-border/50"
          >
            <span className="text-muted-foreground">Reset to city default</span>
          </button>
          {cityStations.length > 0 && (
            <>
              <div className="px-3 py-1 text-[9px] uppercase tracking-wider text-muted-foreground bg-surface-2/30">
                Same city
              </div>
              {cityStations.map((s) => (
                <button
                  key={s.station_code}
                  disabled={saving}
                  onClick={() => apply(s.station_code, s.station_name, s.latitude, s.longitude)}
                  className="w-full text-left px-3 py-2 text-xs hover:bg-surface-2/50 border-b border-border/50 flex justify-between gap-2"
                >
                  <span className="truncate">{s.station_name}</span>
                  <span className="font-mono-num text-muted-foreground shrink-0">{s.station_code}</span>
                </button>
              ))}
            </>
          )}
          {otherStations.length > 0 && (
            <>
              <div className="px-3 py-1 text-[9px] uppercase tracking-wider text-muted-foreground bg-surface-2/30">
                Other cities
              </div>
              {otherStations.map((s) => (
                <button
                  key={s.station_code}
                  disabled={saving}
                  onClick={() => apply(s.station_code, s.station_name, s.latitude, s.longitude)}
                  className="w-full text-left px-3 py-2 text-xs hover:bg-surface-2/50 border-b border-border/50 flex justify-between gap-2"
                >
                  <span className="truncate">
                    <span className="text-muted-foreground">{s.city} · </span>
                    {s.station_name}
                  </span>
                  <span className="font-mono-num text-muted-foreground shrink-0">{s.station_code}</span>
                </button>
              ))}
            </>
          )}
        </div>

        <div className="px-3 py-2 border-t border-border space-y-1.5">
          <div className="text-[9px] uppercase tracking-wider text-muted-foreground">
            Custom (ICAO + coords)
          </div>
          <div className="flex gap-1">
            <Input
              placeholder="KORD"
              value={customCode}
              onChange={(e) => setCustomCode(e.target.value)}
              className="h-7 text-xs font-mono-num"
            />
            <Input
              placeholder="lat"
              value={customLat}
              onChange={(e) => setCustomLat(e.target.value)}
              className="h-7 text-xs font-mono-num w-16"
            />
            <Input
              placeholder="lon"
              value={customLon}
              onChange={(e) => setCustomLon(e.target.value)}
              className="h-7 text-xs font-mono-num w-16"
            />
          </div>
          <Button
            size="sm"
            disabled={saving}
            onClick={applyCustom}
            className="w-full h-7 text-xs"
          >
            {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : "Use custom station"}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
};
