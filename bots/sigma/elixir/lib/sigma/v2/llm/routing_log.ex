defmodule Sigma.V2.LLM.RoutingLog do
  @moduledoc """
  LLM 라우팅 기록 — Recommender 품질 측정 + 실패율 피드백용.

  DB: sigma_v2_llm_routing_log 테이블
  """

  require Logger

  @doc """
  라우팅 시도 기록 — sigma_v2_llm_routing_log INSERT.

  entry 필드:
    agent_name, model_primary, model_used, fallback_used,
    prompt_tokens, response_tokens, latency_ms, cost_usd,
    response_ok, error_reason, urgency, task_type, budget_ratio, recommended_reason,
    provider (선택, Phase 2 이후)
  """
  def record(entry) do
    sql = """
    INSERT INTO sigma_v2_llm_routing_log
      (agent_name, model_primary, model_used, fallback_used,
       prompt_tokens, response_tokens, latency_ms, cost_usd,
       response_ok, error_reason, urgency, task_type, budget_ratio, recommended_reason,
       provider,
       inserted_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,NOW())
    """

    Jay.Core.Repo.query(sql, [
      to_string(entry.agent_name),
      to_string(entry.model_primary),
      if(entry.model_used, do: to_string(entry.model_used), else: nil),
      entry.fallback_used || false,
      entry.prompt_tokens,
      entry.response_tokens,
      entry.latency_ms,
      entry.cost_usd,
      entry.response_ok,
      entry.error_reason,
      if(entry.urgency, do: to_string(entry.urgency), else: "medium"),
      if(entry.task_type, do: to_string(entry.task_type), else: "unknown"),
      entry.budget_ratio,
      entry.recommended_reason,
      Map.get(entry, :provider, "direct_anthropic"),
    ])

    :ok
  rescue
    e ->
      Logger.warning("[sigma/routing_log] 기록 실패 (#{inspect(e)}) — 무시")
      :ok
  end

  @doc """
  에이전트별 최근 24h 실패율 (0.0~1.0).
  DB 오류 시 0.0 반환 (안전 기본값).
  """
  def recent_failure_rate(agent_name) do
    sql = """
    SELECT
      CASE WHEN COUNT(*) = 0 THEN 0.0
           ELSE COUNT(*) FILTER (WHERE response_ok = false)::float / COUNT(*)
      END
    FROM sigma_v2_llm_routing_log
    WHERE agent_name = $1
      AND inserted_at > NOW() - INTERVAL '1 day'
    """

    case Jay.Core.Repo.query(sql, [to_string(agent_name)]) do
      {:ok, %{rows: [[rate]]}} when is_number(rate) -> rate
      {:ok, %{rows: [[rate]]}} when is_float(rate)  -> rate
      _ -> 0.0
    end
  rescue
    _ -> 0.0
  end
end
