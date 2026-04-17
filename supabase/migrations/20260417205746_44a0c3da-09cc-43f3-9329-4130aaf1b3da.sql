
-- Profiles table (auto-created on signup)
CREATE TABLE public.profiles (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own profile read" ON public.profiles FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "own profile update" ON public.profiles FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "own profile insert" ON public.profiles FOR INSERT WITH CHECK (auth.uid() = user_id);

-- updated_at trigger function
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql SET search_path = public;

CREATE TRIGGER profiles_updated_at BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Auto-create profile on signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (user_id, display_name)
  VALUES (NEW.id, COALESCE(NEW.raw_user_meta_data->>'display_name', split_part(NEW.email, '@', 1)));
  INSERT INTO public.config (user_id) VALUES (NEW.id);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Config table (one row per user)
CREATE TABLE public.config (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  target_wallet TEXT,
  enabled BOOLEAN NOT NULL DEFAULT false,
  last_seen_ts BIGINT NOT NULL DEFAULT 0,
  last_polled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.config ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own config read" ON public.config FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "own config update" ON public.config FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "own config insert" ON public.config FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE TRIGGER config_updated_at BEFORE UPDATE ON public.config
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Now create the auth trigger (after config exists)
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- Detected trades
CREATE TABLE public.detected_trades (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  tx_hash TEXT NOT NULL,
  trade_ts BIGINT NOT NULL,
  side TEXT NOT NULL,
  market_id TEXT,
  market_question TEXT,
  outcome TEXT,
  asset_id TEXT NOT NULL,
  price NUMERIC,
  size NUMERIC,
  usdc_size NUMERIC,
  raw JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, tx_hash, asset_id, side)
);
ALTER TABLE public.detected_trades ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own trades read" ON public.detected_trades FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "own trades insert" ON public.detected_trades FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE INDEX idx_detected_trades_user_ts ON public.detected_trades(user_id, trade_ts DESC);

-- Paper orders
CREATE TABLE public.paper_orders (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  detected_trade_id UUID REFERENCES public.detected_trades(id) ON DELETE CASCADE,
  side TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  market_id TEXT,
  market_question TEXT,
  outcome TEXT,
  intended_price NUMERIC,
  intended_size NUMERIC,
  intended_usdc NUMERIC,
  status TEXT NOT NULL DEFAULT 'simulated',
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.paper_orders ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own orders read" ON public.paper_orders FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "own orders insert" ON public.paper_orders FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE INDEX idx_paper_orders_user_created ON public.paper_orders(user_id, created_at DESC);

-- Markets cache (shared)
CREATE TABLE public.markets_cache (
  asset_id TEXT NOT NULL PRIMARY KEY,
  market_id TEXT,
  question TEXT,
  outcome TEXT,
  data JSONB,
  cached_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.markets_cache ENABLE ROW LEVEL SECURITY;
CREATE POLICY "markets read all" ON public.markets_cache FOR SELECT USING (auth.role() = 'authenticated');

-- Realtime
ALTER PUBLICATION supabase_realtime ADD TABLE public.detected_trades;
ALTER PUBLICATION supabase_realtime ADD TABLE public.paper_orders;
ALTER PUBLICATION supabase_realtime ADD TABLE public.config;
ALTER TABLE public.detected_trades REPLICA IDENTITY FULL;
ALTER TABLE public.paper_orders REPLICA IDENTITY FULL;
ALTER TABLE public.config REPLICA IDENTITY FULL;
