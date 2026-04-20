-- 1. Add new columns
ALTER TABLE public.clv_scores
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'qualified',
  ADD COLUMN IF NOT EXISTS edge_at_entry numeric,
  ADD COLUMN IF NOT EXISTS p_model_at_entry numeric;

ALTER TABLE public.clv_scores
  ADD CONSTRAINT clv_scores_kind_check CHECK (kind IN ('qualified', 'sub_threshold'));

-- 2. Make detected_trade_id and closing_price nullable (paper entries have neither at insert time)
ALTER TABLE public.clv_scores
  ALTER COLUMN detected_trade_id DROP NOT NULL,
  ALTER COLUMN closing_price DROP NOT NULL,
  ALTER COLUMN clv_cents DROP NOT NULL;

-- 3. Once-per-outcome-per-day dedupe (only for paper entries — real trades can be many per day)
CREATE UNIQUE INDEX IF NOT EXISTS clv_scores_paper_daily_uniq
  ON public.clv_scores (user_id, weather_outcome_id, ((scored_at AT TIME ZONE 'UTC')::date))
  WHERE detected_trade_id IS NULL;

-- 4. Index for dashboard queries
CREATE INDEX IF NOT EXISTS clv_scores_user_kind_scored_idx
  ON public.clv_scores (user_id, kind, scored_at DESC);

-- 5. Index for the scoring job (find unscored rows whose event has passed)
CREATE INDEX IF NOT EXISTS clv_scores_unscored_idx
  ON public.clv_scores (event_time)
  WHERE closing_price IS NULL;

-- 6. Allow updates so the scoring job can fill in closing_price/clv_cents later
CREATE POLICY "own clv update"
  ON public.clv_scores
  FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);