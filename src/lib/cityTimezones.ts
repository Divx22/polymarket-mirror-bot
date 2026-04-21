// City → IANA timezone mapping for displaying market close times
// in the local timezone of the city being traded.
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
  "austin": "America/Chicago",
  "denver": "America/Denver",
  "phoenix": "America/Phoenix",
  "dallas": "America/Chicago",
  "houston": "America/Chicago",
  "philadelphia": "America/New_York",
  "atlanta": "America/New_York",
  "minneapolis": "America/Chicago",
  "washington dc": "America/New_York",
  "dc": "America/New_York",
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
  // Asia
  "tokyo": "Asia/Tokyo",
  "seoul": "Asia/Seoul",
  "beijing": "Asia/Shanghai",
  "shanghai": "Asia/Shanghai",
  "hong kong": "Asia/Hong_Kong",
  "singapore": "Asia/Singapore",
  "mumbai": "Asia/Kolkata",
  "delhi": "Asia/Kolkata",
  "lucknow": "Asia/Kolkata",
  "dubai": "Asia/Dubai",
  // Oceania
  "sydney": "Australia/Sydney",
  // South America
  "rio de janeiro": "America/Sao_Paulo",
  "buenos aires": "America/Argentina/Buenos_Aires",
  "sao paulo": "America/Sao_Paulo",
};

export const tzForCity = (city: string | null | undefined): string | null => {
  if (!city) return null;
  return CITY_TIMEZONES[city.toLowerCase().trim()] ?? null;
};

// Format a UTC timestamp in a city's local timezone, e.g. "12:00 AM JST".
export const formatLocalCloseTime = (
  isoTime: string | null | undefined,
  city: string | null | undefined,
): string | null => {
  if (!isoTime) return null;
  const tz = tzForCity(city);
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

// Compute UTC ms for the next occurrence of a given local hour in the city's timezone,
// constrained to be on/before the close time. Default peak = 16:00 (4 PM) local.
export const peakWeatherTimeMs = (
  closeIso: string | null | undefined,
  city: string | null | undefined,
  peakHourLocal = 16,
): number | null => {
  if (!closeIso) return null;
  const tz = tzForCity(city);
  if (!tz) return null;
  const closeMs = Date.parse(closeIso);
  if (!Number.isFinite(closeMs)) return null;

  // Find the local Y/M/D of the close time in the city tz.
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(closeMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
  const y = get("year"), m = get("month"), d = get("day");

  // Build the UTC instant that corresponds to (y-m-d, peakHour:00:00) in tz.
  const guess = Date.UTC(y, m - 1, d, peakHourLocal, 0, 0);
  const off = (() => {
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    const p = dtf.formatToParts(new Date(guess));
    const g = (t: string) => Number(p.find((x) => x.type === t)?.value ?? "0");
    const asUtc = Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second"));
    return asUtc - guess;
  })();
  return guess - off;
};

// Format a UTC ms instant in city local time, e.g. "4:00 PM JST".
export const formatLocalHour = (
  ms: number | null | undefined,
  city: string | null | undefined,
): string | null => {
  if (ms == null) return null;
  const tz = tzForCity(city);
  if (!tz) return null;
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hour: "numeric", minute: "2-digit", timeZoneName: "short",
    }).format(new Date(ms));
  } catch { return null; }
};
