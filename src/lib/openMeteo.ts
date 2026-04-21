// Open-Meteo snapshot fetcher with 10-minute in-memory cache.
// No API key required. See https://open-meteo.com/.
//
// When available, today's realized high/low is overridden with values from
// authoritative METAR-based stations (ECCC SWOB / NOAA NWS) — Polymarket
// weather markets resolve on official station data, not gridded forecast.

import { fetchOfficialExtremes } from "./officialStation";

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
  /** Max temperature °C observed since local midnight (in API's local tz) through the current hour. Null when unavailable. */
  today_high_so_far_c: number | null;
  /** Min temperature °C observed since local midnight (in API's local tz) through the current hour. Null when unavailable. */
  today_low_so_far_c: number | null;
  /** Source label for today's extremes. "open-meteo" (gridded) or e.g. "CYYZ" / "KSEA" when overridden by official station. */
  today_extreme_source?: string;
};

/** Result of scanning the forecast path for the temperature extreme between now and event_time. */
export type PeakScan = {
  /** Hours from now to the extreme temperature (≥0). */
  hoursToPeak: number;
  /** Extreme temperature (°C) — argmax for "max", argmin for "min". */
  peakTempC: number;
  /** True when the extreme is the current hour AND temp isn't moving further that direction next hour. */
  pastPeak: boolean;
  /** Wall-clock UTC ms of the extreme hour. */
  peakMs: number;
  /** Which extreme was scanned. */
  extreme: "min" | "max";
};

/**
 * Find the actual temperature extreme within the forecast path, constrained
 * to the window between "now" and `eventTimeIso`.
 *
 * - `extreme="max"` (default): argmax — for "highest temperature" markets.
 * - `extreme="min"`: argmin — for "lowest temperature" / overnight-low markets.
 *
 * Returns null if the snapshot/path is unusable.
 */
export function peakFromForecast(
  snapshot: OpenMeteoSnapshot | null | undefined,
  eventTimeIso: string | null | undefined,
  extreme: "min" | "max" = "max",
): PeakScan | null {
  if (!snapshot || !snapshot.forecast_path || snapshot.forecast_path.length === 0) return null;
  const eventMs = eventTimeIso ? Date.parse(eventTimeIso) : NaN;
  const nowMs = Date.now();
  const maxHours = Number.isFinite(eventMs)
    ? Math.max(0, (eventMs - nowMs) / 3_600_000)
    : Infinity;

  const path = snapshot.forecast_path;
  let bestIdx = 0;
  let bestTemp = extreme === "max" ? -Infinity : Infinity;
  for (let i = 0; i < path.length; i++) {
    const p = path[i];
    if (p.hour_offset > maxHours) break;
    if (!Number.isFinite(p.temp_c)) continue;
    const better = extreme === "max" ? p.temp_c > bestTemp : p.temp_c < bestTemp;
    if (better) {
      bestTemp = p.temp_c;
      bestIdx = i;
    }
  }
  if (!Number.isFinite(bestTemp)) return null;

  const peak = path[bestIdx];
  // "past peak" → extreme is at hour 0 and the next hour isn't more extreme.
  let pastPeak = false;
  if (peak.hour_offset === 0) {
    const next = path[1];
    if (!next || !Number.isFinite(next.temp_c)) pastPeak = true;
    else pastPeak = extreme === "max" ? !(next.temp_c > peak.temp_c) : !(next.temp_c < peak.temp_c);
  }

  return {
    hoursToPeak: Math.max(0, peak.hour_offset),
    peakTempC: peak.temp_c,
    pastPeak,
    peakMs: nowMs + peak.hour_offset * 3_600_000,
    extreme,
  };
}

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

    // Realized extremes since local midnight, through the current hour (inclusive).
    let todayHigh: number | null = null;
    let todayLow: number | null = null;
    if (idx >= 0) {
      const todayPrefix = (curTime || times[idx] || "").slice(0, 10); // "YYYY-MM-DD"
      if (todayPrefix) {
        for (let i = 0; i <= idx && i < times.length; i++) {
          if (!times[i]?.startsWith(todayPrefix)) continue;
          const t = temps[i];
          if (!Number.isFinite(t)) continue;
          if (todayHigh == null || t > todayHigh) todayHigh = t;
          if (todayLow == null || t < todayLow) todayLow = t;
        }
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
      today_high_so_far_c: todayHigh,
      today_low_so_far_c: todayLow,
      today_extreme_source: todayHigh != null || todayLow != null ? "open-meteo" : undefined,
    };

    // Override today extremes with official station data when available.
    // Official METAR/SWOB matches what Polymarket actually resolves on, so it
    // gives the projection a more authoritative anchor than gridded values.
    try {
      const official = await fetchOfficialExtremes(lat, lon);
      if (official) {
        if (official.today_high_so_far_c != null) snap.today_high_so_far_c = official.today_high_so_far_c;
        if (official.today_low_so_far_c != null) snap.today_low_so_far_c = official.today_low_so_far_c;
        snap.today_extreme_source = official.source;
      }
    } catch {
      // Non-fatal — keep gridded values.
    }

    cache.set(key, { at: Date.now(), data: snap });
    return snap;
  } catch {
    cache.set(key, { at: Date.now(), data: null });
    return null;
  }
}
