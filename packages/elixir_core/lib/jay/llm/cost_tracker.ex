defmodule Jay.Core.LLM.CostTracker do
  @moduledoc """
  팀별 LLM 비용 추적 공용 레이어.

  사용법:
    use Jay.Core.LLM.CostTracker,
      table:      "sigma_llm_cost_tracking",
      budget_env: "SIGMA_LLM_DAILY_BUDGET_USD",
      log_prefix: "[sigma/cost]"

  GenServer 기반 (일일 지출 누적).
  """

  @pricing %{
    "claude-opus-4-7"           => %{input: 1.5e-5, output: 7.5e-5},
    "claude-sonnet-4-6"         => %{input: 3.0e-6, output: 1.5e-5},
    "claude-haiku-4-5-20251001" => %{input: 8.0e-7, output: 4.0e-6}
  }

  @doc "모델명으로 비용 계산 (USD)"
  def calculate_cost(model, tokens_input, tokens_output) do
    case Map.get(@pricing, model) do
      %{input: in_p, output: out_p} -> tokens_input * in_p + tokens_output * out_p
      nil                           -> 0.0
    end
  end

  defmacro __using__(opts) do
    table      = Keyword.fetch!(opts, :table)
    budget_env = Keyword.fetch!(opts, :budget_env)
    log_prefix = Keyword.get(opts, :log_prefix, "[llm/cost]")
    default_budget = Keyword.get(opts, :default_budget, 10.0)

    quote do
      use GenServer
      require Logger

      @table          unquote(table)
      @budget_env     unquote(budget_env)
      @log_prefix     unquote(log_prefix)
      @default_budget unquote(default_budget)

      # ---- 공개 API ----

      def start_link(opts \\ []) do
        GenServer.start_link(__MODULE__, :ok, Keyword.merge([name: __MODULE__], opts))
      end

      @doc "토큰 사용 기록"
      def track_tokens(%{agent: _, model: _} = entry) do
        try do
          GenServer.call(__MODULE__, {:track_tokens, entry})
        catch
          :exit, _ ->
            Logger.debug("#{@log_prefix} CostTracker 미기동 — 직접 DB 기록")
            Jay.Core.LLM.CostTracker.Impl.insert_direct(@table, @log_prefix, entry)
        end
      end

      @doc "일일 예산 확인. 반환: {:ok, ratio} | {:error, :budget_exceeded}"
      def check_budget do
        try do
          GenServer.call(__MODULE__, :check_budget)
        catch
          :exit, _ ->
            Logger.debug("#{@log_prefix} CostTracker 미기동 — 예산 체크 기본값 사용")
            {:ok, 1.0}
        end
      end

      @doc "오늘 누적 비용 (USD)"
      def today_total_usd do
        try do
          GenServer.call(__MODULE__, :today_total_usd)
        catch
          :exit, _ -> {:ok, 0.0}
        end
      end

      # ---- GenServer 콜백 ----

      @impl true
      def init(:ok), do: {:ok, %{daily_spent: 0.0, date: Date.utc_today()}}

      @impl true
      def handle_call({:track_tokens, entry}, _from, state) do
        result = Jay.Core.LLM.CostTracker.Impl.track_and_insert(
          @table, @log_prefix, entry, state
        )
        {:reply, result.reply, result.state}
      end

      @impl true
      def handle_call(:check_budget, _from, state) do
        result = Jay.Core.LLM.CostTracker.Impl.check_budget_impl(
          @table, @log_prefix, @budget_env, @default_budget, state
        )
        {:reply, result.reply, result.state}
      end

      @impl true
      def handle_call(:today_total_usd, _from, state) do
        result = Jay.Core.LLM.CostTracker.Impl.today_total_impl(@table, state)
        {:reply, result.reply, result.state}
      end
    end
  end

  defmodule Impl do
    @moduledoc false

    require Logger

    defp table_layout(table) do
      case table do
        "luna_llm_cost_tracking" ->
          %{
            timestamp_column: "inserted_at",
            agent_column: "agent_name",
            has_updated_at: false
          }

        "darwin_llm_cost_tracking" ->
          %{
            timestamp_column: "logged_at",
            agent_column: "agent",
            has_updated_at: true
          }

        _ ->
          %{
            timestamp_column: "timestamp",
            agent_column: "agent",
            has_updated_at: true
          }
      end
    end

    defp insert_sql(table) do
      layout = table_layout(table)

      {columns, values} =
        [{layout.timestamp_column, "NOW()"},
         {layout.agent_column, "$1"},
         {"model", "$2"},
         {"provider", "$3"},
         {"tokens_in", "$4"},
         {"tokens_out", "$5"},
         {"cost_usd", "$6"},
         {"inserted_at", "NOW()"}]
        |> then(fn pairs ->
          if layout.has_updated_at, do: pairs ++ [{"updated_at", "NOW()"}], else: pairs
        end)
        |> Enum.reduce({[], []}, fn {column, value}, {cols, vals} ->
          if column in cols do
            {cols, vals}
          else
            {cols ++ [column], vals ++ [value]}
          end
        end)

      """
      INSERT INTO #{table}
        (#{Enum.join(columns, ", ")})
      VALUES (#{Enum.join(values, ", ")})
      """
    end

    defp today_sum_sql(table) do
      layout = table_layout(table)
      "SELECT COALESCE(SUM(cost_usd), 0.0) FROM #{table} WHERE #{layout.timestamp_column}::date = CURRENT_DATE"
    end

    def track_and_insert(table, log_prefix, entry, state) do
      cost_usd =
        case Map.get(entry, :cost_usd) do
          v when is_number(v) -> v
          _                   ->
            tokens_in  = Map.get(entry, :tokens_in,  Map.get(entry, :tokens_input,  0))
            tokens_out = Map.get(entry, :tokens_out, Map.get(entry, :tokens_output, 0))
            Jay.Core.LLM.CostTracker.calculate_cost(entry.model, tokens_in, tokens_out)
        end

      provider   = Map.get(entry, :provider, "anthropic")
      tokens_in  = Map.get(entry, :tokens_in,  Map.get(entry, :tokens_input,  0))
      tokens_out = Map.get(entry, :tokens_out, Map.get(entry, :tokens_output, 0))

      insert_result =
        Jay.Core.Repo.query(
          insert_sql(table),
          [entry.agent, entry.model, provider, tokens_in, tokens_out, cost_usd]
        )

      case insert_result do
        {:ok, _}    -> :ok
        {:error, e} -> Logger.error("#{log_prefix} DB INSERT 실패: #{inspect(e)}")
      end

      today     = Date.utc_today()
      new_spent = if state.date == today, do: state.daily_spent + cost_usd, else: cost_usd

      %{reply: {:ok, Map.put(entry, :cost_usd, cost_usd)},
        state: %{state | daily_spent: new_spent, date: today}}
    end

    def insert_direct(table, log_prefix, entry) do
      cost_usd   = Jay.Core.LLM.CostTracker.calculate_cost(
        entry.model,
        Map.get(entry, :tokens_in,  Map.get(entry, :tokens_input,  0)),
        Map.get(entry, :tokens_out, Map.get(entry, :tokens_output, 0))
      )
      provider   = Map.get(entry, :provider, "anthropic")
      tokens_in  = Map.get(entry, :tokens_in,  Map.get(entry, :tokens_input,  0))
      tokens_out = Map.get(entry, :tokens_out, Map.get(entry, :tokens_output, 0))

      case Jay.Core.Repo.query(
             insert_sql(table),
             [entry.agent, entry.model, provider, tokens_in, tokens_out, cost_usd]
           ) do
        {:ok, _}    -> {:ok, Map.put(entry, :cost_usd, cost_usd)}
        {:error, e} ->
          Logger.error("#{log_prefix} DB 직접 INSERT 실패: #{inspect(e)}")
          {:ok, Map.put(entry, :cost_usd, cost_usd)}
      end
    end

    def check_budget_impl(table, log_prefix, budget_env, default_budget, state) do
      daily_limit =
        case Float.parse(System.get_env(budget_env, to_string(default_budget))) do
          {f, _} -> f
          :error  -> default_budget
        end

      today = Date.utc_today()

      daily_spent =
        case Jay.Core.Repo.query(
               today_sum_sql(table),
               []
             ) do
          {:ok, %{rows: [[sum]]}} when is_number(sum) -> sum
          _ -> if state.date == today, do: state.daily_spent, else: 0.0
        end

      new_state = %{state | daily_spent: daily_spent, date: today}

      reply =
        if daily_spent < daily_limit do
          ratio = 1.0 - daily_spent / max(daily_limit, 0.001)
          {:ok, Float.round(ratio, 4)}
        else
          Logger.error("#{log_prefix} 일일 예산 초과: $#{daily_spent} / $#{daily_limit}")
          {:error, :budget_exceeded}
        end

      %{reply: reply, state: new_state}
    end

    def today_total_impl(table, state) do
      today = Date.utc_today()

      total =
        case Jay.Core.Repo.query(
               today_sum_sql(table),
               []
             ) do
          {:ok, %{rows: [[sum]]}} when is_number(sum) -> sum
          _ -> if state.date == today, do: state.daily_spent, else: 0.0
        end

      %{reply: {:ok, total}, state: %{state | daily_spent: total, date: today}}
    end
  end
end
