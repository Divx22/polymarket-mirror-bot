

## Weather → Market bucket matcher (the "is the leader actually right?" panel)

Replace the generic `WX: STRONG/WEAK` badge with a **real comparison** between projected peak temperature and the market's top 4 priced buckets. The card answers: *"based on live + forecast weather, where will the temp actually land — and is the market's #1 bucket overpriced or underpriced?"*

### What you'll see on each card

```
PROJECTED PEAK: 58.2°F  ±1.8°F  (in 3h 12m)
─────────────────────────────────────────────
            Market   Model    Edge
58–59°F      22%  →   54%   ✅ +32  ← projection lands here
56–57°F      62%  →   28%   ⚠️ −34  ← MARKET OVERPRICED
60–61°F       4%  →   12%      +8
54–55°F      10%  →    5%      −5
─────────────────────────────────────────────
WX VERDICT: DISAGREE  (market #1 ≠ model #1)
```

- **Projected peak**: linear extrapolation `temperature_now + forecast_speed × hours_to_peak`, converted to °F for display.
- **Confidence band (±)**: width derived from cloud cover + wind: `base 1°F + (cloud_cover/100)×1.5°F + (wind/30)×1°F`, capped 1–4°F. Clear/calm → tight; cloudy/windy → wide.
- **Model %**: probability mass of a Normal(`projection`, `band/1.96` as σ) inside each bucket's `[bucket_min_c, bucket_max_c]`. Computed in °C using the existing outcome fields.
- **Top 4 buckets**: outcomes already sorted by display order; we re-sort by market price desc and take top 4.
- **Edge**: `model_pct − market_pct` (signed percentage points, integer).

### WX badge becomes a verdict

Replaces the current `STRONG/MODERATE/WEAK` badge:
- 🟢 **AGREE** — model's #1 bucket == market's #1 bucket AND |edge on market #1| ≤ 10pp
- 🟡 **NEUTRAL** — same #1 bucket but model materially lower (edge ≤ −10pp), or projection falls on a bucket boundary
- 🔴 **DISAGREE** — model's #1 bucket ≠ market's #1 bucket (the big signal — market is on the wrong temperature)
- ⚪ **n/a** — no weather snapshot or no `bucket_min_c/max_c` on outcomes (external/Discover cards)

### Decision rule changes (in `decideAction`)

The verdict feeds the existing engine, replacing the old `weatherState`:
```
shrinking                        → TRIM
acceleration < −5%               → TRIM
widening + accel>0 + AGREE       → ADD
widening + DISAGREE              → HOLD          (veto, was: WEAK)
widening + ttp < 120 min         → ENTER
otherwise                        → HOLD
```

Hard rule: **never ADD when the market and model disagree on the leading bucket.**

### Files

- **`src/lib/weatherProjection.ts`** *(new)* — pure helpers, fully unit-testable:
  - `projectPeakTempC(snapshot, hoursToPeak)` → `{ mean, band }` in °C
  - `bucketProbability(meanC, sigmaC, minC, maxC)` → 0–1 (uses error-function approximation for Normal CDF)
  - `compareToMarket(projection, outcomesTop4)` → `{ rows: {label, marketPct, modelPct, edge}[], verdict: "AGREE"|"NEUTRAL"|"DISAGREE"|"UNKNOWN" }`
  - `cToF(c)` for display

- **`src/lib/weather.ts`** — change `decideAction` input from `weatherState` to `marketVerdict: "AGREE"|"NEUTRAL"|"DISAGREE"|"UNKNOWN"` (keep the field name `weatherState` on the returned `ActionDecision` for back-compat with consumers, but populate it with the verdict). Update veto rule to fire on `DISAGREE`. Keep `classifyMode` unchanged.

- **`src/components/weather/MomentumBreakouts.tsx`**:
  - Compute `hoursToPeak` from `peakWeatherTimeMs(market)` (already imported) and pass to `projectPeakTempC`.
  - Pass top-4 outcomes (sorted by live mid desc, falling back to `polymarket_price`) into `compareToMarket`.
  - Replace `<WeatherBadge>` with `<VerdictBadge>` (AGREE/NEUTRAL/DISAGREE/n/a) using same pill style.
  - Add a new collapsible block under the action row: **"Peak projection vs market"** showing the 4-row table above. Collapsed by default to keep card height; expands on click.
  - External (Discover) cards: no coords + no buckets → verdict `UNKNOWN`, table hidden.

- **`src/components/weather/MomentumBreakouts.tsx` tooltip cleanup** — old WX raw-metrics tooltip moves onto the projection header (hover `PROJECTED PEAK` to see `temp_speed`, `forecast_speed`, cloud %, precip, humidity, wind).

### Out of scope

- No DB or edge-function changes; all projection math runs in the browser using already-fetched data.
- No changes to scoring, sort, stake-size, or Discover flow.
- Bucket math handles the existing `bucket_min_c/bucket_max_c` schema only — outcomes without buckets fall through to `UNKNOWN`.

