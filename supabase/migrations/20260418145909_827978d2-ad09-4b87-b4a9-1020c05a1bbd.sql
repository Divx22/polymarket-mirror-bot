ALTER TABLE public.detected_trades
  ADD COLUMN IF NOT EXISTS order_id text,
  ADD COLUMN IF NOT EXISTS order_original_size numeric,
  ADD COLUMN IF NOT EXISTS order_original_usdc numeric,
  ADD COLUMN IF NOT EXISTS is_partial_fill boolean;