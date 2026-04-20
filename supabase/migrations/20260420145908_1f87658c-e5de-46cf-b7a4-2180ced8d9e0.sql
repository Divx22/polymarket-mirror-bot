ALTER TABLE public.weather_markets ADD COLUMN IF NOT EXISTS event_volume_24h numeric;

ALTER TABLE public.weather_signals
  ADD COLUMN IF NOT EXISTS market_favorite_label text,
  ADD COLUMN IF NOT EXISTS market_favorite_price numeric,
  ADD COLUMN IF NOT EXISTS model_favorite_label text,
  ADD COLUMN IF NOT EXISTS model_favorite_prob numeric,
  ADD COLUMN IF NOT EXISTS favorite_mismatch boolean;

ALTER TABLE public.config ADD COLUMN IF NOT EXISTS min_volume_usd numeric NOT NULL DEFAULT 25000;