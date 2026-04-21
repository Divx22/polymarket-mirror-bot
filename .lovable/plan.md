

## Decision engine on momentum cards

Add an **action badge** (`ENTER` / `ADD` / `HOLD` / `TRIM`) to every momentum card. The current scan/sort/UI stays exactly as is — this is a layer on top.

### Inputs we already have per card
- `gap2h`, `gap1h`, `gapNow`, `leaderNow` — already computed
- `time_to_peak_minutes` — derive from existing `peakWeatherTimeMs(eventTime, city, lat, lon)`

### New input: volume confirmation
Polymarket CLOB exposes per-token trade history. Add a small fetch that pulls the last ~25 minutes of trades for the leader token and buckets them into two 10-minute windows:

```
volume_last_10m = sum(usdc) over [now-10m, now]
volume_prev_10m = sum(usdc) over [now-20m, now-10m]
```

Endpoint: `https://clob.polymarket.com/data/trades?market=<tokenId>&limit=500` (cheap, public, same origin pattern as the existing `prices-history` fetch). If unavailable for a token, treat `volume_change = 0` (neutral).

This fetch runs once per card during scan, in the same batched loop — no extra round trips per render.

### Decision logic (exact spec the user provided)

```text
momentum_1   = gap_1h - gap_2h
momentum_2   = gap_now - gap_1h
acceleration = momentum_2 - momentum_1
volume_change = volume_last_10m - volume_prev_10m
gap_direction = gap_now > gap_1h ? "widening" : "shrinking"

Priority (top wins):
1. TRIM  : shrinking OR acceleration < -0.05 OR volume_change < 0
2. ADD   : widening AND acceleration > 0 AND volume_change > 0 AND ttp < 120
3. ENTER : widening AND gap_now > 0.15 AND ttp < 120
4. HOLD  : otherwise
```

Note: spec uses cents (`gap_now > 15`, `acceleration < -5`). Per project memory ("momentum UI in percentages"), thresholds are stored as 0–1 (`0.15`, `-0.05`) and the engine works on the same units already in `Movement`.

Confidence (0–100): weighted blend of `|acceleration|`, `|volume_change|` magnitude, gap size, and time-to-peak proximity. Clamped 0–100.

Reason: short auto-generated string, e.g. *"gap widening, acceleration +3%, volume rising"* or *"acceleration slowing, volume flat"*.

### UI

A new compact badge row inside each card, just under the trajectory chip:

```text
┌──────────────────────────────────────────────┐
│ [ADD] 78%  gap widening, accel +3%, vol ↑   │
└──────────────────────────────────────────────┘
```

Badge color:
- `ENTER` blue, `ADD` emerald, `HOLD` amber, `TRIM` red

Available on **local cards** (have full data). External (Discover) cards show only `ENTER` vs `HOLD` (no acceleration/volume → degraded mode), or just hide the badge — your call; default: show with a "limited data" tooltip.

### Files

- `src/lib/weather.ts` — add `decideAction({ gap2h, gap1h, gapNow, volPrev, volLast, ttpMinutes })` returning `{ action, confidence, reason }`. Pure function, unit-testable.
- `src/components/weather/MomentumBreakouts.tsx`
  - Add `fetchRecentVolume(tokenId)` returning `{ last10m, prev10m }` (Polymarket trades endpoint).
  - In the scan loop, call it once per leader and store `volLast`/`volPrev` on `Movement`.
  - Render new `<ActionBadge>` inside each card using `decideAction(...)`.
- `src/test/decideAction.test.ts` (optional) — small vitest covering the 4 branches.

### Out of scope
- No DB changes
- No edge-function changes
- Existing momentum score / sort / stake-size logic untouched
- Discover external cards: degraded badge (gap-only) — no extra Polymarket calls from the edge function

