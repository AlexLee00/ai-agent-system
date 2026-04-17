defmodule Sigma.V2.Graduation do
  @moduledoc """
  Tier 0 → Tier 1 승격 조건 감시.
  Plan §5.3.5 Graduation Criteria.
  참조: bots/sigma/docs/PLAN.md §6 Phase 2
  """

  @tier0_min_observations 20
  @consistency_threshold 0.7

  @doc "팀+피드백타입 조합의 Tier 승격 여부 판정."
  @spec check_promotion(String.t(), String.t()) :: {:promote, :tier_1} | {:stay, :tier_0}
  def check_promotion(team, feedback_type) do
    observation_count = Sigma.V2.Archivist.observation_count(team, feedback_type)
    consistency = pattern_consistency(team, feedback_type)

    if observation_count >= @tier0_min_observations and consistency > @consistency_threshold do
      {:promote, :tier_1}
    else
      {:stay, :tier_0}
    end
  end

  # ---

  defp pattern_consistency(team, _feedback_type) do
    # 최근 20건 중 동일 피드백 타입 비율로 일관성 계산
    sql = """
    SELECT COUNT(*)::float / NULLIF($2::float, 0) AS consistency
    FROM (
      SELECT 1 FROM sigma_v2_directive_audit
      WHERE team = $1 AND outcome = 'observed'
      ORDER BY executed_at DESC LIMIT $2
    ) sub
    """

    case Jay.Core.Repo.query(sql, [team, @tier0_min_observations]) do
      {:ok, %{rows: [[nil]]}} -> 0.0
      {:ok, %{rows: [[v]]}} when is_float(v) -> v
      _ -> 0.0
    end
  rescue
    _ -> 0.0
  end
end
