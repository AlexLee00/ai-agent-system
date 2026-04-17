defmodule Sigma.V2.LLM.CostTracker do
  @moduledoc """
  시그마 LLM 비용 추적 (일/월 예산 대비).

  DB: sigma_llm_cost_tracking 테이블
  환경변수: SIGMA_LLM_DAILY_BUDGET_USD (기본 10.0)
  """

  require Logger

  @doc """
  토큰 사용 기록.
  """
  def track_tokens(%{agent: _, model: _, provider: _, tokens_in: _, tokens_out: _} = entry) do
    cost_usd = calculate_cost(entry.model, entry.tokens_in, entry.tokens_out)

    # Phase 2에서 실제 DB INSERT 연동 예정
    # Postgrex.query!(Sigma.Repo, """
    #   INSERT INTO sigma_llm_cost_tracking
    #     (timestamp, agent, model, provider, tokens_in, tokens_out, cost_usd)
    #   VALUES (NOW(), $1, $2, $3, $4, $5, $6)
    # """, [entry.agent, entry.model, entry.provider, entry.tokens_in, entry.tokens_out, cost_usd])

    {:ok, Map.put(entry, :cost_usd, cost_usd)}
  end

  @doc """
  일일 예산 확인.
  """
  def check_budget do
    daily_limit =
      System.get_env("SIGMA_LLM_DAILY_BUDGET_USD", "10.0")
      |> String.to_float()

    # Phase 2: SELECT SUM(cost_usd) FROM sigma_llm_cost_tracking WHERE timestamp::date = CURRENT_DATE
    daily_spent = 0.0

    if daily_spent < daily_limit do
      {:ok, %{daily: daily_spent, limit: daily_limit}}
    else
      Logger.error("[sigma/cost] 일일 예산 초과: $#{daily_spent} / $#{daily_limit}")
      {:error, :budget_exceeded}
    end
  end

  # USD per token
  defp calculate_cost("claude-opus-4-7", tokens_in, tokens_out),
    do: tokens_in * 1.5e-5 + tokens_out * 7.5e-5

  defp calculate_cost("claude-sonnet-4-6", tokens_in, tokens_out),
    do: tokens_in * 3.0e-6 + tokens_out * 1.5e-5

  defp calculate_cost("claude-haiku-4-5-20251001", tokens_in, tokens_out),
    do: tokens_in * 8.0e-7 + tokens_out * 4.0e-6

  defp calculate_cost(_ollama_or_other, _in, _out), do: 0.0
end
