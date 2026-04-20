CREATE TABLE public.forecast_bias (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  station_code TEXT NOT NULL,
  model_name TEXT NOT NULL,
  forecast_lead_hours INTEGER NOT NULL,
  forecast_temp_c NUMERIC NOT NULL,
  actual_temp_c NUMERIC NOT NULL,
  error_c NUMERIC NOT NULL,
  valid_at TIMESTAMP WITH TIME ZONE NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

CREATE INDEX idx_forecast_bias_station_model ON public.forecast_bias(station_code, model_name, valid_at DESC);

ALTER TABLE public.forecast_bias ENABLE ROW LEVEL SECURITY;

CREATE POLICY "forecast_bias readable by authenticated"
ON public.forecast_bias FOR SELECT
TO authenticated
USING (true);