

## Asymmetric post-peak band

Post-peak, the projected mean is already anchored to today's realized high/low. The symmetric `±` band misleads — temp realistically can only stay flat or move *back* toward typical (cooler for max, warmer for min).

### Changes

**1. `src/lib/weatherProjection.ts`** — add `bandUpC` / `bandDownC` (and `sigmaUpC` / `sigmaDownC`) to projection output. Default = symmetric (both = bandC). Post-peak (and when realized-extreme anchor is binding):
- `max` market: `bandUpC = 0.2°C` (re-peak rare), `bandDownC = bandC` (natural cooling).
- `min` market: `bandDownC = 0.2°C` (re-trough rare), `bandUpC = bandC` (warming).

`bucketProbability` and `compareToMarket` updated to use a split-normal: integrate left half with `sigmaDownC`, right half with `sigmaUpC`. Existing `sigmaC` stays as a back-compat symmetric value (= max of the two).

**2. `src/components/weather/MomentumBreakouts.tsx`** — in the projection header, when `bandUpC !== bandDownC`, render `59.7°F (+0.4 / −0.7)` instead of `59.7°F ±0.7°F`. Symmetric case unchanged.

### Files touched

- `src/lib/weatherProjection.ts`
- `src/components/weather/MomentumBreakouts.tsx`

### Out of scope

- No DB, no edge functions, no scoring/allocator changes.
- Pre-peak projections unchanged (still symmetric).

