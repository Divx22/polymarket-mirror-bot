// Frontend port of the edge function's bucket-label parser.
// Extracts °C bounds from human labels like "80-81°F", "26°C", "82°F or higher".

const fToC = (f: number) => ((f - 32) * 5) / 9;

export type ParsedBucket = { min_c: number | null; max_c: number | null };

export function parseBucketLabel(rawLabel: string): ParsedBucket {
  const s = rawLabel.replace(/–/g, "-");

  let m = s.match(/(-?\d+(?:\.\d+)?)\s*-\s*(-?\d+(?:\.\d+)?)\s*°?\s*([FCfc])/);
  if (m) {
    const a = parseFloat(m[1]); const b = parseFloat(m[2]);
    const unit = m[3].toUpperCase();
    const lo = Math.min(a, b); const hi = Math.max(a, b);
    return { min_c: unit === "F" ? fToC(lo) : lo, max_c: unit === "F" ? fToC(hi) : hi };
  }
  m = s.match(/(-?\d+(?:\.\d+)?)\s*°?\s*([FCfc])?\s*(?:or\s+)?(below|less|under|or lower)/i);
  if (m) {
    const v = parseFloat(m[1]); const unit = (m[2] ?? "C").toUpperCase();
    return { min_c: null, max_c: unit === "F" ? fToC(v) : v };
  }
  m = s.match(/(-?\d+(?:\.\d+)?)\s*°?\s*([FCfc])?\s*(?:or\s+)?(above|more|over|or higher)/i);
  if (m) {
    const v = parseFloat(m[1]); const unit = (m[2] ?? "C").toUpperCase();
    return { min_c: unit === "F" ? fToC(v) : v, max_c: null };
  }
  m = s.match(/\b(above|over|>=?|greater than)\s+(-?\d+(?:\.\d+)?)\s*°?\s*([FCfc])?/i);
  if (m) {
    const v = parseFloat(m[2]); const unit = (m[3] ?? "C").toUpperCase();
    return { min_c: unit === "F" ? fToC(v) : v, max_c: null };
  }
  m = s.match(/\b(below|under|<=?|less than)\s+(-?\d+(?:\.\d+)?)\s*°?\s*([FCfc])?/i);
  if (m) {
    const v = parseFloat(m[2]); const unit = (m[3] ?? "C").toUpperCase();
    return { min_c: null, max_c: unit === "F" ? fToC(v) : v };
  }
  // Single-value fallback (e.g. "26°C") → treat as ±0.5° band in the original unit.
  m = s.match(/(-?\d+(?:\.\d+)?)\s*°?\s*([FCfc])/);
  if (m) {
    const v = parseFloat(m[1]); const unit = m[2].toUpperCase();
    const c = unit === "F" ? fToC(v) : v;
    const half = unit === "F" ? fToC(v + 0.5) - c : 0.5;
    return { min_c: c - half, max_c: c + half };
  }
  return { min_c: null, max_c: null };
}

// Lightweight Open-Meteo geocoder with in-memory cache (10-min TTL).
const TTL_MS = 10 * 60_000;
const geoCache = new Map<string, { at: number; data: { lat: number; lon: number } | null }>();

export async function geocodeCity(city: string): Promise<{ lat: number; lon: number } | null> {
  const key = city.trim().toLowerCase();
  if (!key) return null;
  const cached = geoCache.get(key);
  if (cached && Date.now() - cached.at < TTL_MS) return cached.data;
  try {
    const r = await fetch(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=en&format=json`,
    );
    if (!r.ok) { geoCache.set(key, { at: Date.now(), data: null }); return null; }
    const j = await r.json();
    const hit = j?.results?.[0];
    const out = hit ? { lat: Number(hit.latitude), lon: Number(hit.longitude) } : null;
    geoCache.set(key, { at: Date.now(), data: out });
    return out;
  } catch {
    geoCache.set(key, { at: Date.now(), data: null });
    return null;
  }
}
