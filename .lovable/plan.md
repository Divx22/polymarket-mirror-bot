

## Fix misleading "Model 0%" + tight band on long-horizon markets

**The Manila case**: now 27.7°C, peak in 12h 30m, buckets shown 34°C / 35°C. Model band is ±0.7°C (computed from cloud+wind only). Buckets sit ~10σ from the mean → both round to 0%. Two real problems:

### Problem 1 — Band ignores time-to-peak
A 12h forecast is fundamentally less certain than a 1h forecast. Current formula in `projectPeakTempC` (`src/lib/weatherProjection.ts`):
```
bandF = 1 + (cloud/100)*1.5 + (wind/30)*1   // capped 1–4
```
No time term. Result: ±0.7°C for a 12h-out market is unrealistically tight.

**Fix**: add a √hours term so uncertainty grows with horizon.
```
hoursTerm = min(2.0, sqrt(max(0, hoursToPeak)) * 0.4)
bandF = clamp(1 + cloud_part + wind_part + hoursTerm, 1, 6)
```
At h=1 → +0.4°F, at h=4 → +0.8°F, at h=12 → +1.4°F (capped). Manila band would go from ±0.7°C to ~±1.5°C — still says model strongly disagrees with 34°C, but no longer absurdly tight.

### Problem 2 — "0% / 0%" rows look like a bug
When all displayed buckets have <1% model mass, the row reads "0%" with no indication that the model is saying "peak won't reach this range at all." Two small UX fixes in `MomentumBreakouts.tsx` (`ProjectionPanel` table):

- Show `<1%` instead of `0%` when raw mass is >0 but rounds to zero, and `≈0%` when truly negligible (<0.1%).
- Add a one-line note above the table when **all** displayed buckets get <5% model mass: `"Model projects ~27.7°C — well below all listed buckets. Market is pricing a much hotter peak than the forecast supports."` This makes the disagreement legible instead of looking broken.

### Problem 3 — Verdict logic with all-tiny-model-mass
When `modelTopLabel`'s actual probability is e.g. 0.3% but it still "wins" by being least-zero, calling it the "Model #1" bucket is misleading. Add a guard in `compareToMarket`:
- If the top model bucket has raw probability < 5%, set verdict to `STRONG_DISAGREE` (model says none of these are likely) and set `modelTopLabel = null`. UI then renders "Model: out of range" instead of a fake winner.

### Files touched

- `src/lib/weatherProjection.ts`
  - `projectPeakTempC`: add `hoursTerm` to band calc.
  - `compareToMarket`: detect "all buckets tiny" → STRONG_DISAGREE + null model top.
  - Return raw (un-normalized) top model mass on `ProjectionResult` so UI can show the warning.
- `src/components/weather/MomentumBreakouts.tsx`
  - `ProjectionPanel`: render `<1%` / `≈0%`, show "out of range" note when applicable, handle null `modelTopLabel` in verdict title.

### Out of scope

- No changes to drift/bias logic, confidence formula, allocator, or trade logging.
- Not expanding the bucket table beyond top 4 (separate question).
- No DB / edge-function work.

### Won't this hurt edge?

No — it makes the model **more honest**. Right now a 12h-out projection with ±0.7°C band overstates confidence and could mislead the verdict on closer-in markets too. Widening the band on long horizons brings band ↔ confidence into alignment with reality. Manila will still show STRONG_DISAGREE (correctly), and the user will see *why* instead of seeing "0% / 0%" and wondering if the model crashed.

