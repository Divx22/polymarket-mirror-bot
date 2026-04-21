

## Why some cards show peak time and others don't

The peak-weather badge only renders when the card's city name is found in the **hardcoded `CITY_TIMEZONES` map** in `src/lib/cityTimezones.ts`. If the city isn't in that ~40-entry list (or the name doesn't match exactly, e.g. "Las Vegas" vs "Vegas", "Kyiv", "Jakarta", "Bangkok", "Cairo", "Vancouver"), `tzForCity` returns `null`, so `peakWeatherTimeMs` returns `null`, and the orange peak badge is hidden.

Right now the map covers ~40 cities. Anything outside that list silently drops the peak timer.

## Fix

Make peak time available for **every** city by replacing the hardcoded lookup with a real geo→timezone resolver, using data we already have on each market (`latitude` / `longitude` from `weather_markets`, plus the resolution station coords for momentum cards).

### Approach

1. **Add `tz-lookup`** (tiny ~50KB lib, offline, lat/lon → IANA timezone). Works for any point on Earth.
2. **Update `src/lib/cityTimezones.ts`**:
   - Add `tzForCoords(lat, lon)` using `tz-lookup`.
   - Change `tzForCity` callers to a new `resolveTz({ city, lat, lon })` that tries coords first, then the city map as fallback, then returns `null`.
   - Update `formatLocalCloseTime`, `peakWeatherTimeMs`, `formatLocalHour` to accept an optional `{ lat, lon }` (or a resolved tz string) instead of just city.
3. **Update `MomentumBreakouts.tsx`**:
   - Pass `latitude` / `longitude` (local markets) and the discovered coords (external rows — these come back from the discover function; if missing, fall back to city-name lookup) into `CountdownBadge` and `CardHeader`.
4. **Light normalization** in the city map (lowercase, strip "city of", common aliases) so the fallback path catches more names too.

### Result

Every card with either coords or a recognizable city shows close-local-time + peak-local-time. The orange peak badge will no longer disappear for Bangkok, Vegas, Kyiv, etc.

### Files

- `src/lib/cityTimezones.ts` — add coord-based resolver, broaden API
- `src/components/weather/MomentumBreakouts.tsx` — pass lat/lon into badge/header
- `package.json` — add `tz-lookup` dependency

### Note (separate, minor)

The console warnings about `forwardRef` on `Snap` / `StakeBar` / `ExternalRow` are unrelated to this issue but I can fix them in the same pass if you want.

