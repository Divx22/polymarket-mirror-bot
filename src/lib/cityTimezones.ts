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
