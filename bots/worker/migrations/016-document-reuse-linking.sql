ALTER TABLE worker.document_reuse_events
  ADD COLUMN IF NOT EXISTS feedback_session_id INTEGER,
  ADD COLUMN IF NOT EXISTS linked_entity_type TEXT,
  ADD COLUMN IF NOT EXISTS linked_entity_id INTEGER,
  ADD COLUMN IF NOT EXISTS committed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_worker_document_reuse_events_feedback_session
  ON worker.document_reuse_events(feedback_session_id);
