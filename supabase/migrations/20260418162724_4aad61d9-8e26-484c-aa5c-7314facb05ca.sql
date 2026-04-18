ALTER TABLE public.mm_config
ADD COLUMN IF NOT EXISTS quote_mode TEXT NOT NULL DEFAULT 'join'
CHECK (quote_mode IN ('inside', 'join', 'passive'));