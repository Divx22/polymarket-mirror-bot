UPDATE public.mm_config SET default_min_existing_spread_ticks = 3, updated_at = now();
ALTER TABLE public.mm_config ALTER COLUMN default_min_existing_spread_ticks SET DEFAULT 3;