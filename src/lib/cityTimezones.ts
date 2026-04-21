// City → IANA timezone mapping (fallback when coords are unavailable).
// Preferred path is `tzForCoords(lat, lon)` which uses tz-lookup and works
// for any point on Earth.
import tzlookup from "tz-lookup";

export const CITY_TIMEZONES: Record<string, string> = {
  // North America
  "new york": "America/New_York",
  "nyc": "America/New_York",
  "los angeles": "America/Los_Angeles",
  "la": "America/Los_Angeles",
  "san francisco": "America/Los_Angeles",
  "sf": "America/Los_Angeles",
  "chicago": "America/Chicago",
  "boston": "America/New_York",
  "miami": "America/New_York",
  "seattle": "America/Los_Angeles",
  "toronto": "America/Toronto",
  "vancouver": "America/Vancouver",
  "montreal": "America/Toronto",
  "austin": "America/Chicago",
  "denver": "America/Denver",
  "phoenix": "America/Phoenix",
  "dallas": "America/Chicago",
  "houston": "America/Chicago",
  "philadelphia": "America/New_York",
  "atlanta": "America/New_York",
  "minneapolis": "America/Chicago",
  "washington dc": "America/New_York",
  "washington": "America/New_York",
  "dc": "America/New_York",
  "las vegas": "America/Los_Angeles",
  "vegas": "America/Los_Angeles",
  "honolulu": "Pacific/Honolulu",
  "anchorage": "America/Anchorage",
  "mexico city": "America/Mexico_City",
  // Europe
  "london": "Europe/London",
  "paris": "Europe/Paris",
  "berlin": "Europe/Berlin",
  "madrid": "Europe/Madrid",
  "rome": "Europe/Rome",
  "moscow": "Europe/Moscow",
  "istanbul": "Europe/Istanbul",
  "ankara": "Europe/Istanbul",
  "kyiv": "Europe/Kyiv",
  "kiev": "Europe/Kyiv",
  "warsaw": "Europe/Warsaw",
  "amsterdam": "Europe/Amsterdam",
  "brussels": "Europe/Brussels",
  "vienna": "Europe/Vienna",
  "stockholm": "Europe/Stockholm",
  "oslo": "Europe/Oslo",
  "copenhagen": "Europe/Copenhagen",
  "helsinki": "Europe/Helsinki",
  "lisbon": "Europe/Lisbon",
  "athens": "Europe/Athens",
  "dublin": "Europe/Dublin",
  "zurich": "Europe/Zurich",
  // Asia
  "tokyo": "Asia/Tokyo",
  "seoul": "Asia/Seoul",
  "beijing": "Asia/Shanghai",
  "shanghai": "Asia/Shanghai",
  "hong kong": "Asia/Hong_Kong",
  "singapore": "Asia/Singapore",
  "bangkok": "Asia/Bangkok",
  "jakarta": "Asia/Jakarta",
  "manila": "Asia/Manila",
  "kuala lumpur": "Asia/Kuala_Lumpur",
  "ho chi minh city": "Asia/Ho_Chi_Minh",
  "hanoi": "Asia/Ho_Chi_Minh",
  "taipei": "Asia/Taipei",
  "mumbai": "Asia/Kolkata",
  "delhi": "Asia/Kolkata",
  "new delhi": "Asia/Kolkata",
  "kolkata": "Asia/Kolkata",
  "bangalore": "Asia/Kolkata",
  "lucknow": "Asia/Kolkata",
  "karachi": "Asia/Karachi",
  "lahore": "Asia/Karachi",
  "dhaka": "Asia/Dhaka",
  "dubai": "Asia/Dubai",
  "abu dhabi": "Asia/Dubai",
  "riyadh": "Asia/Riyadh",
  "doha": "Asia/Qatar",
  "tel aviv": "Asia/Jerusalem",
  "jerusalem": "Asia/Jerusalem",
  "tehran": "Asia/Tehran",
  // Africa
  "cairo": "Africa/Cairo",
  "lagos": "Africa/Lagos",
  "johannesburg": "Africa/Johannesburg",
  "nairobi": "Africa/Nairobi",
  "casablanca": "Africa/Casablanca",
  // Oceania
  "sydney": "Australia/Sydney",
  "melbourne": "Australia/Melbourne",
  "brisbane": "Australia/Brisbane",
  "perth": "Australia/Perth",
  "auckland": "Pacific/Auckland",
  // South America
  "rio de janeiro": "America/Sao_Paulo",
  "buenos aires": "America/Argentina/Buenos_Aires",
  "sao paulo": "America/Sao_Paulo",
  "santiago": "America/Santiago",
  "lima": "America/Lima",
  "bogota": "America/Bogota",
  "caracas": "America/Caracas",
};

const normalizeCity = (s: string): string =>
  s.toLowerCase().trim()
    .replace(/^city of\s+/, "")
    .replace(/\s+/g, " ");

export const tzForCity = (city: string | null | undefined): string | null => {
  if (!city) return null;
  return CITY_TIMEZONES[normalizeCity(city)] ?? null;
};

export const tzForCoords = (
  lat: number | null | undefined,
  lon: number | null | undefined,
): string | null => {
  if (lat == null || lon == null) return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  try {
    return tzlookup(lat, lon);
  } catch {
    return null;
  }
};

// Resolve a timezone from any combination of coords + city name. Coords win.
export const resolveTz = (
  opts: { city?: string | null; lat?: number | null; lon?: number | null },
): string | null => {
  return tzForCoords(opts.lat, opts.lon) ?? tzForCity(opts.city);
};

type LocOpts = { city?: string | null; lat?: number | null; lon?: number | null };

// Format a UTC timestamp in a city's local timezone, e.g. "12:00 AM JST".
export const formatLocalCloseTime = (
  isoTime: string | null | undefined,
  loc: LocOpts | string | null | undefined,
): string | null => {
  if (!isoTime) return null;
  const tz = typeof loc === "string" || loc == null
    ? tzForCity(typeof loc === "string" ? loc : null)
    : resolveTz(loc);
  if (!tz) return null;
  try {
    const d = new Date(isoTime);
    if (!Number.isFinite(d.getTime())) return null;
    return new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    }).format(d);
  } catch {
    return null;
  }
};

// Compute UTC ms for the next occurrence of a given local hour in the resolved tz,
// constrained to be on/before the close time. Default peak = 16:00 (4 PM) local.
export const peakWeatherTimeMs = (
  closeIso: string | null | undefined,
  loc: LocOpts | string | null | undefined,
  peakHourLocal = 16,
): number | null => {
  if (!closeIso) return null;
  const tz = typeof loc === "string" || loc == null
    ? tzForCity(typeof loc === "string" ? loc : null)
    : resolveTz(loc);
  if (!tz) return null;
  const closeMs = Date.parse(closeIso);
  if (!Number.isFinite(closeMs)) return null;

  // Helper: convert a (y,m,d,h) in tz to a UTC ms instant.
  const localToUtc = (y: number, m: number, d: number, h: number): number => {
    const guess = Date.UTC(y, m - 1, d, h, 0, 0);
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    const p = dtf.formatToParts(new Date(guess));
    const g = (t: string) => Number(p.find((x) => x.type === t)?.value ?? "0");
    const asUtc = Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second"));
    return guess - (asUtc - guess);
  };

  // Get today's local date in tz (anchored to "now", not to close).
  const todayParts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const get = (t: string) => Number(todayParts.find((p) => p.type === t)?.value ?? "0");
  let y = get("year"), m = get("month"), d = get("day");

  // Candidate: today's peak hour. If already past it, use tomorrow's.
  let peak = localToUtc(y, m, d, peakHourLocal);
  if (peak <= Date.now()) {
    const next = new Date(Date.UTC(y, m - 1, d) + 86400000);
    peak = localToUtc(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), peakHourLocal);
  }

  // Constrain to be on/before close. If peak is after close, fall back to the
  // most recent peak hour at-or-before close.
  if (peak > closeMs) {
    const closeParts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit",
    }).formatToParts(new Date(closeMs));
    const cg = (t: string) => Number(closeParts.find((p) => p.type === t)?.value ?? "0");
    const cy = cg("year"), cm = cg("month"), cd = cg("day"), ch = cg("hour");
    // If close hour is >= peak hour, peak is same local day; else previous day.
    if (ch >= peakHourLocal) {
      peak = localToUtc(cy, cm, cd, peakHourLocal);
    } else {
      const prev = new Date(Date.UTC(cy, cm - 1, cd) - 86400000);
      peak = localToUtc(prev.getUTCFullYear(), prev.getUTCMonth() + 1, prev.getUTCDate(), peakHourLocal);
    }
  }
  return peak;
};

// Format a UTC ms instant in resolved local time, e.g. "4:00 PM JST".
export const formatLocalHour = (
  ms: number | null | undefined,
  loc: LocOpts | string | null | undefined,
): string | null => {
  if (ms == null) return null;
  const tz = typeof loc === "string" || loc == null
    ? tzForCity(typeof loc === "string" ? loc : null)
    : resolveTz(loc);
  if (!tz) return null;
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hour: "numeric", minute: "2-digit", timeZoneName: "short",
    }).format(new Date(ms));
  } catch { return null; }
};
