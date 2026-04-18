-- Extend config table with live-trading controls
ALTER TABLE public.config
  ADD COLUMN IF NOT EXISTS auto_execute boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS max_usdc_per_trade numeric NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS daily_usdc_limit numeric NOT NULL DEFAULT 50,
  ADD COLUMN IF NOT EXISTS usdc_spent_today numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS spent_day date NOT NULL DEFAULT current_date;

-- Extend paper_orders with execution result columns
ALTER TABLE public.paper_orders
  ADD COLUMN IF NOT EXISTS executed_tx_hash text,
  ADD COLUMN IF NOT EXISTS executed_at timestamptz,
  ADD COLUMN IF NOT EXISTS error text;

-- Allow users to UPDATE their own paper_orders (executor needs this)
DROP POLICY IF EXISTS "own orders update" ON public.paper_orders;
CREATE POLICY "own orders update"
ON public.paper_orders
FOR UPDATE
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

-- Cached Polymarket L2 API credentials per user
CREATE TABLE IF NOT EXISTS public.poly_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE,
  api_key text NOT NULL,
  api_secret text NOT NULL,
  api_passphrase text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.poly_credentials ENABLE ROW LEVEL SECURITY;

-- Only the owner can read; writes happen via service role from edge functions
CREATE POLICY "own creds read"
ON public.poly_credentials
FOR SELECT
USING (auth.uid() = user_id);

CREATE TRIGGER update_poly_credentials_updated_at
BEFORE UPDATE ON public.poly_credentials
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();