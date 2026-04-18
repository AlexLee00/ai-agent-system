defmodule Luna.V2.Registry.StrategyRegistry do
  @moduledoc """
  전략 운영 객체 관리 Registry.

  전략 버전 + 승격/강등 이력 추적.
  status: backtest → shadow → validation_live → normal_live → retired
  """
  use GenServer
  require Logger

  @table :luna_strategy_registry_ets

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  # ─── Public API ───────────────────────────────────────────────────

  def get(strategy_id) do
    case :ets.lookup(@table, strategy_id) do
      [{^strategy_id, strategy}] -> {:ok, strategy}
      [] -> fetch_from_db(strategy_id)
    end
  end

  def list(market \\ nil, status \\ nil) do
    GenServer.call(__MODULE__, {:list, market, status})
  end

  def register(strategy) do
    GenServer.call(__MODULE__, {:register, strategy})
  end

  def promote(strategy_id, to_stage, reason \\ "auto") do
    GenServer.call(__MODULE__, {:promote, strategy_id, to_stage, reason})
  end

  def demote(strategy_id, reason \\ "auto") do
    GenServer.call(__MODULE__, {:demote, strategy_id, reason})
  end

  def record_validation(strategy_id, verdict) do
    GenServer.cast(__MODULE__, {:record_validation, strategy_id, verdict})
  end

  def record_outcome(order) do
    GenServer.cast(__MODULE__, {:record_outcome, order})
  end

  # ─── GenServer ───────────────────────────────────────────────────

  def init(_opts) do
    :ets.new(@table, [:named_table, :set, :public, read_concurrency: true])
    load_from_db()
    schedule_refresh()
    {:ok, %{}}
  end

  def handle_call({:list, market, status}, _from, state) do
    query = build_list_query(market, status)
    result = case Jay.Core.Repo.query(query, list_params(market, status)) do
      {:ok, %{columns: cols, rows: rows}} ->
        {:ok, Enum.map(rows, &row_to_map(cols, &1))}
      err -> err
    end
    {:reply, result, state}
  end

  def handle_call({:register, strategy}, _from, state) do
    result = insert_strategy(strategy)
    {:reply, result, state}
  end

  def handle_call({:promote, strategy_id, to_stage, reason}, _from, state) do
    result = do_promote(strategy_id, to_stage, reason)
    {:reply, result, state}
  end

  def handle_call({:demote, strategy_id, reason}, _from, state) do
    result = do_promote(strategy_id, "retired", reason)
    {:reply, result, state}
  end

  def handle_cast({:record_validation, strategy_id, verdict}, state) do
    update_strategy_status(strategy_id, verdict)
    {:noreply, state}
  end

  def handle_cast({:record_outcome, _order}, state) do
    # 향후 거래 결과를 전략별 통계에 반영
    {:noreply, state}
  end

  def handle_info(:refresh, state) do
    load_from_db()
    schedule_refresh()
    {:noreply, state}
  end

  # ─── Internal ───────────────────────────────────────────────────

  defp load_from_db do
    query = "SELECT strategy_id, version, market, status, feature_profile, parameter_snapshot FROM luna_strategy_registry WHERE active_flag = true"
    case Jay.Core.Repo.query(query, []) do
      {:ok, %{rows: rows}} ->
        Enum.each(rows, fn [id, ver, mkt, st, fp, ps] ->
          :ets.insert(@table, {id, %{strategy_id: id, version: ver, market: mkt, status: st,
                                      feature_profile: fp, parameter_snapshot: ps}})
        end)
      _ -> :ok
    end
  rescue
    _ -> :ok
  end

  defp fetch_from_db(strategy_id) do
    query = "SELECT strategy_id, version, market, status, description FROM luna_strategy_registry WHERE strategy_id = $1"
    case Jay.Core.Repo.query(query, [strategy_id]) do
      {:ok, %{rows: [[id, ver, mkt, st, desc | _] | _]}} ->
        {:ok, %{strategy_id: id, version: ver, market: mkt, status: st, description: desc}}
      {:ok, %{rows: []}} -> {:error, :not_found}
      err -> err
    end
  rescue
    _ -> {:error, :db_error}
  end

  defp insert_strategy(s) do
    query = """
    INSERT INTO luna_strategy_registry
      (strategy_id, version, market, description, feature_profile, parameter_snapshot, status, active_flag)
    VALUES ($1, $2, $3, $4, $5, $6, 'backtest', true)
    ON CONFLICT (strategy_id) DO UPDATE SET version = $2, active_flag = true
    RETURNING id
    """
    Jay.Core.Repo.query(query, [
      s[:strategy_id], s[:version] || "1.0.0", to_string(s[:market] || :crypto),
      s[:description] || "", Jason.encode!(s[:feature_profile] || %{}),
      Jason.encode!(s[:parameter_snapshot] || %{})
    ])
  end

  defp do_promote(strategy_id, to_stage, reason) do
    query = """
    UPDATE luna_strategy_registry SET status = $2, promoted_at = NOW()
    WHERE strategy_id = $1
    """
    case Jay.Core.Repo.query(query, [strategy_id, to_stage]) do
      {:ok, %{num_rows: 1}} ->
        log_promotion(strategy_id, to_stage, reason)
        :ets.delete(@table, strategy_id)
        load_from_db()
        {:ok, :promoted}
      _ ->
        {:error, :not_found}
    end
  end

  defp log_promotion(strategy_id, to_stage, reason) do
    query = """
    INSERT INTO luna_strategy_promotion_log (strategy_id, to_stage, reason)
    VALUES ($1, $2, $3)
    """
    Jay.Core.Repo.query(query, [strategy_id, to_stage, reason])
  rescue
    _ -> :ok
  end

  defp update_strategy_status(strategy_id, %{verdict: verdict}) when is_atom(verdict) do
    to_stage = case verdict do
      :promote -> "normal_live"
      :hold    -> nil
      :demote  -> "retired"
    end
    if to_stage, do: do_promote(strategy_id, to_stage, "validation_auto")
  end
  defp update_strategy_status(_, _), do: :ok

  defp build_list_query(nil, nil),  do: "SELECT * FROM luna_strategy_registry WHERE active_flag = true"
  defp build_list_query(_mkt, nil), do: "SELECT * FROM luna_strategy_registry WHERE active_flag = true AND market = $1"
  defp build_list_query(nil, _st),  do: "SELECT * FROM luna_strategy_registry WHERE active_flag = true AND status = $1"
  defp build_list_query(_mkt, _st), do: "SELECT * FROM luna_strategy_registry WHERE active_flag = true AND market = $1 AND status = $2"

  defp list_params(nil, nil),  do: []
  defp list_params(mkt, nil),  do: [to_string(mkt)]
  defp list_params(nil, st),   do: [to_string(st)]
  defp list_params(mkt, st),   do: [to_string(mkt), to_string(st)]

  defp row_to_map(cols, row) do
    cols |> Enum.zip(row) |> Enum.into(%{})
  end

  defp schedule_refresh do
    Process.send_after(self(), :refresh, 5 * 60_000)
  end
end
