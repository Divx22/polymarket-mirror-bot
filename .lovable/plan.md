

## Anchor projection to today's realized extreme so far

**Problem**: For a "highest temp today" market, the model projects only forward from `temperature_now`. If the daily high already happened earlier (e.g. 20°C at 1pm, now 18°C at 3pm with forecast peak at 5pm projecting 19°C), the model wrongly favors the "19°C" bucket. The real daily high is already ≥20°C and locked in for any hour that's already passed. Same issue mirrored for "lowest temp" markets.

**Fix**: Add today's realized extreme so far (from local midnight → now) as a hard floor (for max) / ceiling (for min) on the projected mean. The forward forecast can only push the projection *more* extreme, never less.

### Changes

**1. `src/lib/openMeteo.ts` / `src/lib/weather.ts`** — extend the snapshot
- Add `today_high_so_far_c` and `today_low_so_far_c` to `WeatherSnapshotLike`.
- When fetching Open-Meteo hourly data, compute `max`/`min` of the temp series for hours `[local_midnight, now]` in the market's timezone. This data is already in the response we pull — no extra API call.

**2. `src/lib/weatherProjection.ts` — `projectPeakTempC`**
- After computing `meanC` from forward path + adjustments + drift, apply a realized-extreme anchor:
  ```ts
  if (extreme === "max" && s.today_high_so_far_c != null) {
    if (s.today_high_so_far_c > meanC) {
      meanC = s.today_high_so_far_c;
      // Realized portion of the day is certain → tighten band
      bandC = Math.min(bandC, 0.6);
      sigmaC = bandC / 1.96;
    }
  }
  if (extreme === "min" && s.today_low_so_far_c != null) {
    if (s.today_low_so_far_c < meanC) {
      meanC = s.today_low_so_far_c;
      bandC = Math.min(bandC, 0.6);
      sigmaC = bandC / 1.96;
    }
  }
  ```
- This is independent of the existing `pastPeak` collapse (that handles "we're past the forecast peak hour"). The new logic handles "the realized extreme so far already exceeds what we project forward" — which can fire even before the forecast peak hour.

**3. UI surfacing — `MomentumBreakouts.tsx`**
- Add a small line in the diagnostics row (next to "now X°C · peak (in Yh) Z°C") showing the realized extreme:
  - For max: `· today high so far W°C` (only show when W > peak projection or when relevant)
  - For min: `· today low so far W°C`
- Helps the user see *why* the model now agrees with the market's "20°C" pricing.

### Out of scope
- No DB changes (snapshot is computed client-side per scan).
- No edge function changes.
- No changes to discovery, scoring, or allocator.
- Does not affect markets where forward forecast naturally exceeds realized so far (the common case) — only kicks in when realized > projected forward.

### Why this is safe
- It only ever pushes the projection *more extreme* (toward the realized side), never less. So it can't cause the model to under-estimate.
- It correctly converges with the past-peak collapse: late in the day, both anchors agree on "today's realized high."
- For markets early in the day with little history (e.g. 6am for a daily-high market), `today_high_so_far_c` is just the current temp or slightly above, so the anchor is non-binding.

