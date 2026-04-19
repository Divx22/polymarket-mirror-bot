DO $$
DECLARE
  job RECORD;
BEGIN
  FOR job IN
    SELECT jobid, jobname FROM cron.job
    WHERE command ILIKE '%mm-cycle%' OR jobname ILIKE '%mm-cycle%' OR jobname ILIKE '%mm_cycle%'
  LOOP
    PERFORM cron.unschedule(job.jobid);
    RAISE NOTICE 'Unscheduled job: % (id %)', job.jobname, job.jobid;
  END LOOP;
END $$;