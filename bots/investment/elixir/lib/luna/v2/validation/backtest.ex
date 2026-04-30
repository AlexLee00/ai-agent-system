defmodule Luna.V2.Validation.Backtest do
  @moduledoc """
  Validation Stage 1 — 6개월 trade_history 기반 백테스트.

  투자.trade_history 테이블에서 심볼별 통계 집계.
  Sharpe / Sortino / hit_rate / max_dd / avg_pnl / volatility 반환.
  """
  require Logger

  @lookback_months 6

  @doc """
  strategy 맵을 받아 백테스트 결과 반환.

  반환: {:ok, %{type: :backtest, trades, avg_pnl, sharpe, max_dd, hit_rate}}
  """
  def run(strategy) do
    symbols = get_in(strategy, [:parameter_snapshot, "symbols"]) || []
    Logger.debug("[Backtest] 심볼=#{inspect(symbols)} #{@lookback_months}개월")

    if symbols == [] do
      {:ok, empty_result()}
    else
      query_and_compute(symbols, strategy)
    end
  end

  @doc """
  Layer 1 백테스트 진입점.

  DB 접근 가능 시 6개월 trade_history를 사용하고, 실패 시 empty result를 반환한다.
  """
  def run_layer1_backtest(strategy, symbol, period \\ "6m") do
    symbols =
      cond do
        is_binary(symbol) and symbol != "" -> [symbol]
        true -> get_in(strategy, [:parameter_snapshot, "symbols"]) || []
      end

    parameter_snapshot =
      (Map.get(strategy, :parameter_snapshot) || Map.get(strategy, "parameter_snapshot") || %{})
      |> Map.put("symbols", symbols)
      |> Map.put("period", period)

    strategy =
      strategy
      |> Map.put_new(:name, Map.get(strategy, "name", "unknown"))
      |> Map.put(:parameter_snapshot, parameter_snapshot)

    run(strategy)
  end

  # ─── Internal ─────────────────────────────────────────────────────

  defp query_and_compute(symbols, strategy) do
    query = """
    SELECT
      symbol,
      COALESCE(exchange, market, 'unknown') AS market,
      COALESCE(pnl_pct, 0) AS pnl_pct
    FROM investment.trade_history
    WHERE symbol = ANY($1)
      AND closed_at > NOW() - ($2 || ' months')::interval
    ORDER BY closed_at ASC
    """
    case Jay.Core.Repo.query(query, [symbols, to_string(@lookback_months)]) do
      {:ok, %{rows: rows}} when is_list(rows) and length(rows) > 0 ->
        {:ok, compute_metrics(rows, strategy)}

      {:ok, %{rows: []}} ->
        {:ok, empty_result()}

      err ->
        Logger.warning("[Backtest] 쿼리 실패: #{inspect(err)}")
        {:ok, empty_result()}
    end
  rescue
    e ->
      Logger.error("[Backtest] 예외: #{inspect(e)}")
      {:ok, empty_result()}
  end

  defp empty_result do
    %{
      type: :backtest,
      trades: 0,
      avg_pnl: 0.0,
      sharpe: 0.0,
      sortino: 0.0,
      max_dd: 0.0,
      hit_rate: 0.0,
      volatility: 0.0,
      market_breakdown: %{},
      strategy_breakdown: %{}
    }
  end

  @doc "테스트/리포트용 순수 메트릭 계산."
  def compute_metrics(rows, strategy \\ %{}) when is_list(rows) do
    returns = Enum.map(rows, fn row -> row_return(row) end)
    equity = build_equity_curve(returns)
    wins = Enum.count(returns, &(&1 > 0))
    trades = length(returns)
    avg = avg(returns)
    volatility = stdev(returns)
    strategy_name = Map.get(strategy, :name) || Map.get(strategy, "name") || "unknown"

    %{
      type: :backtest,
      strategy: strategy_name,
      trades: trades,
      avg_pnl: Float.round(avg, 6),
      sharpe: calc_sharpe(avg, volatility),
      sortino: calc_sortino(returns),
      max_dd: calc_max_drawdown(equity),
      hit_rate: if(trades > 0, do: Float.round(wins / trades, 4), else: 0.0),
      volatility: Float.round(volatility, 6),
      market_breakdown: group_breakdown(rows, 1),
      strategy_breakdown: %{strategy_name => trades}
    }
  end

  @doc "Sharpe Ratio (연환산 252일 기준)."
  def calc_sharpe(avg_pnl, stdev) when stdev > 0.0001 do
    Float.round(avg_pnl / stdev * :math.sqrt(252), 4)
  end
  def calc_sharpe(avg_pnl, _stdev) when avg_pnl > 0, do: 99.0
  def calc_sharpe(_, _), do: 0.0

  @doc "Return list 기반 Sharpe Ratio."
  def calc_sharpe(returns) when is_list(returns) do
    calc_sharpe(avg(returns), stdev(returns))
  end

  @doc "Sortino Ratio (하방 변동성 기준)."
  def calc_sortino(returns) when is_list(returns) do
    mean = avg(returns)
    downside =
      returns
      |> Enum.filter(&(&1 < 0))
      |> stdev()

    cond do
      downside > 0.0001 -> Float.round(mean / downside * :math.sqrt(252), 4)
      mean > 0 -> 99.0
      true -> 0.0
    end
  end

  @doc "Equity curve 기준 최대 낙폭."
  def calc_max_drawdown(equity_curve) when is_list(equity_curve) do
    {_peak, max_dd} =
      Enum.reduce(equity_curve, {1.0, 0.0}, fn value, {peak, max_dd} ->
        current = max(to_f(value), 0.0001)
        next_peak = max(peak, current)
        dd = if next_peak > 0, do: (next_peak - current) / next_peak, else: 0.0
        {next_peak, max(max_dd, dd)}
      end)

    Float.round(max_dd, 6)
  end

  defp row_return([_symbol, _market, pnl | _]), do: to_f(pnl)
  defp row_return(%{pnl_pct: pnl}), do: to_f(pnl)
  defp row_return(%{"pnl_pct" => pnl}), do: to_f(pnl)
  defp row_return(value), do: to_f(value)

  defp build_equity_curve(returns) do
    {curve, _equity} =
      Enum.reduce(returns, {[1.0], 1.0}, fn pct, {curve, equity} ->
        next = equity * (1.0 + to_f(pct) / 100.0)
        {[next | curve], next}
      end)

    Enum.reverse(curve)
  end

  defp avg([]), do: 0.0
  defp avg(values), do: Enum.sum(Enum.map(values, &to_f/1)) / max(length(values), 1)

  defp stdev(values) when length(values) <= 1, do: 0.0
  defp stdev(values) do
    mean = avg(values)
    variance =
      values
      |> Enum.map(&to_f/1)
      |> Enum.reduce(0.0, fn value, sum -> sum + :math.pow(value - mean, 2) end)
      |> Kernel./(max(length(values) - 1, 1))

    :math.sqrt(variance)
  end

  defp group_breakdown(rows, index) do
    rows
    |> Enum.map(fn
      row when is_list(row) -> Enum.at(row, index) || "unknown"
      row when is_map(row) -> row[:market] || row["market"] || row[:exchange] || row["exchange"] || "unknown"
      _ -> "unknown"
    end)
    |> Enum.frequencies()
  end

  defp to_f(nil), do: 0.0
  defp to_f(d) when is_struct(d, Decimal), do: Decimal.to_float(d)
  defp to_f(n) when is_number(n), do: n * 1.0
  defp to_f(_), do: 0.0

end
