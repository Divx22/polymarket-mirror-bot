-- Weather Edge Trader schema
CREATE TABLE public.weather_markets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  city TEXT NOT NULL,
  latitude NUMERIC NOT NULL,
  longitude NUMERIC NOT NULL,
  market_question TEXT NOT NULL,
  condition_type TEXT NOT NULL DEFAULT 'temperature',
  condition_range TEXT NOT NULL,
  -- structured params used by the forecast engine
  temp_min_c NUMERIC,
  temp_max_c NUMERIC,
  precip_threshold_mm NUMERIC,
  event_time TIMESTAMPTZ NOT NULL,
  polymarket_price NUMERIC,
  polymarket_url TEXT,
  clob_token_id TEXT,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.weather_markets ENABLE ROW LEVEL SECURITY;

CREATE POLICY "own weather_markets read" ON public.weather_markets
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "own weather_markets insert" ON public.weather_markets
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "own weather_markets update" ON public.weather_markets
  FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "own weather_markets delete" ON public.weather_markets
  FOR DELETE USING (auth.uid() = user_id);

CREATE TRIGGER weather_markets_updated
  BEFORE UPDATE ON public.weather_markets
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE INDEX idx_weather_markets_user ON public.weather_markets(user_id, active);

-- Forecast snapshots (one row per source per refresh, latest kept by upsert on (market_id, source))
CREATE TABLE public.weather_forecasts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  market_id UUID NOT NULL REFERENCES public.weather_markets(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  source TEXT NOT NULL, -- 'NOAA' or 'ECMWF'
  probability NUMERIC NOT NULL,
  raw JSONB,
  last_updated TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (market_id, source)
);

ALTER TABLE public.weather_forecasts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "own weather_forecasts read" ON public.weather_forecasts
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "own weather_forecasts insert" ON public.weather_forecasts
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "own weather_forecasts update" ON public.weather_forecasts
  FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "own weather_forecasts delete" ON public.weather_forecasts
  FOR DELETE USING (auth.uid() = user_id);

CREATE INDEX idx_weather_forecasts_market ON public.weather_forecasts(market_id);

-- Signals: append-only history of edge calculations
CREATE TABLE public.weather_signals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  market_id UUID NOT NULL REFERENCES public.weather_markets(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  p_noaa NUMERIC,
  p_ecmwf NUMERIC,
  p_final NUMERIC NOT NULL,
  agreement NUMERIC NOT NULL,
  p_market NUMERIC,
  edge NUMERIC,
  suggested_size_percent NUMERIC,
  confidence_level TEXT, -- low / medium / high
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.weather_signals ENABLE ROW LEVEL SECURITY;

CREATE POLICY "own weather_signals read" ON public.weather_signals
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "own weather_signals insert" ON public.weather_signals
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "own weather_signals delete" ON public.weather_signals
  FOR DELETE USING (auth.uid() = user_id);

CREATE INDEX idx_weather_signals_market ON public.weather_signals(market_id, created_at DESC);