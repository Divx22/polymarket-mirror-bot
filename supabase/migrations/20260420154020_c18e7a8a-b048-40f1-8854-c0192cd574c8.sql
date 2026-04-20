CREATE TABLE public.clv_scores (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  detected_trade_id UUID NOT NULL REFERENCES public.detected_trades(id) ON DELETE CASCADE,
  weather_market_id UUID REFERENCES public.weather_markets(id) ON DELETE SET NULL,
  weather_outcome_id UUID REFERENCES public.weather_outcomes(id) ON DELETE SET NULL,
  asset_id TEXT NOT NULL,
  side TEXT NOT NULL,
  entry_price NUMERIC NOT NULL,
  closing_price NUMERIC NOT NULL,
  clv_cents NUMERIC NOT NULL,
  shares NUMERIC,
  event_time TIMESTAMPTZ,
  scored_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  source TEXT NOT NULL DEFAULT 'polymarket_history',
  notes JSONB,
  UNIQUE (detected_trade_id)
);

CREATE INDEX idx_clv_scores_user ON public.clv_scores(user_id, scored_at DESC);
CREATE INDEX idx_clv_scores_market ON public.clv_scores(weather_market_id);

ALTER TABLE public.clv_scores ENABLE ROW LEVEL SECURITY;

CREATE POLICY "own clv read"
  ON public.clv_scores FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "own clv insert"
  ON public.clv_scores FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "own clv delete"
  ON public.clv_scores FOR DELETE
  USING (auth.uid() = user_id);