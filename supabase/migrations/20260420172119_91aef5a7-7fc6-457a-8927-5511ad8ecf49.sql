CREATE TABLE public.forecast_snapshots (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL,
  market_id uuid NOT NULL REFERENCES public.weather_markets(id) ON DELETE CASCADE,
  station_code text,
  model_name text NOT NULL,
  forecast_temp_c numeric NOT NULL,
  forecast_lead_hours numeric NOT NULL,
  event_time timestamp with time zone NOT NULL,
  taken_at timestamp with time zone NOT NULL DEFAULT now(),
  resolved boolean NOT NULL DEFAULT false,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

ALTER TABLE public.forecast_snapshots ENABLE ROW LEVEL SECURITY;

CREATE POLICY "own snapshots read"
  ON public.forecast_snapshots FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "own snapshots insert"
  ON public.forecast_snapshots FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "own snapshots update"
  ON public.forecast_snapshots FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "own snapshots delete"
  ON public.forecast_snapshots FOR DELETE
  USING (auth.uid() = user_id);

-- Index for the resolver job: find unresolved snapshots whose event has passed
CREATE INDEX idx_forecast_snapshots_unresolved
  ON public.forecast_snapshots (event_time)
  WHERE resolved = false;

-- Index for lookups by market
CREATE INDEX idx_forecast_snapshots_market
  ON public.forecast_snapshots (market_id, model_name, taken_at DESC);

-- Allow authenticated users to insert into forecast_bias (currently no insert policy)
CREATE POLICY "forecast_bias insert by authenticated"
  ON public.forecast_bias FOR INSERT
  TO authenticated
  WITH CHECK (true);