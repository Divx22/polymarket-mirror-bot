-- positions table: target vs mirror holdings per asset
CREATE TABLE public.positions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  asset_id text NOT NULL,
  market_id text,
  market_question text,
  outcome text,
  target_shares numeric NOT NULL DEFAULT 0,
  mirror_shares numeric NOT NULL DEFAULT 0,
  last_target_price numeric,
  last_reconciled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, asset_id)
);

ALTER TABLE public.positions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "own positions read" ON public.positions
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "own positions insert" ON public.positions
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "own positions update" ON public.positions
  FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "own positions delete" ON public.positions
  FOR DELETE USING (auth.uid() = user_id);

CREATE TRIGGER update_positions_updated_at
  BEFORE UPDATE ON public.positions
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE INDEX idx_positions_user ON public.positions(user_id);

-- mirror config columns
ALTER TABLE public.config
  ADD COLUMN IF NOT EXISTS mirror_mode text NOT NULL DEFAULT 'off',
  ADD COLUMN IF NOT EXISTS mirror_ratio numeric NOT NULL DEFAULT 0.02,
  ADD COLUMN IF NOT EXISTS signal_threshold_usdc numeric NOT NULL DEFAULT 50,
  ADD COLUMN IF NOT EXISTS reconcile_interval_min integer NOT NULL DEFAULT 2;

ALTER TABLE public.config
  ADD CONSTRAINT config_mirror_mode_check
  CHECK (mirror_mode IN ('off','position','signal','fills'));