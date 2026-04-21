

## Tighten WX projection: full forecast path + adjustments + confidence

Builds on the prior approved plan (full hourly path, peak interpolation, °F unification) with four upgrades.

### 1. Full path to peak (unchanged from prior plan)

- `src/lib/openMeteo.ts`: extend `OpenMeteoSnapshot` with `forecast_path: { hour_offset, temp_c, cloud, precipitation, humidity, wind }[]` (next ~8 hours).
- `src/lib/weatherProjection.ts`: interpolate `forecast_path` linearly to land exactly on `hoursToPeak`. Drop the `<2h × 0.5` / `<1h × 0.25` damping hacks.

### 2. Proportional weather adjustments (replaces static thresholds)

In `projectPeakTempC`, evaluate at the **peak hour**:

```ts
const cloudAdj  = ((peakCloud - 50) / 100) * -0.4;       // smooth, signed
const precipAdj = Math.min(peakPrecip, 2) * -0.2;        // 0 to -0.4
const humAdj    = peakHumidity > 80 ? -0.1 : 0;
let totalAdj = cloudAdj + precipAdj + humAdj;
totalAdj = Math.max(-0.8, Math.min(0.8, totalAdj));      // cap ±0.8°C
meanC += totalAdj;
```

### 3. Forecast-vs-reality mismatch check

Compare what the model said *would* happen this past hour vs what *did* happen:

```ts
const realSpeed     = snapshot.temperature_now - (snapshot.temperature_1h_ago ?? snapshot.temperature_now);
const forecastSpeed = (snapshot.temp_forecast_1h ?? snapshot.temperature_now) - snapshot.temperature_now;
const mismatch      = Math.abs(realSpeed - forecastSpeed);   // °C
const forecastDrift = mismatch > 0.5;                        // flag
```

When `forecastDrift` is true, widen the band by +0.5°F equivalent (so verdict is more cautious).

### 4. Curve-shape awareness (early plateau)

If the forecast flattens before peak, reduce the projected mean:

```ts
// indices roughly bracketing hoursToPeak
const a = path[Math.floor(hoursToPeak)];
const b = path[Math.ceil(hoursToPeak)];
if (a && b && Math.abs(a.temp_c - b.temp_c) < 0.2) {
  meanC -= 0.3;   // plateau detected: don't push to fresh high
}
```

### 5. Confidence score (new output)

Extend `ProjectionResult` with `confidence: number` (0–100):

```ts
const bandF = bandC * 9/5;
let confidence = Math.round(100 - bandF * 15);
if (forecastDrift) confidence -= 20;
if (plateauDetected) confidence -= 5;
confidence = Math.max(0, Math.min(100, confidence));
```

Also expose `forecastDrift: boolean` and `plateauDetected: boolean` on the result for the UI.

### 6. UI: unify units + show new diagnostics

In `src/components/weather/MomentumBreakouts.tsx` WX box `wxSourceLine`:

```
Open-Meteo {city} · now {°F} · peak ({ttp}) {°F} · cloud {peakCloud}% · precip {peakPrecip}mm · wind {peakWind}km/h · conf {confidence}%
```

Append small flags when set: `⚠ forecast drift` and/or `≈ plateau`. Tooltip in header stays °C for power-user diagnostics.

### Files touched

- `src/lib/openMeteo.ts` — `forecast_path` field.
- `src/lib/weatherProjection.ts` — interpolation, proportional adjustments, drift + plateau detection, `confidence` field.
- `src/components/weather/MomentumBreakouts.tsx` — `wxSourceLine` rewrite using peak-hour values + confidence + flags.

### Out of scope

- No verdict-threshold, allocator, smart-bid, or stake-size changes.
- No DB / edge-function work.
- Discover/external rows still show their existing "no snapshot" reason.

