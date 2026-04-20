ALTER TABLE public.weather_markets
  ADD COLUMN IF NOT EXISTS resolution_station_code text,
  ADD COLUMN IF NOT EXISTS resolution_station_name text,
  ADD COLUMN IF NOT EXISTS resolution_lat numeric,
  ADD COLUMN IF NOT EXISTS resolution_lon numeric;

ALTER TABLE public.config
  ADD COLUMN IF NOT EXISTS max_trade_pct numeric NOT NULL DEFAULT 2;