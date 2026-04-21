// Open-Meteo snapshot fetcher with 10-minute in-memory cache.
// No API key required. See https://open-meteo.com/.

export type ForecastPathPoint = {
  hour_offset: number;       // hours from "now" (0 = current hour)
  temp_c: number;
  cloud: number | null;      // %
  precipitation: number | null; // mm
  humidity: number | null;   // %
  wind: number | null;       // km/h
};

export type OpenMeteoSnapshot = {
  temperature_now: number;
  temperature_1h_ago: number | null;
  temp_forecast_1h: number | null;
  cloud_cover: number | null;
  precipitation: number | null;
  humidity: number | null;
  wind_speed: number | null;
  /** Hourly forecast starting at the current hour (hour_offset=0), up to ~8h ahead. */
  forecast_path: ForecastPathPoint[];
};

const TTL_MS = 10 * 60_000;
const cache = new Map<string, { at: number; data: OpenMeteoSnapshot | null }>();

const keyFor = (lat: number, lon: number) =>
  `${lat.toFixed(2)},${lon.toFixed(2)}`;

export async function fetchOpenMeteoSnapshot(
  lat: number | null | undefined,
  lon: number | null | undefined,
): Promise<OpenMeteoSnapshot | null> {
  if (lat == null || lon == null || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const key = keyFor(lat, lon);
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < TTL_MS) return cached.data;

  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=temperature_2m,cloudcover,relativehumidity_2m,precipitation,windspeed_10m&current_weather=true&forecast_days=3&timezone=auto`;
    const r = await fetch(url);
    if (!r.ok) { cache.set(key, { at: Date.now(), data: null }); return null; }
    const j = await r.json();

    const tempNow = Number(j?.current_weather?.temperature);
    const times: string[] = j?.hourly?.time ?? [];
    const temps: number[] = j?.hourly?.temperature_2m ?? [];
    const clouds: number[] = j?.hourly?.cloudcover ?? [];
    const precs: number[] = j?.hourly?.precipitation ?? [];
    const hums: number[] = j?.hourly?.relativehumidity_2m ?? [];
    const winds: number[] = j?.hourly?.windspeed_10m ?? [];

    // Find current hour index by matching current_weather.time (local) against hourly.time.
    const curTime: string = j?.current_weather?.time ?? "";
    let idx = times.indexOf(curTime);
    if (idx < 0) {
      // Fallback: closest hour to now
      const nowMs = Date.now();
      let bestD = Infinity;
      for (let i = 0; i < times.length; i++) {
        const t = Date.parse(times[i]);
        if (!Number.isFinite(t)) continue;
        const d = Math.abs(t - nowMs);
        if (d < bestD) { bestD = d; idx = i; }
      }
    }

    // Build forecast_path: next ~48 hours starting at current hour (offset 0).
    // Long horizon needed so multi-hour-out markets (e.g. peak 12h+ away) can find
    // the actual daytime peak instead of clipping to the last available point.
    const path: ForecastPathPoint[] = [];
    if (idx >= 0) {
      const end = Math.min(temps.length, idx + 49);
      for (let i = idx; i < end; i++) {
        const t = temps[i];
        if (!Number.isFinite(t)) continue;
        path.push({
          hour_offset: i - idx,
          temp_c: t,
          cloud: Number.isFinite(clouds[i]) ? clouds[i] : null,
          precipitation: Number.isFinite(precs[i]) ? precs[i] : null,
          humidity: Number.isFinite(hums[i]) ? hums[i] : null,
          wind: Number.isFinite(winds[i]) ? winds[i] : null,
        });
      }
    }

    const snap: OpenMeteoSnapshot = {
      temperature_now: Number.isFinite(tempNow) ? tempNow : (temps[idx] ?? NaN),
      temperature_1h_ago: idx > 0 ? (Number.isFinite(temps[idx - 1]) ? temps[idx - 1] : null) : null,
      temp_forecast_1h: idx >= 0 && idx + 1 < temps.length && Number.isFinite(temps[idx + 1]) ? temps[idx + 1] : null,
      cloud_cover: idx >= 0 && Number.isFinite(clouds[idx]) ? clouds[idx] : null,
      precipitation: idx >= 0 && Number.isFinite(precs[idx]) ? precs[idx] : null,
      humidity: idx >= 0 && Number.isFinite(hums[idx]) ? hums[idx] : null,
      wind_speed: idx >= 0 && Number.isFinite(winds[idx]) ? winds[idx] : null,
      forecast_path: path,
    };
    cache.set(key, { at: Date.now(), data: snap });
    return snap;
  } catch {
    cache.set(key, { at: Date.now(), data: null });
    return null;
  }
}
