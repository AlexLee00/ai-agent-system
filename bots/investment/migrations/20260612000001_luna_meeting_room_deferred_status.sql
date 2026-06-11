-- Luna MR-B: allow deferred meeting-room decisions.
-- Additive compatibility migration for DBs that already applied MR-A.

ALTER TABLE investment.luna_meeting_decisions
  DROP CONSTRAINT IF EXISTS luna_meeting_decisions_status_check;

ALTER TABLE investment.luna_meeting_decisions
  ADD CONSTRAINT luna_meeting_decisions_status_check
  CHECK (status IN ('advisory', 'pending_master', 'confirmed', 'deferred'));
