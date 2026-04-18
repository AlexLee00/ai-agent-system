defmodule Luna.V2.Policy.HardRuleEngine do
  @moduledoc """
  L20 하드룰 엔진 — 절대 차단 규칙 (deterministic, no LLM).

  - min/max 주문 금액
  - 최소 잔고 확보
  - 중복 포지션 쿨다운
  - 블랙리스트 심볼
  - 시장 시간 외 주문 (crypto 제외)
  """
  require Logger

  @min_order_krw 10_000
  @max_order_krw 5_000_000
  @duplicate_cooldown_minutes 60

  @blacklist_symbols ~w[LUNA2 LUNC UST BUSD]

  def check(candidate, context \\ %{}) do
    with :ok <- check_notional(candidate),
         :ok <- check_balance(candidate, context),
         :ok <- check_duplicate(candidate),
         :ok <- check_blacklist(candidate),
         :ok <- check_market_hours(candidate) do
      {:ok, :passed}
    end
  end

  defp check_notional(%{amount_krw: amt}) when is_number(amt) do
    cond do
      amt < @min_order_krw -> {:error, :min_order_notional, "주문 금액 #{amt} < 최소 #{@min_order_krw}"}
      amt > @max_order_krw -> {:error, :max_order_notional, "주문 금액 #{amt} > 최대 #{@max_order_krw}"}
      true -> :ok
    end
  end
  defp check_notional(_), do: :ok

  defp check_balance(%{amount_krw: amt}, %{available_krw: avail}) when is_number(avail) do
    buffer = avail * 0.1
    if amt > avail - buffer do
      {:error, :insufficient_balance, "잔고 부족: 필요 #{amt}, 가용 #{avail - buffer}"}
    else
      :ok
    end
  end
  defp check_balance(_, _), do: :ok

  defp check_duplicate(%{symbol: symbol, market: market}) do
    query = """
    SELECT COUNT(*) FROM investment.live_positions
    WHERE symbol = $1
      AND market = $2
      AND status = 'open'
      AND created_at > NOW() - INTERVAL '#{@duplicate_cooldown_minutes} minutes'
    """
    case Jay.Core.Repo.query(query, [symbol, to_string(market)]) do
      {:ok, %{rows: [[count | _] | _]}} when count > 0 ->
        {:error, :duplicate_position, "#{symbol} 쿨다운 #{@duplicate_cooldown_minutes}분 미경과"}
      _ -> :ok
    end
  end
  defp check_duplicate(_), do: :ok

  defp check_blacklist(%{symbol: symbol}) do
    if symbol in @blacklist_symbols do
      {:error, :blacklisted_symbol, "#{symbol} 블랙리스트 심볼"}
    else
      :ok
    end
  end
  defp check_blacklist(_), do: :ok

  defp check_market_hours(%{market: :crypto}), do: :ok
  defp check_market_hours(%{market: market}) do
    now_kst = DateTime.utc_now() |> DateTime.add(9 * 3600, :second)
    hour = now_kst.hour
    minute = now_kst.minute
    day = Date.day_of_week(DateTime.to_date(now_kst))

    open? = case market do
      :domestic -> day in 1..5 and (hour > 9 or (hour == 9 and minute >= 0)) and hour < 15
      :overseas -> day in 1..5 and (hour >= 22 or hour < 5)
      _ -> false
    end

    if open?, do: :ok, else: {:error, :market_closed, "#{market} 시장 시간 외"}
  end
  defp check_market_hours(_), do: :ok
end
