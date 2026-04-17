
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Remove old job if it exists
DO $$
BEGIN
  PERFORM cron.unschedule('poll-target-wallet-every-min');
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

SELECT cron.schedule(
  'poll-target-wallet-every-min',
  '* * * * *',
  $$
  SELECT net.http_post(
    url := 'https://auqqwxxgjusuwqwxwysu.supabase.co/functions/v1/poll-target-wallet',
    headers := '{"Content-Type":"application/json"}'::jsonb,
    body := '{}'::jsonb
  );
  $$
);
