

## Plan: Volume Filter + Favorite Mismatch Signal

### 1. Database migration
Add columns:
- `weather_markets.event_volume_24h numeric`
- `weather_signals`: `market_favorite_label text`, `market_favorite_price numeric`, `model_favorite_label text`, `model_favorite_prob numeric`, `favorite_mismatch boolean`
- `config.min_volume_usd numeric default 25000`

### 2. Edge function — `weather-refresh-market`
- Pull `volume24hr` (event-level) from Polymarket gamma API → store on `weather_markets.event_volume_24h`.
- After computing outcomes, derive and persist on the new `weather_signals` row:
  - `market_favorite_label` / `market_favorite_price` (highest `polymarket_price`)
  - `model_favorite_label` / `model_favorite_prob` (highest `p_model`)
  - `favorite_mismatch` (labels differ)

### 3. `src/lib/weather.ts`
Extend `WeatherMarket` with `event_volume_24h` and `WeatherSignal` with the four new fields. Add a `formatVolume($25k / $1.2M)` helper.

### 4. `src/pages/Weather.tsx`
- Header: add **Min Volume $** input (binds to `config.min_volume_usd`) and **Mismatches only** toggle, next to Bankroll.
- Load `min_volume_usd` from config.
- Add **Volume** column to table (formatted).
- Filter logic: hide rows where `best_edge ≥ 7%` AND `event_volume_24h < min_volume_usd` (untradeable). Keep rows with no edge visible regardless.
- Apply mismatches-only toggle as additional filter.
- Sort: `favorite_mismatch DESC` → `best_edge DESC` → `event_volume_24h DESC`.
- Mismatch rows: subtle emerald-tinted background + small "⚡ Mismatch" badge inside the Best Trade cell.

### 5. `src/components/weather/TradeDetailDialog.tsx`
New "Market vs Model" block above the outcomes table:
```text
Model says:    [Outcome A] (62%)
Market says:   [Outcome B] (48¢)
⚠ The market is betting on a different outcome than the forecast.
```
Warning line only when mismatch is true.

### 6. `src/components/weather/BestTradeSignal.tsx`
When the surfaced top trade has `favorite_mismatch=true`, prepend a one-line banner: "Market favorite is **[X]** — your model disagrees."

### 7. `src/components/weather/PositionCalculator.tsx`
Add a `MinVolumeInput` sibling to `BankrollInput` (same pattern, writes to `config.min_volume_usd`).

### Out of scope (intentional)
- Per-outcome volume (Polymarket data unreliable).
- Dedicated "Mismatch" column (redundant with row highlight + badge on 390px viewport).
- Existing 7% edge floor + confidence filter remain untouched.

### Files touched
- New migration
- `supabase/functions/weather-refresh-market/index.ts`
- `src/lib/weather.ts`
- `src/pages/Weather.tsx`
- `src/components/weather/TradeDetailDialog.tsx`
- `src/components/weather/BestTradeSignal.tsx`
- `src/components/weather/PositionCalculator.tsx`

