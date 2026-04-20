-- Replace range-based weather markets with discrete outcome model

-- Drop old tables (cascade kills forecasts/signals tied to old markets)
DROP TABLE IF EXISTS public.weather_signals CASCADE;
DROP TABLE IF EXISTS public.weather_forecasts CASCADE;
DROP TABLE IF EXISTS public.weather_markets CASCADE;

-- Parent: one row per Polymarket event (e.g. "Highest temp in Toronto on Apr 20")
CREATE TABLE public.weather_markets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  city TEXT NOT NULL,
  latitude NUMERIC NOT NULL,
  longitude NUMERIC NOT NULL,
  market_question TEXT NOT NULL,
  condition_type TEXT NOT NULL DEFAULT 'temperature_discrete', -- temperature_discrete | rain | temperature_range
  event_time TIMESTAMPTZ NOT NULL,
  polymarket_url TEXT,
  polymarket_event_slug TEXT,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.weather_markets ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own wm read"   ON public.weather_markets FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "own wm insert" ON public.weather_markets FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "own wm update" ON public.weather_markets FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "own wm delete" ON public.weather_markets FOR DELETE USING (auth.uid() = user_id);

-- One row per discrete outcome (e.g. "3°C", "4°C")
CREATE TABLE public.weather_outcomes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  market_id UUID NOT NULL REFERENCES public.weather_markets(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  label TEXT NOT NULL,                -- e.g. "3°C" or "1°C or below"
  bucket_min_c NUMERIC,               -- inclusive lower bound (null = -inf)
  bucket_max_c NUMERIC,               -- inclusive upper bound (null = +inf)
  sub_market_question TEXT,
  clob_token_id TEXT,
  condition_id TEXT,
  polymarket_price NUMERIC,           -- live YES midpoint
  p_model NUMERIC,                    -- final blended probability
  p_noaa NUMERIC,
  p_ecmwf NUMERIC,
  edge NUMERIC,                       -- p_model - polymarket_price
  suggested_size_percent NUMERIC,
  display_order INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.weather_outcomes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own wo read"   ON public.weather_outcomes FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "own wo insert" ON public.weather_outcomes FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "own wo update" ON public.weather_outcomes FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "own wo delete" ON public.weather_outcomes FOR DELETE USING (auth.uid() = user_id);

CREATE INDEX idx_weather_outcomes_market ON public.weather_outcomes(market_id);

-- Snapshot of refresh runs
CREATE TABLE public.weather_signals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  market_id UUID NOT NULL REFERENCES public.weather_markets(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  agreement NUMERIC NOT NULL,
  confidence_level TEXT,
  best_outcome_label TEXT,
  best_edge NUMERIC,
  best_suggested_size_percent NUMERIC,
  distribution JSONB,                 -- full per-outcome snapshot
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.weather_signals ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own ws read"   ON public.weather_signals FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "own ws insert" ON public.weather_signals FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "own ws delete" ON public.weather_signals FOR DELETE USING (auth.uid() = user_id);

-- updated_at triggers
CREATE TRIGGER trg_wm_updated BEFORE UPDATE ON public.weather_markets
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER trg_wo_updated BEFORE UPDATE ON public.weather_outcomes
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();