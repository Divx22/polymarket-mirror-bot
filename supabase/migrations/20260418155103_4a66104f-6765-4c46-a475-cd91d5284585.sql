-- Market maker config table: per-user global settings
CREATE TABLE public.mm_config (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE,
  enabled boolean NOT NULL DEFAULT false,
  default_size_usdc numeric NOT NULL DEFAULT 1,
  default_max_inventory_usdc numeric NOT NULL DEFAULT 10,
  default_spread_offset_ticks integer NOT NULL DEFAULT 1,
  default_min_existing_spread_ticks integer NOT NULL DEFAULT 2,
  total_capital_cap_usdc numeric NOT NULL DEFAULT 50,
  min_days_to_expiry integer NOT NULL DEFAULT 7,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.mm_config ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own mm_config read" ON public.mm_config FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "own mm_config insert" ON public.mm_config FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "own mm_config update" ON public.mm_config FOR UPDATE USING (auth.uid() = user_id);

CREATE TRIGGER mm_config_updated_at BEFORE UPDATE ON public.mm_config
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Markets the user is making on
CREATE TABLE public.mm_markets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  asset_id text NOT NULL,
  condition_id text,
  market_question text,
  outcome text,
  end_date date,
  active boolean NOT NULL DEFAULT true,
  size_usdc_override numeric,
  max_inventory_usdc_override numeric,
  spread_offset_ticks_override integer,
  inventory_shares numeric NOT NULL DEFAULT 0,
  inventory_avg_price numeric NOT NULL DEFAULT 0,
  spread_captured_usdc numeric NOT NULL DEFAULT 0,
  last_bid_price numeric,
  last_ask_price numeric,
  last_book_best_bid numeric,
  last_book_best_ask numeric,
  last_cycle_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id, asset_id)
);

ALTER TABLE public.mm_markets ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own mm_markets read" ON public.mm_markets FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "own mm_markets insert" ON public.mm_markets FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "own mm_markets update" ON public.mm_markets FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "own mm_markets delete" ON public.mm_markets FOR DELETE USING (auth.uid() = user_id);

CREATE TRIGGER mm_markets_updated_at BEFORE UPDATE ON public.mm_markets
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Live orders we have on the book (so we can cancel them next cycle)
CREATE TABLE public.mm_open_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  asset_id text NOT NULL,
  poly_order_id text NOT NULL,
  side text NOT NULL,
  price numeric NOT NULL,
  size numeric NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id, poly_order_id)
);

ALTER TABLE public.mm_open_orders ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own mm_open_orders read" ON public.mm_open_orders FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "own mm_open_orders insert" ON public.mm_open_orders FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "own mm_open_orders delete" ON public.mm_open_orders FOR DELETE USING (auth.uid() = user_id);

-- Cycle log for debugging / dashboard
CREATE TABLE public.mm_cycles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  ran_at timestamptz NOT NULL DEFAULT now(),
  markets_processed integer NOT NULL DEFAULT 0,
  orders_placed integer NOT NULL DEFAULT 0,
  orders_cancelled integer NOT NULL DEFAULT 0,
  fills_detected integer NOT NULL DEFAULT 0,
  total_capital_at_risk_usdc numeric NOT NULL DEFAULT 0,
  notes jsonb
);

ALTER TABLE public.mm_cycles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own mm_cycles read" ON public.mm_cycles FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "own mm_cycles insert" ON public.mm_cycles FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE INDEX mm_cycles_user_ran_idx ON public.mm_cycles(user_id, ran_at DESC);
CREATE INDEX mm_open_orders_user_asset_idx ON public.mm_open_orders(user_id, asset_id);

-- Auto-create mm_config row when a profile is created
CREATE OR REPLACE FUNCTION public.handle_new_user_mm()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  INSERT INTO public.mm_config (user_id) VALUES (NEW.id) ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$;

-- Backfill mm_config for existing users
INSERT INTO public.mm_config (user_id)
SELECT user_id FROM public.config
ON CONFLICT (user_id) DO NOTHING;