-- Sigma source_ref lookup index draft.
-- Apply only after master approval; runtime works without this index.

CREATE INDEX IF NOT EXISTS idx_sigma_vault_entries_source_ref
  ON sigma.vault_entries (
    (meta->'source_ref'->>'team'),
    (meta->'source_ref'->>'table'),
    (meta->'source_ref'->>'id')
  );
