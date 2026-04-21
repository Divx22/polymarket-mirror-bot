

## Fix: WX verdict using stale prices contradicts the card's leader

### The bug

The card header ranks outcomes using **live Polymarket midpoints** (fetched in the Movement builder at line 231). But the projection panel rebuilds `buckets` from `o.polymarket_price` — the DB-cached price, which can be hours stale.

Result: the "Market #1" the verdict compares against is not the same "Market #1" shown to the user. In your screenshot, model says 80–81°F, the card header agrees the market leader is 80–81°F (62%), yet the verdict tooltip claims "Market #1: 78–79°F" because stale DB rows still rank 78–79°F highest.

### The fix

Carry live mids from the Movement builder into the projection so both the header and the verdict use the same source of truth.

**`src/components/weather/MomentumBreakouts.tsx`**

1. **Extend `Movement`** with `liveMids: Record<string /* outcome.id */, number>` populated from the existing `liveMids` array around line 231 (no extra network calls).
2. **Build `buckets` (line 876) using live mids first**, falling back to `polymarket_price` only if a live mid is missing for that outcome:
   ```ts
   const buckets: BucketLike[] = outs.map((o) => ({
     label: o.label,
     bucket_min_c: o.bucket_min_c,
     bucket_max_c: o.bucket_max_c,
     marketPrice: m.liveMids?.[o.id] ?? o.polymarket_price,
   }));
   ```
3. **No changes** to `weatherProjection.ts`, `decideAction`, or external/Discover rows (they already use the right path).

### Why this is enough

- Same prices feed both the visible "80–81°F vs 82–83°F" header and the verdict's top-4 sort.
- When a live mid is unavailable for some outcome, the fallback to DB price keeps the row instead of dropping the bucket.
- AGREE/DISAGREE will then reflect what the user actually sees.

### Out of scope

- No DB writes (we're not refreshing `polymarket_price` rows here — that's the scanner's job).
- No changes to projection math, sizing, or badges.

