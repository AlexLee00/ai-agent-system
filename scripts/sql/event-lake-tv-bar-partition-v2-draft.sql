-- DRAFT ONLY. Do not apply without a master-approved maintenance plan.
-- This sidecar design is deferred until tv.bar exceeds the promotion trigger in
-- docs/platform/EVENT_LAKE_RETENTION_POLICY.md. The production table is not
-- altered by the TASK-0076 implementation or smoke test.

CREATE TABLE agent.event_lake_tv_bar_v2 (
  id bigint NOT NULL DEFAULT nextval('agent.event_lake_id_seq'::regclass),
  event_type text NOT NULL,
  team text NOT NULL DEFAULT 'general',
  bot_name text NOT NULL DEFAULT 'unknown',
  severity text NOT NULL DEFAULT 'info',
  trace_id text,
  title text NOT NULL DEFAULT '',
  message text NOT NULL DEFAULT '',
  tags text[] NOT NULL DEFAULT ARRAY[]::text[],
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  feedback_score numeric,
  feedback text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at),
  CHECK (event_type LIKE 'luna.tv.bar.%')
) PARTITION BY RANGE (created_at);

DO $draft_partitions$
DECLARE
  month_offset integer;
  partition_start timestamptz;
  partition_end timestamptz;
  partition_name text;
BEGIN
  FOR month_offset IN 0..2 LOOP
    partition_start := date_trunc('month', CURRENT_TIMESTAMP, 'UTC')
      + make_interval(months => month_offset);
    partition_end := partition_start + INTERVAL '1 month';
    partition_name := 'event_lake_tv_bar_v2_' || to_char(partition_start, 'YYYYMM');
    EXECUTE format(
      'CREATE TABLE agent.%I PARTITION OF agent.event_lake_tv_bar_v2 FOR VALUES FROM (%L) TO (%L)',
      partition_name,
      partition_start,
      partition_end
    );
  END LOOP;
END
$draft_partitions$;

CREATE TABLE agent.event_lake_tv_bar_v2_default
  PARTITION OF agent.event_lake_tv_bar_v2 DEFAULT;

CREATE INDEX event_lake_tv_bar_v2_type_created_idx
  ON agent.event_lake_tv_bar_v2 (event_type, created_at DESC);

-- Cutover, dual-write, backfill, archive verification, partition detach/drop,
-- and rollback are intentionally operational steps, not migration-side actions.
