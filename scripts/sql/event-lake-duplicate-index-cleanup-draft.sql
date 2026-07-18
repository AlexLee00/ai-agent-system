-- DRAFT ONLY. No statement in this file is active SQL.
-- Master gate: copy one statement at a time outside every explicit transaction.
-- Before each statement: SET lock_timeout = '5s';
-- Before each statement: SET statement_timeout = '5min';

-- Removal order: zero-use candidates first, expression index last.
-- DROP INDEX CONCURRENTLY IF EXISTS agent.event_lake_new_severity_created_at_idx;
-- DROP INDEX CONCURRENTLY IF EXISTS agent.event_lake_new_tags_idx;
-- DROP INDEX CONCURRENTLY IF EXISTS agent.event_lake_new_team_created_at_idx;
-- DROP INDEX CONCURRENTLY IF EXISTS agent.event_lake_new_created_at_idx;
-- DROP INDEX CONCURRENTLY IF EXISTS agent.event_lake_new_event_type_created_at_idx;
-- DROP INDEX CONCURRENTLY IF EXISTS agent.event_lake_new_expr_idx;

-- Rollback order: reverse the removal order. Run only for an index already removed.
-- CREATE INDEX CONCURRENTLY event_lake_new_expr_idx ON agent.event_lake USING btree (((metadata ->> 'cycle_id'::text)));
-- CREATE INDEX CONCURRENTLY event_lake_new_event_type_created_at_idx ON agent.event_lake USING btree (event_type, created_at DESC);
-- CREATE INDEX CONCURRENTLY event_lake_new_created_at_idx ON agent.event_lake USING btree (created_at DESC);
-- CREATE INDEX CONCURRENTLY event_lake_new_team_created_at_idx ON agent.event_lake USING btree (team, created_at DESC);
-- CREATE INDEX CONCURRENTLY event_lake_new_tags_idx ON agent.event_lake USING gin (tags);
-- CREATE INDEX CONCURRENTLY event_lake_new_severity_created_at_idx ON agent.event_lake USING btree (severity, created_at DESC);
