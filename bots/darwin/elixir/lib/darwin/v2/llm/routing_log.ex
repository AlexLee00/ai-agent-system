defmodule Darwin.V2.LLM.RoutingLog do
  @moduledoc """
  다윈 V2 LLM 라우팅 기록 — 모델 선택 품질 측정 + 실패율 피드백용.

  DB: darwin_v2_llm_routing_log 테이블
  GenServer: 비동기 기록 + 최근 실패율 조회 캐시.
  """

  use GenServer
  require Logger

  # -------------------------------------------------------------------
  # 공개 API
  # -------------------------------------------------------------------

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, :ok, Keyword.merge([name: __MODULE__], opts))
  end

  @doc """
  라우팅 시도 기록 — 비동기 cast.

  entry 필드:
    agent_name, model_primary, model_used, fallback_used,
    tokens_input, tokens_output, latency_ms, cost_usd,
    response_ok, error_reason, urgency, task_type, budget_ratio, recommended_reason
  """
  def record(entry) do
    GenServer.cast(__MODULE__, {:record, entry})
  end

  @doc """
  에이전트별 최근 24h 실패율 (0.0~1.0).
  DB 오류 시 0.0 반환 (안전 기본값).
  """
  def recent_failure_rate(agent_name) do
    GenServer.call(__MODULE__, {:recent_failure_rate, to_string(agent_name)})
  rescue
    _ -> 0.0
  end

  # -------------------------------------------------------------------
  # GenServer 콜백
  # -------------------------------------------------------------------

  @impl true
  def init(:ok) do
    {:ok, %{}}
  end

  @impl true
  def handle_cast({:record, entry}, state) do
    do_record(entry)
    {:noreply, state}
  end

  @impl true
  def handle_call({:recent_failure_rate, agent_name}, _from, state) do
    rate = do_recent_failure_rate(agent_name)
    {:reply, rate, state}
  end

  # -------------------------------------------------------------------
  # Private — DB 작업
  # -------------------------------------------------------------------

  defp do_record(entry) do
    sql = """
    INSERT INTO darwin_v2_llm_routing_log
      (agent_name, model_primary, model_used, fallback_used,
       prompt_tokens, response_tokens, latency_ms, cost_usd,
       response_ok, error_reason, urgency, task_type, budget_ratio,
       recommended_reason, inserted_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW())
    """

    TeamJay.Repo.query(sql, [
      to_string(entry.agent_name),
      to_string(entry.model_primary),
      if(entry.model_used, do: to_string(entry.model_used), else: nil),
      entry.fallback_used || false,
      entry[:tokens_input] || entry[:prompt_tokens],
      entry[:tokens_output] || entry[:response_tokens],
      entry[:latency_ms],
      entry[:cost_usd],
      entry.response_ok,
      entry[:error_reason],
      if(entry[:urgency], do: to_string(entry[:urgency]), else: "medium"),
      if(entry[:task_type], do: to_string(entry[:task_type]), else: "unknown"),
      entry[:budget_ratio],
      entry[:recommended_reason]
    ])

    :ok
  rescue
    e ->
      Logger.warning("[다윈V2 LLM] routing_log 기록 실패 (#{inspect(e)}) — 무시")
      :ok
  end

  defp do_recent_failure_rate(agent_name) do
    sql = """
    SELECT
      CASE WHEN COUNT(*) = 0 THEN 0.0
           ELSE COUNT(*) FILTER (WHERE response_ok = false)::float / COUNT(*)
      END
    FROM darwin_v2_llm_routing_log
    WHERE agent_name = $1
      AND inserted_at > NOW() - INTERVAL '1 day'
    """

    case TeamJay.Repo.query(sql, [agent_name]) do
      {:ok, %{rows: [[rate]]}} when is_number(rate) -> Float.round(rate * 1.0, 4)
      _ -> 0.0
    end
  rescue
    _ -> 0.0
  end
end
