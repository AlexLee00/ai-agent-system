CREATE TABLE IF NOT EXISTS worker.document_reuse_events (
    id            SERIAL PRIMARY KEY,
    document_id   INTEGER NOT NULL REFERENCES worker.documents(id) ON DELETE CASCADE,
    company_id    TEXT NOT NULL REFERENCES worker.companies(id),
    target_menu   TEXT NOT NULL,
    prompt_length INTEGER NOT NULL DEFAULT 0,
    reused_by     INTEGER REFERENCES worker.users(id),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_worker_document_reuse_events_document
  ON worker.document_reuse_events(document_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_worker_document_reuse_events_company
  ON worker.document_reuse_events(company_id, created_at DESC);
