-- S1.3-3 C2: L2 ON transition gate candidates.
-- This table is intentionally write-only for the gate result. The upstream
-- shadow/eval/trade/curriculum tables remain read-only in this phase.

CREATE TABLE IF NOT EXISTS investment.luna_vault_shadow_on_candidates (
  id              BIGSERIAL PRIMARY KEY,
  scope_market    TEXT NOT NULL,
  scope_family    TEXT NOT NULL,
  scope_direction TEXT NOT NULL,
  vault_hit_rate  DOUBLE PRECISION,
  base_hit_rate   DOUBLE PRECISION,
  lift            DOUBLE PRECISION,
  sample_n        INTEGER NOT NULL DEFAULT 0,
  eval_days       INTEGER NOT NULL DEFAULT 0,
  gate_status     TEXT NOT NULL CHECK (gate_status IN ('pass', 'block')),
  gate_reason     TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (scope_market, scope_family, scope_direction)
);

CREATE INDEX IF NOT EXISTS idx_luna_vault_shadow_on_candidates_scope
  ON investment.luna_vault_shadow_on_candidates (scope_market, scope_family, scope_direction);

CREATE INDEX IF NOT EXISTS idx_luna_vault_shadow_on_candidates_status
  ON investment.luna_vault_shadow_on_candidates (gate_status);

COMMENT ON TABLE investment.luna_vault_shadow_on_candidates IS
  'S1.3-3 C2 L2 ON transition gate candidates derived from luna_vault_shadow_eval; records candidate status only.';
