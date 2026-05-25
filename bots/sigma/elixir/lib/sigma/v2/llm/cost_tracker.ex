defmodule Sigma.V2.LLM.CostTracker do
  @moduledoc """
  시그마 LLM 비용 추적 — 공용 Impl 위임 (plain 모듈, GenServer 없음).

  DB: sigma_llm_cost_tracking 테이블
  환경변수: SIGMA_LLM_DAILY_BUDGET_USD (기본 10.0)
  """

  require Logger

  @table "sigma_llm_cost_tracking"
  @log_prefix "[sigma/cost]"
  @budget_env "SIGMA_LLM_DAILY_BUDGET_USD"
  @default_budget 10.0

  @doc "토큰 사용 기록"
  def track_tokens(%{agent: _, model: _} = entry) do
    Jay.Core.LLM.CostTracker.Impl.insert_direct(@table, @log_prefix, entry)
  end

  @doc "일일 예산 확인. 반환: {:ok, ratio} | {:error, :budget_exceeded}"
  def check_budget do
    daily_limit =
      case Float.parse(System.get_env(@budget_env, to_string(@default_budget))) do
        {f, _} -> f
        :error -> @default_budget
      end

    if daily_limit <= 0.0 do
      Logger.error("#{@log_prefix} 일일 예산 초과: budget_limit=$#{daily_limit}")
      {:error, :budget_exceeded}
    else
      case daily_spent_today() do
        {:ok, daily_spent} ->
          if daily_spent < daily_limit do
            ratio = 1.0 - daily_spent / max(daily_limit, 0.001)
            {:ok, Float.round(ratio, 4)}
          else
            Logger.error("#{@log_prefix} 일일 예산 초과: $#{daily_spent} / $#{daily_limit}")
            {:error, :budget_exceeded}
          end

        {:error, reason} ->
          Logger.error("#{@log_prefix} 예산 조회 불가로 LLM 호출 차단: #{inspect(reason)}")
          {:error, :budget_exceeded}
      end
    end
  end

  defp daily_spent_today do
    try do
      case Jay.Core.Repo.query(
             "SELECT COALESCE(SUM(cost_usd), 0.0) FROM #{@table} WHERE timestamp::date = CURRENT_DATE",
             []
           ) do
        {:ok, %{rows: [[sum]]}} when is_number(sum) ->
          {:ok, sum}

        other ->
          {:error, {:unexpected_budget_query_result, other}}
      end
    rescue
      e ->
        {:error, Exception.message(e)}
    catch
      :exit, reason ->
        {:error, {:exit, reason}}
    end
  end
end
