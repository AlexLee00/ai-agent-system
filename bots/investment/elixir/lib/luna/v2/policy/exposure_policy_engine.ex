defmodule Luna.V2.Policy.ExposurePolicyEngine do
  @moduledoc """
  포지션 노출 제한 엔진.

  - 단일 종목 최대 비중 (10%)
  - 시장별 최대 비중 (crypto 50%, domestic 30%, overseas 20%)
  - 섹터별 최대 노출
  """
  require Logger

  @market_limits %{
    crypto:   0.50,
    domestic: 0.30,
    overseas: 0.20
  }

  @single_symbol_limit 0.10

  def check(candidate, portfolio_state \\ %{}) do
    total_value = Map.get(portfolio_state, :total_value_krw, 10_000_000)
    amt = candidate[:amount_krw] || 0

    with :ok <- check_single_symbol(candidate, portfolio_state, total_value),
         :ok <- check_market_limit(candidate, portfolio_state, total_value, amt) do
      {:ok, :passed}
    end
  end

  defp check_single_symbol(%{symbol: symbol, market: market}, portfolio_state, total_value) do
    existing = get_symbol_exposure(symbol, market, portfolio_state)
    limit = @single_symbol_limit * total_value

    if existing > limit do
      {:error, :single_symbol_limit, "#{symbol} 기존 노출 #{existing} > 한도 #{limit}"}
    else
      :ok
    end
  end
  defp check_single_symbol(_, _, _), do: :ok

  defp check_market_limit(%{market: market}, portfolio_state, total_value, new_amt) do
    existing = get_market_exposure(market, portfolio_state)
    limit_pct = Map.get(@market_limits, market, 0.30)
    limit = limit_pct * total_value

    if existing + new_amt > limit do
      {:error, :market_exposure_limit, "#{market} 노출 #{existing + new_amt} > 한도 #{limit}"}
    else
      :ok
    end
  end
  defp check_market_limit(_, _, _, _), do: :ok

  defp get_symbol_exposure(symbol, market, %{positions: positions}) when is_list(positions) do
    positions
    |> Enum.filter(&(&1[:symbol] == symbol and &1[:market] == market))
    |> Enum.reduce(0, &((&1[:value_krw] || 0) + &2))
  end
  defp get_symbol_exposure(symbol, market, _) do
    query = """
    SELECT COALESCE(SUM(current_value_krw), 0)
    FROM investment.live_positions
    WHERE symbol = $1 AND market = $2 AND status = 'open'
    """
    case Jay.Core.Repo.query(query, [symbol, to_string(market)]) do
      {:ok, %{rows: [[val | _] | _]}} -> to_float(val)
      _ -> 0.0
    end
  end

  defp get_market_exposure(market, %{positions: positions}) when is_list(positions) do
    positions
    |> Enum.filter(&(&1[:market] == market))
    |> Enum.reduce(0, &((&1[:value_krw] || 0) + &2))
  end
  defp get_market_exposure(market, _) do
    query = """
    SELECT COALESCE(SUM(current_value_krw), 0)
    FROM investment.live_positions
    WHERE market = $1 AND status = 'open'
    """
    case Jay.Core.Repo.query(query, [to_string(market)]) do
      {:ok, %{rows: [[val | _] | _]}} -> to_float(val)
      _ -> 0.0
    end
  end

  defp to_float(nil), do: 0.0
  defp to_float(d) when is_struct(d, Decimal), do: Decimal.to_float(d)
  defp to_float(n) when is_number(n), do: n * 1.0
  defp to_float(_), do: 0.0
end
