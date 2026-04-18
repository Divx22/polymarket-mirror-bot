ALTER TABLE public.mm_config
  ADD COLUMN IF NOT EXISTS sell_ladder_rungs INTEGER NOT NULL DEFAULT 4 CHECK (sell_ladder_rungs BETWEEN 1 AND 10),
  ADD COLUMN IF NOT EXISTS sell_ladder_spacing_ticks INTEGER NOT NULL DEFAULT 2 CHECK (sell_ladder_spacing_ticks BETWEEN 1 AND 50);