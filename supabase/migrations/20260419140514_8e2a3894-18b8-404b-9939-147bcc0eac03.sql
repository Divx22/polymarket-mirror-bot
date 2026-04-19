-- Global defaults
ALTER TABLE public.mm_config
  ADD COLUMN IF NOT EXISTS flip_pct numeric NOT NULL DEFAULT 70,
  ADD COLUMN IF NOT EXISTS inventory_pct numeric NOT NULL DEFAULT 30,
  ADD COLUMN IF NOT EXISTS max_inventory_per_market_usdc numeric NOT NULL DEFAULT 50,
  ADD COLUMN IF NOT EXISTS inventory_ladder_pcts numeric[] NOT NULL DEFAULT ARRAY[25,25,50]::numeric[],
  ADD COLUMN IF NOT EXISTS inventory_ladder_ticks integer[] NOT NULL DEFAULT ARRAY[2,3,5]::integer[],
  ADD COLUMN IF NOT EXISTS repost_partial_fills boolean NOT NULL DEFAULT true;

-- Per-market overrides
ALTER TABLE public.mm_markets
  ADD COLUMN IF NOT EXISTS flip_pct_override numeric,
  ADD COLUMN IF NOT EXISTS inventory_pct_override numeric,
  ADD COLUMN IF NOT EXISTS max_inventory_per_market_usdc_override numeric,
  ADD COLUMN IF NOT EXISTS flip_bucket_shares numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS inventory_bucket_shares numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS inventory_avg_cost numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS flip_profit_usdc numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS inventory_profit_usdc numeric NOT NULL DEFAULT 0;

-- Tag fills so we can sum flip vs inventory PnL
ALTER TABLE public.mm_fills
  ADD COLUMN IF NOT EXISTS category text NOT NULL DEFAULT 'flip';
