ALTER TABLE public.weather_markets
  ADD COLUMN IF NOT EXISTS resolution_method TEXT,
  ADD COLUMN IF NOT EXISTS resolution_method_detected_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS resolution_method_notes TEXT;

-- Allowed values: 'rounded', 'floor', 'ceiling', 'unknown'
-- NULL = not yet detected (use rounded fallback)
ALTER TABLE public.weather_markets
  DROP CONSTRAINT IF EXISTS weather_markets_resolution_method_check;
ALTER TABLE public.weather_markets
  ADD CONSTRAINT weather_markets_resolution_method_check
  CHECK (resolution_method IS NULL OR resolution_method IN ('rounded','floor','ceiling','unknown'));