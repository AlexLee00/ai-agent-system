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
  alias Luna.V2.MarketHoursGate

  @min_order_krw 10_000
  @max_order_krw 5_000_000
  @duplicate_cooldown_minutes 60

  @blacklist_symbols ~w[LUNA2 LUNC UST BUSD]

  # KIS 전략 개선 (2026-05-12): 33 LIVE 거래 분석 기반
  # Shadow mode: true → 로그만, false → 실제 차단
  @kis_shadow_mode true

  # 09시(장시작 15.4% 승률 -$186), 15시(마감 0% 승률 -$110) 차단
  @kis_blocked_hours_kst [9, 15]

  # 반복 + 0% 승률 종목 차단
  @kis_blacklist_symbols ~w[018470 100090 008350 322000 066970 005870]

  # SMA 기반 전략만 허용 (normal_exit 11% vs strategy_exit 25%)
  @kis_allowed_strategy_families ~w[equity_swing sma_crossover sma_pullback]

  def check(candidate, context \\ %{}) do
    with :ok <- check_notional(candidate),
         :ok <- check_balance(candidate, context),
         :ok <- check_duplicate(candidate),
         :ok <- check_blacklist(candidate),
         :ok <- check_market_hours(candidate),
         :ok <- check_kis_rules(candidate) do
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

      _ ->
        :ok
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
    gate = MarketHoursGate.status(market)
    if gate.open, do: :ok, else: {:error, :market_closed, "#{market} 시장 시간 외 (#{gate.reason})"}
  end

  defp check_market_hours(_), do: :ok

  # ── KIS 전략 개선 규칙 (Shadow Mode 지원) ────────────────────────────────

  defp check_kis_rules(%{exchange: ex} = candidate) when ex in ["kis", :kis] do
    violations =
      []
      |> maybe_add(check_kis_time_slot(), :kis_blocked_hour)
      |> maybe_add(check_kis_symbol(candidate), :kis_blacklisted_symbol)
      |> maybe_add(check_kis_strategy(candidate), :kis_non_sma_strategy)

    case violations do
      [] ->
        :ok

      reasons ->
        combined = Enum.join(reasons, "; ")
        Logger.info("[HardRule/KIS] #{@kis_shadow_mode && "SHADOW" || "BLOCK"} #{candidate[:symbol]}: #{combined}")
        if @kis_shadow_mode, do: :ok, else: {:error, :kis_rule_violation, combined}
    end
  end

  defp check_kis_rules(_), do: :ok

  defp check_kis_time_slot do
    kst_hour = kst_hour_now()

    if kst_hour in @kis_blocked_hours_kst do
      "시간 차단 #{kst_hour}시 KST"
    else
      nil
    end
  end

  defp check_kis_symbol(%{symbol: symbol}) when is_binary(symbol) do
    if symbol in @kis_blacklist_symbols do
      "종목 블랙리스트 #{symbol}"
    else
      nil
    end
  end

  defp check_kis_symbol(_), do: nil

  defp check_kis_strategy(%{strategy_family: family}) when is_binary(family) do
    unless family in @kis_allowed_strategy_families do
      "비SMA 전략 #{family} (허용: #{Enum.join(@kis_allowed_strategy_families, "/")})"
    end
  end

  defp check_kis_strategy(_), do: nil

  defp maybe_add(list, nil, _tag), do: list
  defp maybe_add(list, reason, _tag) when is_binary(reason), do: [reason | list]

  defp kst_hour_now do
    utc = DateTime.utc_now()
    {:ok, kst} = DateTime.shift_zone(utc, "Asia/Seoul")
    kst.hour
  rescue
    _ ->
      # Asia/Seoul 타임존 미사용 환경 폴백
      utc = DateTime.utc_now()
      rem(utc.hour + 9, 24)
  end
end
