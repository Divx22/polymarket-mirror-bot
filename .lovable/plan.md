
Honest answer: the on-chain trade event we read from Polygon **doesn't carry the original order size** — it only emits the matched fill (taker amount, maker amount, price). The "original order" lived only in Polymarket's off-chain CLOB order book before being matched.

To get original order size we'd need to either:

**Option A — Polymarket Data API (`/trades` endpoint).**
Polymarket exposes `https://data-api.polymarket.com/trades?user=<addr>` which returns each trade with extra fields including the order it filled. From there we can call `https://clob.polymarket.com/order/<order_id>` (or the Data API's order endpoint) to fetch the original `size` and `size_matched`. This requires no auth for public data.

**Option B — Index by `order_id` from the on-chain event.**
The Exchange contract's `OrderFilled` event emits an `orderHash`. We can group fills by `orderHash` to at least show "this is fill 3 of N for the same order". But to get the *original posted size* we still need the CLOB API.

**Recommended: Option A.** Cleanest data, one extra HTTP call per trade, cacheable.

### Plan

1. **DB migration** — add nullable columns to `detected_trades`:
   - `order_id text` (Polymarket's order id / hash)
   - `order_original_size numeric` (original size in shares)
   - `order_original_usdc numeric` (original size × price)
   - `is_partial_fill boolean`

2. **Update `poll-target-wallet`** — switch from raw on-chain logs (or augment) to Polymarket Data API `/trades?user=…` which already returns `order_id`, `maker_amount`, `taker_amount`, plus we then GET `/order/{order_id}` to fetch original size. Store all three new fields when inserting.

3. **Update `TradesFeed` UI** — add an "Order" column showing `fill / total` (e.g. `$0.22 / $50.00`) with a small "partial" badge when `is_partial_fill = true`. Tooltip with the order id.

4. **Backfill** — for existing rows, run a one-time enrichment via the same lookup (best-effort, skip if order not found).

### Risks / notes
- Data API may rate-limit; add small delay/batch.
- Some on-chain trades are AMM/sweep matches without a CLOB order id — show "—" in those cases.
- No DB columns exist yet, so this is additive and safe.
