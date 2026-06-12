-- Edu-X market-close slot extension
-- Adds kis:1600 and overseas:0630 to edux_publish_log.schedule_slot.
-- Apply manually only after operational approval.

ALTER TABLE edux_publish_log
  DROP CONSTRAINT IF EXISTS edux_publish_log_schedule_slot_check;

ALTER TABLE edux_publish_log
  ADD CONSTRAINT edux_publish_log_schedule_slot_check
  CHECK (schedule_slot IN ('0600', '0630', '0900', '1400', '1600', '2200', '2230'));

COMMENT ON COLUMN edux_publish_log.schedule_slot IS '0600 / 0630 / 0900 / 1400 / 1600 / 2200 / 2230 KST';
