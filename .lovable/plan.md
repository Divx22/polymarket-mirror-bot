

## Tighten the projection + verdict + allocator

Four targeted upgrades to the projection engine. No new files; small edits to existing logic.

### 1. Cap late-stage forecast speed (non-linear peak)

In `src/lib/weatherProjection.ts` → `projectPeakTempC`, dampen `forecast_speed` as we approach peak (temps flatten near the high):

```
hours_to_peak < 2  →  forecast_speed × 0.5
hours_to_peak < 1  →  forecast_speed × 0.25
hours_to_peak ≤ 0  →  forecast_speed × 0   (use temp_now)
```

Prevents overshoot on cards inside the final 2 hours.

### 2. Strength-filtered DISAGREE

In `compareToMarket` (same file), split the verdict by edge magnitude on the model's top bucket:

- `STRONG_DISAGREE` — model_top ≠ market_top AND model-top edge ≥ +15pp
- `WEAK_DISAGREE`   — model_top ≠ market_top AND model-top edge < +15pp
- `NEUTRAL` / `AGREE` — unchanged

`MarketVerdict` type expands to: `AGREE | NEUTRAL | WEAK_DISAGREE | STRONG_DISAGREE | UNKNOWN`.

In `src/lib/weather.ts` → `decideAction`, the veto rule tightens:

```
STRONG_DISAGREE → HOLD     (real veto, blocks ADD/ENTER)
WEAK_DISAGREE   → HOLD ADD only; ENTER still allowed if widening + ttp<120m
```

The legacy `weatherState` back-compat field maps `STRONG_DISAGREE → WEAK`, `WEAK_DISAGREE → MODERATE`.

### 3. "Best value" bucket flag

Add to `ProjectionResult`:

```ts
bestValueLabel: string | null   // bucket with highest positive edge (model − market)
bestValueEdge: number | null    // pp
```

Picked from `rows` (only positive edges qualify; null when none).

In `MomentumBreakouts.tsx` projection panel, render a highlighted line above the table:

```
BEST VALUE: 58–59°F  (+32 edge)
```

Styled emerald when `bestValueEdge ≥ 15`, amber when `7–14`, hidden when null.

### 4. Allocator uses model probabilities, not market price

In `MomentumBreakouts.tsx`, the range/center the allocator currently derives from market leader changes to:

```
center_bucket = row with highest modelPct  (from compareToMarket)
range         = center_bucket ± 1 adjacent bucket on each side
```

Falls back to current market-based logic when verdict is `UNKNOWN` (no projection available — Discover/external cards).

### Verdict badge labels

`<VerdictBadge>` gains two states:
- 🟢 AGREE
- 🟡 NEUTRAL
- 🟠 WEAK DISAGREE (amber)
- 🔴 STRONG DISAGREE (red)
- ⚪ n/a

### Files

- **`src/lib/weatherProjection.ts`** — dampen `forecast_speed`, split verdict, add `bestValueLabel`/`bestValueEdge`.
- **`src/lib/weather.ts`** — extend `MarketVerdict` union, update `decideAction` veto + back-compat mapping.
- **`src/components/weather/MomentumBreakouts.tsx`** — new badge states, BEST VALUE line, allocator center switches to model-top bucket.

### Out of scope

- No DB/edge-function changes.
- No changes to scan/sort/stake-size formulas (only the allocator's center selection).
- Discover/external cards keep `UNKNOWN` and the existing market-based allocator path.

