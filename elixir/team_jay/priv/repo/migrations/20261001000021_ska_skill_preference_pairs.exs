defmodule Jay.Core.Repo.Migrations.SkaSkillPreferencePairs do
  use Ecto.Migration

  def up do
    execute """
    CREATE TABLE IF NOT EXISTS ska_skill_preference_pairs (
      id BIGSERIAL PRIMARY KEY,
      skill_name TEXT NOT NULL,
      caller_agent TEXT NOT NULL,
      execution_id BIGINT,
      score NUMERIC(4, 3) NOT NULL DEFAULT 0.5,
      category TEXT NOT NULL DEFAULT 'neutral',
      failure_cause TEXT,
      critique TEXT,
      improvement_hint TEXT,
      inserted_at TIMESTAMPTZ DEFAULT NOW()
    )
    """

    execute """
    COMMENT ON TABLE ska_skill_preference_pairs IS
      'Self-Rewarding DPO 선호 쌍 — LLM-as-a-Judge 평가 결과'
    """

    execute """
    CREATE INDEX IF NOT EXISTS idx_ska_pref_skill_cat
      ON ska_skill_preference_pairs(skill_name, category, inserted_at DESC)
    """

    execute """
    CREATE INDEX IF NOT EXISTS idx_ska_pref_score
      ON ska_skill_preference_pairs(skill_name, score, inserted_at DESC)
    """

    execute """
    CREATE INDEX IF NOT EXISTS idx_ska_pref_execution
      ON ska_skill_preference_pairs(execution_id)
    """

    # 월간 affinity 집계 뷰
    execute """
    CREATE MATERIALIZED VIEW IF NOT EXISTS ska_skill_affinity_30d AS
    SELECT
      skill_name,
      COUNT(*) AS total_pairs,
      SUM(CASE WHEN category = 'preferred' THEN 1 ELSE 0 END) AS preferred_count,
      SUM(CASE WHEN category = 'rejected' THEN 1 ELSE 0 END) AS rejected_count,
      ROUND(AVG(score)::numeric, 3) AS avg_score,
      ROUND(
        100.0 * SUM(CASE WHEN category = 'preferred' THEN 1 ELSE 0 END)::numeric
        / NULLIF(COUNT(*), 0),
        2
      ) AS preferred_rate_pct
    FROM ska_skill_preference_pairs
    WHERE inserted_at > NOW() - INTERVAL '30 days'
    GROUP BY skill_name
    """

    execute """
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ska_affinity_skill
      ON ska_skill_affinity_30d (skill_name)
    """
  end

  def down do
    execute "DROP MATERIALIZED VIEW IF EXISTS ska_skill_affinity_30d"
    execute "DROP TABLE IF EXISTS ska_skill_preference_pairs"
  end
end
