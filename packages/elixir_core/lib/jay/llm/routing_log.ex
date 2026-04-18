defmodule Jay.Core.LLM.RoutingLog do
  @moduledoc """
  팀별 LLM 라우팅 로그 공용 레이어.

  사용법:
    use Jay.Core.LLM.RoutingLog,
      table:      "sigma_v2_llm_routing_log",
      log_prefix: "[sigma/routing_log]"
  """

  defmacro __using__(opts) do
    table      = Keyword.fetch!(opts, :table)
    log_prefix = Keyword.get(opts, :log_prefix, "[llm/routing_log]")

    quote do
      require Logger

      @table      unquote(table)
      @log_prefix unquote(log_prefix)

      @doc """
      라우팅 시도 기록.

      entry 필드:
        agent_name, model_primary, model_used, fallback_used,
        prompt_tokens (또는 tokens_input), response_tokens (또는 tokens_output),
        latency_ms, cost_usd, response_ok, error_reason,
        urgency, task_type, budget_ratio, recommended_reason, provider
      """
      def record(entry) do
        Jay.Core.LLM.RoutingLog.Impl.record(@table, @log_prefix, entry)
      end

      @doc "에이전트별 최근 24h 실패율 (0.0~1.0)"
      def recent_failure_rate(agent_name) do
        Jay.Core.LLM.RoutingLog.Impl.recent_failure_rate(@table, agent_name)
      end
    end
  end

  defmodule Impl do
    @moduledoc false

    require Logger

    def record(table, log_prefix, entry) do
      case Jay.Core.Repo.query(sql_with_provider(table), params_with_provider(entry)) do
        {:ok, _} -> :ok
        {:error, _} ->
          Jay.Core.Repo.query(sql_legacy(table), params_legacy(entry))
          :ok
      end

      :ok
    rescue
      e ->
        Logger.warning("#{log_prefix} 기록 실패 (#{inspect(e)}) — 무시")
        :ok
    end

    def recent_failure_rate(table, agent_name) do
      sql = """
      SELECT
        CASE WHEN COUNT(*) = 0 THEN 0.0
             ELSE COUNT(*) FILTER (WHERE response_ok = false)::float / COUNT(*)
        END
      FROM #{table}
      WHERE agent_name = $1
        AND inserted_at > NOW() - INTERVAL '1 day'
      """

      case Jay.Core.Repo.query(sql, [to_string(agent_name)]) do
        {:ok, %{rows: [[rate]]}} when is_number(rate) -> rate
        _ -> 0.0
      end
    rescue
      _ -> 0.0
    end

    defp sql_with_provider(table) do
      """
      INSERT INTO #{table}
        (agent_name, model_primary, model_used, fallback_used,
         prompt_tokens, response_tokens, latency_ms, cost_usd,
         response_ok, error_reason, urgency, task_type, budget_ratio, recommended_reason,
         provider, inserted_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,NOW())
      """
    end

    defp sql_legacy(table) do
      """
      INSERT INTO #{table}
        (agent_name, model_primary, model_used, fallback_used,
         prompt_tokens, response_tokens, latency_ms, cost_usd,
         response_ok, error_reason, urgency, task_type, budget_ratio, recommended_reason,
         inserted_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW())
      """
    end

    defp params_with_provider(entry) do
      params_legacy(entry) ++ [Map.get(entry, :provider, "direct_anthropic")]
    end

    defp params_legacy(entry) do
      prompt_tokens   = Map.get(entry, :prompt_tokens,   Map.get(entry, :tokens_input))
      response_tokens = Map.get(entry, :response_tokens, Map.get(entry, :tokens_output))

      [
        to_string(entry.agent_name),
        to_string(entry.model_primary),
        if(entry.model_used,  do: to_string(entry.model_used),  else: nil),
        entry.fallback_used || false,
        prompt_tokens,
        response_tokens,
        entry.latency_ms,
        entry.cost_usd,
        entry.response_ok,
        entry.error_reason,
        if(entry.urgency,    do: to_string(entry.urgency),    else: "medium"),
        if(entry.task_type,  do: to_string(entry.task_type),  else: "unknown"),
        entry.budget_ratio,
        entry.recommended_reason,
      ]
    end
  end
end
