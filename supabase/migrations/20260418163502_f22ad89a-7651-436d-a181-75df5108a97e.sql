CREATE TABLE IF NOT EXISTS public.mm_fills (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  asset_id TEXT NOT NULL,
  market_question TEXT,
  outcome TEXT,
  side TEXT NOT NULL,
  price NUMERIC NOT NULL,
  shares NUMERIC NOT NULL,
  usdc_value NUMERIC NOT NULL,
  poly_order_id TEXT,
  filled_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mm_fills_user_time ON public.mm_fills(user_id, filled_at DESC);

ALTER TABLE public.mm_fills ENABLE ROW LEVEL SECURITY;

CREATE POLICY "own mm_fills read" ON public.mm_fills
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "own mm_fills insert" ON public.mm_fills
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "own mm_fills delete" ON public.mm_fills
  FOR DELETE USING (auth.uid() = user_id);