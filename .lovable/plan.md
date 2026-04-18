
User wants P&L tracking for mirrored (executed) trades, bucketed daily/weekly/monthly, starting now.

## Approach

P&L on Polymarket = (current market price − entry price) × shares held, plus realized P&L when sold. For simplicity and since we're starting fresh, I'll track:

- **Cost basis** per executed BUY: `intended_size × intended_price` (USDC paid)
- **Proceeds** per executed SELL: `intended_size × intended_price` (USDC received)
- **Unrealized P&L**: for open positions (net BUY shares per asset_id), fetch current price from Polymarket CLOB and compute `(current_price − avg_entry) × shares`
- **Realized P&L**: SELL proceeds − weighted-avg cost basis of shares sold

### What I'll build

**1. New edge function `pnl-summary`**
- Input: nothing (uses JWT)
- Reads all `paper_orders` with `status IN ('submitted','filled')` for the user
- Groups fills by `asset_id` to compute positions, avg cost, realized P&L
- Fetches current mid-price from Polymarket CLOB (`/midpoint?token_id=…`) for each open position → unrealized P&L
- Buckets realized P&L by day/week/month using `executed_at`
- Returns `{ daily: [...], weekly: [...], monthly: [...], realized_total, unrealized_total, positions: [...] }`

**2. New `PnLPanel` component on the dashboard**
- Tabs: Day / Week / Month (using existing `tabs.tsx`)
- Each tab shows a simple table: period | realized | trades
- Top row: Realized total, Unrealized total, Net (color-coded green/red)
- Sub-section: Open positions (asset, shares, avg entry, current price, unrealized $)
- Refresh button + auto-refresh every 60s

**3. Placement**
- Add `<PnLPanel />` in `Index.tsx` between `StatsRow` and `ConfigCard`

### Notes
- Only counts trades executed from now on — historical paper-only `simulated` orders are excluded (no real $ moved)
- Prices from CLOB midpoint endpoint (public, no auth needed)
- No DB changes required — all derived from existing `paper_orders`
