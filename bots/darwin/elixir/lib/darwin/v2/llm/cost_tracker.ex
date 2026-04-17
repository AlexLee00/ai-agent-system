defmodule Darwin.V2.LLM.CostTracker do
  @moduledoc """
  다윈 V2 LLM 비용 추적 (일일 예산 대비).

  DB: darwin_llm_cost_tracking 테이블
  환경변수: DARWIN_LLM_DAILY_BUDGET_USD (기본 $10.0)
  GenServer: 일일 지출 누적 추적.
  """

  use GenServer
  require Logger

  # USD per token 가격표
  @pricing %{
    "claude-opus-4-7"            => %{input: 1.5e-5, output: 7.5e-5},
    "claude-sonnet-4-6"          => %{input: 3.0e-6, output: 1.5e-5},
    "claude-haiku-4-5-20251001"  => %{input: 8.0e-7, output: 4.0e-6}
  }

  # -------------------------------------------------------------------
  # 공개 API
  # -------------------------------------------------------------------

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, :ok, Keyword.merge([name: __MODULE__], opts))
  end

  @doc """
  토큰 사용 기록.

  input: %{agent: string, model: string, tokens_input: integer, tokens_output: integer}
  """
  def track_tokens(%{agent: _, model: _, tokens_input: _, tokens_output: _} = entry) do
    GenServer.call(__MODULE__, {:track_tokens, entry})
  end

  @doc """
  일일 예산 확인.
  반환: {:ok, budget_ratio} (1.0=여유, 0.0=소진) | {:error, :budget_exceeded}
  budget_ratio: 0.0~1.0 (float)
  """
  def check_budget do
    GenServer.call(__MODULE__, :check_budget)
  end

  @doc "오늘 누적 비용 (USD). {:ok, float} | {:error, term}"
  def today_total_usd do
    GenServer.call(__MODULE__, :today_total_usd)
  end

  # -------------------------------------------------------------------
  # GenServer 콜백
  # -------------------------------------------------------------------

  @impl true
  def init(:ok) do
    {:ok, %{daily_spent: 0.0, date: Date.utc_today()}}
  end

  @impl true
  def handle_call({:track_tokens, entry}, _from, state) do
    cost_usd = calculate_cost(entry.model, entry.tokens_input, entry.tokens_output)

    result =
      Jay.Core.Repo.query(
        """
        INSERT INTO darwin_llm_cost_tracking
          (timestamp, agent, model, provider, tokens_in, tokens_out, cost_usd, inserted_at, updated_at)
        VALUES (NOW(), $1, $2, $3, $4, $5, $6, NOW(), NOW())
        """,
        [
          entry.agent,
          entry.model,
          Map.get(entry, :provider, "anthropic"),
          entry.tokens_input,
          entry.tokens_output,
          cost_usd
        ]
      )

    case result do
      {:ok, _} -> :ok
      {:error, e} -> Logger.error("[다윈V2 비용] DB INSERT 실패: #{inspect(e)}")
    end

    # 날짜 리셋 처리
    today = Date.utc_today()
    new_spent =
      if state.date == today do
        state.daily_spent + cost_usd
      else
        cost_usd
      end

    {:reply, {:ok, Map.put(entry, :cost_usd, cost_usd)},
     %{state | daily_spent: new_spent, date: today}}
  end

  @impl true
  def handle_call(:check_budget, _from, state) do
    daily_limit =
      System.get_env("DARWIN_LLM_DAILY_BUDGET_USD", "10.0")
      |> String.to_float()

    # 날짜 리셋 후 DB에서 실제 합계 조회
    today = Date.utc_today()

    daily_spent =
      case Jay.Core.Repo.query(
             "SELECT COALESCE(SUM(cost_usd), 0.0) FROM darwin_llm_cost_tracking WHERE timestamp::date = CURRENT_DATE",
             []
           ) do
        {:ok, %{rows: [[sum]]}} when is_number(sum) -> sum
        _ -> if state.date == today, do: state.daily_spent, else: 0.0
      end

    new_state = %{state | daily_spent: daily_spent, date: today}

    result =
      if daily_spent < daily_limit do
        ratio = 1.0 - daily_spent / max(daily_limit, 0.001)
        {:ok, Float.round(ratio, 4)}
      else
        Logger.error("[다윈V2 비용] 일일 예산 초과: $#{daily_spent} / $#{daily_limit}")
        {:error, :budget_exceeded}
      end

    {:reply, result, new_state}
  end

  @impl true
  def handle_call(:today_total_usd, _from, state) do
    today = Date.utc_today()

    total =
      case Jay.Core.Repo.query(
             "SELECT COALESCE(SUM(cost_usd), 0.0) FROM darwin_llm_cost_tracking WHERE timestamp::date = CURRENT_DATE",
             []
           ) do
        {:ok, %{rows: [[sum]]}} when is_number(sum) -> sum
        _ -> if state.date == today, do: state.daily_spent, else: 0.0
      end

    {:reply, {:ok, total}, %{state | daily_spent: total, date: today}}
  end

  # -------------------------------------------------------------------
  # Private — 비용 계산
  # -------------------------------------------------------------------

  defp calculate_cost(model, tokens_input, tokens_output) do
    case Map.get(@pricing, model) do
      %{input: in_price, output: out_price} ->
        tokens_input * in_price + tokens_output * out_price

      nil ->
        0.0
    end
  end
end
