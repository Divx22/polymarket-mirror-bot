// Fetches realized today-high / today-low from authoritative weather stations
// (Polymarket weather markets typically resolve on official METAR/station data,
// not gridded forecast data like Open-Meteo). Used to anchor the projection's
// realized-extreme values when more precise than the grid.
//
// Coverage:
//   - Canada → Environment & Climate Change Canada SWOB-realtime by ICAO id
//   - US     → NOAA NWS api.weather.gov stations/{id}/observations
//
// Station selection is by closest known station to (lat, lon) within a small
// catalog. If no station matches, returns null and the caller should fall back
// to Open-Meteo's gridded today-extreme.

export type OfficialExtremes = {
  today_high_so_far_c: number | null;
  today_low_so_far_c: number | null;
  /** Short label for UI surfacing, e.g. "CYYZ" or "KSEA". */
  source: string;
  /** Country code used to pick the API ("CA" or "US"). */
  country: "CA" | "US";
};

type StationEntry = {
  icao: string;
  lat: number;
  lon: number;
  country: "CA" | "US";
  /** Local timezone offset hours from UTC (negative west). Used to find local midnight. */
  tzOffsetHours: number;
};

// Small curated catalog of stations Polymarket weather markets commonly resolve on.
// Add to this as new cities show up. Coordinates approximate to the airport.
const STATIONS: StationEntry[] = [
  // Canada
  { icao: "CYYZ", lat: 43.6777, lon: -79.6248, country: "CA", tzOffsetHours: -4 }, // Toronto Pearson (EDT)
  { icao: "CYUL", lat: 45.4706, lon: -73.7408, country: "CA", tzOffsetHours: -4 }, // Montréal-Trudeau
  { icao: "CYVR", lat: 49.1947, lon: -123.1839, country: "CA", tzOffsetHours: -7 }, // Vancouver
  { icao: "CYYC", lat: 51.1139, lon: -114.0203, country: "CA", tzOffsetHours: -6 }, // Calgary
  { icao: "CYOW", lat: 45.3225, lon: -75.6692, country: "CA", tzOffsetHours: -4 }, // Ottawa
  // US
  { icao: "KNYC", lat: 40.7831, lon: -73.9712, country: "US", tzOffsetHours: -4 }, // New York Central Park
  { icao: "KJFK", lat: 40.6413, lon: -73.7781, country: "US", tzOffsetHours: -4 },
  { icao: "KLAX", lat: 33.9416, lon: -118.4085, country: "US", tzOffsetHours: -7 },
  { icao: "KSEA", lat: 47.4502, lon: -122.3088, country: "US", tzOffsetHours: -7 }, // Seattle
  { icao: "KORD", lat: 41.9742, lon: -87.9073, country: "US", tzOffsetHours: -5 },
  { icao: "KIAH", lat: 29.9844, lon: -95.3414, country: "US", tzOffsetHours: -5 }, // Houston
  { icao: "KMIA", lat: 25.7959, lon: -80.2870, country: "US", tzOffsetHours: -4 },
  { icao: "KBOS", lat: 42.3656, lon: -71.0096, country: "US", tzOffsetHours: -4 },
  { icao: "KDEN", lat: 39.8561, lon: -104.6737, country: "US", tzOffsetHours: -6 },
  { icao: "KPHX", lat: 33.4373, lon: -112.0078, country: "US", tzOffsetHours: -7 },
];

const haversineKm = (a: { lat: number; lon: number }, b: { lat: number; lon: number }): number => {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const la1 = (a.lat * Math.PI) / 180;
  const la2 = (b.lat * Math.PI) / 180;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
};

/** Pick the closest catalog station within `maxKm`. Returns null when no match. */
function pickStation(lat: number, lon: number, maxKm = 60): StationEntry | null {
  let best: StationEntry | null = null;
  let bestD = Infinity;
  for (const s of STATIONS) {
    const d = haversineKm({ lat, lon }, { lat: s.lat, lon: s.lon });
    if (d < bestD) { bestD = d; best = s; }
  }
  return best && bestD <= maxKm ? best : null;
}

/** Compute the local-midnight UTC ISO timestamp for a station. */
function localMidnightIsoUtc(tzOffsetHours: number): string {
  const nowMs = Date.now();
  // Local time = UTC + tzOffset. Local midnight = floor(localMs / day).
  const localMs = nowMs + tzOffsetHours * 3_600_000;
  const localMidnightLocalMs = Math.floor(localMs / 86_400_000) * 86_400_000;
  const localMidnightUtcMs = localMidnightLocalMs - tzOffsetHours * 3_600_000;
  return new Date(localMidnightUtcMs).toISOString();
}

const TTL_MS = 10 * 60_000;
const cache = new Map<string, { at: number; data: OfficialExtremes | null }>();

async function fetchEcccSwobExtremes(stn: StationEntry): Promise<OfficialExtremes | null> {
  const startIso = localMidnightIsoUtc(stn.tzOffsetHours);
  const endIso = new Date(Date.now() + 60 * 60_000).toISOString();
  // Bounding box ~0.05° around the station to catch its observations.
  const dLat = 0.05;
  const dLon = 0.05;
  const bbox = `${stn.lon - dLon},${stn.lat - dLat},${stn.lon + dLon},${stn.lat + dLat}`;
  const url = `https://api.weather.gc.ca/collections/swob-realtime/items?bbox=${bbox}&datetime=${startIso}/${endIso}&limit=200&f=json`;
  const r = await fetch(url);
  if (!r.ok) return null;
  const j = await r.json();
  const fs: any[] = j?.features ?? [];
  // Prefer manual hourly METAR (id contains "MAN") for the matching ICAO.
  const matching = fs.filter((f) => {
    const id = String(f?.properties?.id ?? f?.id ?? "");
    return id.includes(stn.icao);
  });
  const manOnly = matching.filter((f) => String(f?.properties?.id ?? f?.id ?? "").includes("MAN"));
  const pool = manOnly.length > 0 ? manOnly : matching;
  let hi: number | null = null;
  let lo: number | null = null;
  for (const f of pool) {
    const t = Number(f?.properties?.air_temp);
    if (!Number.isFinite(t)) continue;
    if (hi == null || t > hi) hi = t;
    if (lo == null || t < lo) lo = t;
  }
  if (hi == null && lo == null) return null;
  return { today_high_so_far_c: hi, today_low_so_far_c: lo, source: stn.icao, country: "CA" };
}

async function fetchNwsExtremes(stn: StationEntry): Promise<OfficialExtremes | null> {
  const startIso = localMidnightIsoUtc(stn.tzOffsetHours);
  // NWS api.weather.gov expects a User-Agent. Browser fetch sets one automatically.
  const url = `https://api.weather.gov/stations/${stn.icao}/observations?start=${startIso}&limit=50`;
  const r = await fetch(url, { headers: { Accept: "application/geo+json" } });
  if (!r.ok) return null;
  const j = await r.json();
  const fs: any[] = j?.features ?? [];
  let hi: number | null = null;
  let lo: number | null = null;
  for (const f of fs) {
    const tempProp = f?.properties?.temperature;
    if (!tempProp) continue;
    let t = Number(tempProp.value);
    if (!Number.isFinite(t)) continue;
    if (tempProp.unitCode === "wmoUnit:degF" || tempProp.unitCode === "unit:degF") {
      t = (t - 32) * 5 / 9;
    }
    if (hi == null || t > hi) hi = t;
    if (lo == null || t < lo) lo = t;
  }
  if (hi == null && lo == null) return null;
  return { today_high_so_far_c: hi, today_low_so_far_c: lo, source: stn.icao, country: "US" };
}

/** Fetch realized today high/low from the closest official station, with cache. */
export async function fetchOfficialExtremes(
  lat: number | null | undefined,
  lon: number | null | undefined,
): Promise<OfficialExtremes | null> {
  if (lat == null || lon == null || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const stn = pickStation(lat, lon);
  if (!stn) return null;
  const key = stn.icao;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < TTL_MS) return cached.data;
  try {
    const data = stn.country === "CA" ? await fetchEcccSwobExtremes(stn) : await fetchNwsExtremes(stn);
    cache.set(key, { at: Date.now(), data });
    return data;
  } catch {
    cache.set(key, { at: Date.now(), data: null });
    return null;
  }
}
