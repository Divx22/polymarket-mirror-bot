CREATE TABLE public.edge_trades (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  market_slug TEXT,
  market_question TEXT NOT NULL,
  city TEXT,
  event_time TIMESTAMPTZ,
  outcome_label TEXT NOT NULL,
  clob_token_id TEXT,
  bucket_min_c NUMERIC,
  bucket_max_c NUMERIC,
  side TEXT NOT NULL DEFAULT 'YES',
  entry_price NUMERIC NOT NULL,
  suggested_price NUMERIC,
  edge_pp NUMERIC,
  p_model NUMERIC,
  projected_temp_c NUMERIC,
  projected_temp_unit TEXT DEFAULT 'C',
  stake_usdc NUMERIC NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open',
  actual_temp_c NUMERIC,
  exit_price NUMERIC,
  pnl_usdc NUMERIC,
  resolved_at TIMESTAMPTZ,
  source TEXT NOT NULL DEFAULT 'manual',
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_on DATE GENERATED ALWAYS AS ((created_at AT TIME ZONE 'UTC')::date) STORED
);

CREATE UNIQUE INDEX edge_trades_auto_dedup
  ON public.edge_trades (user_id, clob_token_id, created_on)
  WHERE source = 'auto_edge' AND clob_token_id IS NOT NULL;

CREATE INDEX edge_trades_user_status_idx ON public.edge_trades (user_id, status, created_at DESC);

ALTER TABLE public.edge_trades ENABLE ROW LEVEL SECURITY;

CREATE POLICY "own edge_trades read"   ON public.edge_trades FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "own edge_trades insert" ON public.edge_trades FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "own edge_trades update" ON public.edge_trades FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "own edge_trades delete" ON public.edge_trades FOR DELETE USING (auth.uid() = user_id);

CREATE TRIGGER trg_edge_trades_updated_at
BEFORE UPDATE ON public.edge_trades
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();