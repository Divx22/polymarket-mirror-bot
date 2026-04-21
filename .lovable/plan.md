

## Add real weather as a decision filter on momentum cards

Layer Open-Meteo data + a weather score onto the existing `decideAction` engine. Existing logic, sort, scan, and UI stay intact — only the action rules and two new badges change.

### What you'll see

Each momentum card gains **two new pill badges** next to the current action badge:

```
[ENTER 78%] [MODE: MOMENTUM 🟢] [WEATHER: STRONG 🟢]  gap widening, accel +3%, vol ↑
```

- **MODE** (driven by time-to-peak):
  - `MOMENTUM` 🟢 when ttp > 30 min
  - `TRANSITION` 🟡 when 0 ≤ ttp ≤ 30 min
  - `CERTAINTY` 🔵 when peak already passed
- **WEATHER** (driven by live + 1h-ahead Open-Meteo):
  - `STRONG` 🟢 / `MODERATE` 🟡 / `WEAK` 🔴
  - Tooltip shows `temp_speed`, `forecast_speed`, cloud %, precip, humidity, wind, and the numeric weather_score.

### Decision rules (new, additive)

Updated priority inside `decideAction`:

```text
1. shrinking            → TRIM
2. acceleration < -5%   → TRIM
3. widening + accel>0 + weather=STRONG → ADD
4. widening + weather=WEAK             → HOLD       (NEW: weather veto)
5. widening + ttp < 120 min            → ENTER
6. otherwise                           → HOLD
```

Hard rule: **never ADD when weather=WEAK**, even if volume/acceleration look good.

### Weather fetch (Open-Meteo, no key)

`https://api.open-meteo.com/v1/forecast?latitude=…&longitude=…&hourly=temperature_2m,cloudcover,relativehumidity_2m,precipitation,windspeed_10m&current_weather=true&timezone=auto`

- One fetch per local card (uses `market.latitude/longitude`); cached in component state for 10 min.
- External (Discover) cards use coords when present, otherwise weather=`UNKNOWN` and the badge shows `n/a` — they remain in degraded mode.

Extracted: `temperature_now`, `temperature_1h_ago`, `temp_forecast_1h`, `cloud_cover`, `precipitation`, `humidity`, `wind_speed` → derived `temp_speed`, `forecast_speed`, `weather_score`, `weather_state`.

Weather score per spec:
```
cloud<30:+2, 30–70:+1, >70:-2
precip>0:-3, humidity>75:-1, wind>20:-1
```

State per spec (uses °C; Open-Meteo defaults to metric, no conversion needed):
```
STRONG   : temp_speed≥0.5 AND forecast_speed≥0.5 AND score≥1
MODERATE : temp_speed≥0.3 AND score≥0
WEAK     : otherwise
```

### Files

- **`src/lib/weather.ts`** — extend `decideAction` to accept `weatherState?: "STRONG"|"MODERATE"|"WEAK"|"UNKNOWN"` and `mode?: "MOMENTUM"|"TRANSITION"|"CERTAINTY"`. Add helpers: `computeWeatherScore(...)`, `classifyWeather(...)`, `classifyMode(ttpMinutes)`. Apply the WEAK→HOLD veto and surface `mode` + `weather_state` in the returned `ActionDecision`.
- **`src/lib/openMeteo.ts`** *(new)* — `fetchOpenMeteoSnapshot(lat, lon)` returning the seven extracted fields; in-memory 10-min LRU cache keyed by `lat,lon` rounded to 2 dp.
- **`src/components/weather/MomentumBreakouts.tsx`**
  - In the scan batch, after volume fetch, also call `fetchOpenMeteoSnapshot(m.latitude, m.longitude)` and store on `Movement`.
  - Pass `weatherState` and `mode` into `decideAction`.
  - Add `<ModeBadge>` and `<WeatherBadge>` next to existing `<ActionBadge>` in `Row` and `ExternalRow` (external uses `UNKNOWN` when no coords).
- **`src/test/decideAction.test.ts`** *(optional)* — extend with WEAK-veto and mode cases.

### Out of scope

- No DB or edge-function changes (Open-Meteo is called from the browser, same pattern as the existing CLOB fetches).
- No changes to scoring/sort/stake-size logic.
- No persistence of weather snapshots (recomputed each scan, like volume).

