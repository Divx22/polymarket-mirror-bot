

## Soft counter-trend handling: badge + execution gates

Keep WX analysis untouched. Only change visual labeling and execution gating.

### 1. Soft badge (always visible)

In `MomentumBreakouts.tsx`, in the row that renders best value:
- Compute `isCounterTrend = bestValueLabel != null && leaderLabel != null && bestValueLabel !== leaderLabel`.
- When true, append a small badge next to the best-value line: `⚠ counter-trend vs leader`.
- Best value, edge number, and verdict all stay rendered as today. No suppression in `compareToMarket` — the WX projection logic is untouched.

### 2. Auto-log gate (the key change)

Today: `if (bestValueEdge >= 15) autoLog()`.

New gate (block auto-log when):
- `isCounterTrend === true` AND `mode !== "MOMENTUM"`

So:
- MOMENTUM mode → counter-trend auto-logs still allowed (early reversals preserved).
- TRANSITION / CERTAINTY mode → counter-trend auto-logs blocked.
- Non-counter-trend (best value === leader) → always allowed as today.

Applies to both local and external rows. The smart-bid CTA button follows the same gate.

### 3. CERTAINTY-only CTA hide

In CERTAINTY mode (past peak) AND `isCounterTrend === true`:
- Hide the smart-bid CTA button entirely (in addition to the auto-log block from rule 2).
- Best value text + counter-trend badge still render — info preserved, just no trade button.

In TRANSITION mode counter-trend: CTA stays visible (user can still manually act), only auto-log is blocked.

### Files touched

- `src/components/weather/MomentumBreakouts.tsx` — only file. Add `isCounterTrend` derivation, render the badge, gate auto-log call, conditionally hide CTA in CERTAINTY.

### Not touched

- `src/lib/weatherProjection.ts` — no signature change, no veto logic.
- No DB, no edge functions, no scoring/allocator changes.
- WX verdict (AGREE/DISAGREE) and best-value computation unchanged.

### Net behavior on your Toronto case

- 11°C leader (78%, widening, CERTAINTY past peak), 10°C best value STRONG +52.
- Best value still shown: `Best value: 10°C STRONG +52 ⚠ counter-trend vs leader`.
- Auto-log: blocked (counter-trend + CERTAINTY).
- Smart-bid CTA: hidden (CERTAINTY + counter-trend).
- Verdict line still reads `STRONG_DISAGREE — Model 10°C vs market 11°C`.

