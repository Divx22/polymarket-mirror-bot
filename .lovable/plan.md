

## Add directional drift bias to WX projection

Currently `forecastDrift` is a boolean that only widens the band and lowers confidence — it doesn't shift the projection. This adds **direction**: if reality is running cooler/hotter than the model said it would, push the mean and bucket probabilities the same way.

### 1. Compute signed drift in `projectPeakTempC`

In `src/lib/weatherProjection.ts`, replace the existing drift block:

```ts
let peakBias: "LOWER" | "HIGHER" | "NEUTRAL" = "NEUTRAL";
let forecastDrift = false;
if (s.temperature_1h_ago != null && s.temp_forecast_1h != null) {
  const realSpeed = s.temperature_now - s.temperature_1h_ago;
  const forecastSpeed = s.temp_forecast_1h - s.temperature_now;
  const drift = realSpeed - forecastSpeed;
  if (drift < -0.5) peakBias = "LOWER";
  else if (drift > 0.5) peakBias = "HIGHER";
  forecastDrift = peakBias !== "NEUTRAL";
}
```

### 2. Apply directional shift to mean

After the plateau adjustment, before computing the band:

```ts
if (peakBias === "LOWER") meanC -= 0.3;
else if (peakBias === "HIGHER") meanC += 0.3;
```

This replaces the current symmetric band-widening as the *primary* drift response. Band still widens (+0.5°F) when bias is non-neutral so confidence still drops.

### 3. Return `peakBias` from `projectPeakTempC`

Extend its return type with `peakBias: "LOWER" | "HIGHER" | "NEUTRAL"` and propagate to `ProjectionResult`.

### 4. Boost bucket probabilities by direction in `compareToMarket`

After computing `rawModel[]` (probability per top bucket) and **before** normalizing to `modelSum`, apply a +10% multiplicative boost to buckets on the bias side of the projected mean:

```ts
if (proj.peakBias !== "NEUTRAL") {
  rawModel.forEach((p, i) => {
    const b = top[i];
    const bucketMid = b.bucket_min_c != null && b.bucket_max_c != null
      ? (b.bucket_min_c + b.bucket_max_c) / 2
      : (b.bucket_min_c ?? b.bucket_max_c ?? proj.meanC);
    const isLower = bucketMid < proj.meanC;
    const isHigher = bucketMid > proj.meanC;
    if (proj.peakBias === "LOWER" && isLower) rawModel[i] = p * 1.10;
    if (proj.peakBias === "HIGHER" && isHigher) rawModel[i] = p * 1.10;
  });
}
```

Renormalization to `modelSum` then preserves the shifted distribution. **Critically: market prices are never consulted for direction** — boost is purely a function of bucket midpoint vs projected mean.

### 5. UI: surface bias in the WX line

In `src/components/weather/MomentumBreakouts.tsx`, append to the existing flag area (next to `⚠ forecast drift` / `≈ plateau`):

- `↓ bias lower` when `peakBias === "LOWER"`
- `↑ bias higher` when `peakBias === "HIGHER"`

Keep the existing `⚠ forecast drift` flag as-is (now equivalent to `peakBias !== "NEUTRAL"`).

### Files touched

- `src/lib/weatherProjection.ts` — drift → `peakBias`, directional mean shift, bucket-prob boost, expose on `ProjectionResult`.
- `src/components/weather/MomentumBreakouts.tsx` — render bias arrows in WX source line.

### Out of scope

- No changes to verdict thresholds, smart-bid sizing, auto-log rule, or trade logging.
- No DB / edge-function work.
- Confidence formula unchanged (still penalizes `forecastDrift`).

