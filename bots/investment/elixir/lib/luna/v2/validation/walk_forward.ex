defmodule Luna.V2.Validation.WalkForward do
  @moduledoc """
  Validation Stage 2 — Rolling Walk-Forward 검증.

  최근 90일을 30일 단위로 3 구간 분할 (각 구간 Sharpe 계산).
  3구간 평균 Sharpe ≥ 0.5이면 pass.
  """
  require Logger

  @window_days 30
  @periods     3

  @doc """
  strategy 맵을 받아 walk-forward 결과 반환.

  반환: {:ok, %{type: :walk_forward, pass, periods, avg_sharpe, window_results}}
  """
  def run(strategy) do
    symbols = get_in(strategy, [:parameter_snapshot, "symbols"]) || []
    Logger.debug("[WalkForward] 심볼=#{inspect(symbols)} #{@periods}구간 × #{@window_days}일")

    windows = Enum.map(0..(@periods - 1), fn i ->
      offset_days = i * @window_days
      run_window(symbols, offset_days, @window_days)
    end)

    sharpes = Enum.map(windows, & &1.sharpe)
    avg_sharpe = if sharpes == [], do: 0.0, else: Enum.sum(sharpes) / length(sharpes)
    avg_sharpe = Float.round(avg_sharpe, 4)

    {:ok, %{
      type:           :walk_forward,
      pass:           avg_sharpe >= 0.5,
      periods:        @periods,
      avg_sharpe:     avg_sharpe,
      window_results: windows
    }}
  rescue
    e ->
      Logger.error("[WalkForward] 예외: #{inspect(e)}")
      {:ok, %{type: :walk_forward, pass: false, periods: @periods, avg_sharpe: 0.0, window_results: []}}
  end

  # ─── Internal ─────────────────────────────────────────────────────

  defp run_window(symbols, offset_days, window_days) do
    query = """
    SELECT
      COALESCE(AVG(pnl_pct), 0)   AS avg_pnl,
      COALESCE(STDDEV(pnl_pct), 0) AS stdev_pnl
    FROM investment.trade_history
    WHERE symbol = ANY($1)
      AND closed_at BETWEEN
            NOW() - ($2 || ' days')::interval - ($3 || ' days')::interval
        AND NOW() - ($2 || ' days')::interval
    """
    case Jay.Core.Repo.query(query, [symbols, to_string(offset_days), to_string(window_days)]) do
      {:ok, %{rows: [[avg, stdev | _] | _]}} ->
        avg_f   = to_f(avg)
        stdev_f = to_f(stdev)
        sharpe  = Luna.V2.Validation.Backtest.calc_sharpe(avg_f, stdev_f)
        %{offset_days: offset_days, avg_pnl: avg_f, sharpe: sharpe}

      _ ->
        %{offset_days: offset_days, avg_pnl: 0.0, sharpe: 0.0}
    end
  rescue
    _ -> %{offset_days: offset_days, avg_pnl: 0.0, sharpe: 0.0}
  end

  defp to_f(nil), do: 0.0
  defp to_f(d) when is_struct(d, Decimal), do: Decimal.to_float(d)
  defp to_f(n) when is_number(n), do: n * 1.0
  defp to_f(_), do: 0.0
end
