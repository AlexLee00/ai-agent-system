defmodule Luna.V2.Skill.RiskGovernor do
  @moduledoc "실시간 리스크 한도 점검 — Nemesis L20 Hard Rule 미러 (Elixir 레이어)"
  use Jido.Action,
    name: "risk_governor",
    description: "현재 포지션 규모·손실 한도·집중도 위반 여부를 점검합니다.",
    schema: [
      symbol:   [type: :string, required: false, doc: "특정 심볼 점검 (없으면 전체)"],
      exchange: [type: :string, required: false, doc: "거래소 필터"]
    ]

  require Logger

  # 하드코딩 한도 (config.yaml 값과 동기화 필요 — 추후 runtime-config 연동)
  @max_single_position_pct 0.20   # 단일 포지션 최대 20% NAV
  @daily_loss_limit_usd    200.0  # 일일 손실 한도 $200

  # KIS Stop Loss 강화 (2026-05-12): 데이터 기반 -2% 절대
  # force_exit 7건 -$201 방지 목적
  @kis_sl_pct 0.02

  def kis_stop_loss_pct, do: @kis_sl_pct

  def kis_stop_loss_price(entry_price) do
    entry = to_float(entry_price)
    if entry > 0, do: Float.round(entry * (1.0 - @kis_sl_pct), 6), else: nil
  end

  def kis_stop_loss_shadow(position, current_price) when is_map(position) do
    entry_price = to_float(Map.get(position, :entry_price, Map.get(position, "entry_price")))
    current = to_float(current_price)
    stop_price = kis_stop_loss_price(entry_price)
    pnl_ratio = if entry_price > 0, do: current / entry_price - 1.0, else: 0.0

    %{
      shadow: true,
      mutate: false,
      entry_price: entry_price,
      current_price: current,
      stop_loss_pct: @kis_sl_pct,
      stop_loss_price: stop_price,
      breach: entry_price > 0 and current > 0 and pnl_ratio <= -@kis_sl_pct,
      pnl_ratio: pnl_ratio
    }
  end

  def run(%{symbol: symbol, exchange: exchange}, _context) do
    Logger.info("[루나V2/RiskGovernor] 리스크 점검 symbol=#{symbol} exchange=#{exchange}")

    violations = []
      |> check_position_concentration(symbol, exchange)
      |> check_total_exposure()
      |> check_daily_loss()
      |> check_kis_stop_loss(symbol, exchange)

    status = if violations == [], do: :ok, else: :violation
    {:ok, %{status: status, violations: violations, checked_at: DateTime.utc_now()}}
  end

  defp check_position_concentration(violations, symbol, exchange) do
    {filters, params} = symbol_exchange_filters(symbol, exchange)

    query = """
    SELECT symbol, exchange, ABS(size * entry_price) AS notional_usd
    FROM investment.live_positions
    WHERE status = 'open'
    #{filters}
    ORDER BY notional_usd DESC
    LIMIT 10
    """

    case Jay.Core.Repo.query(query, params) do
      {:ok, %{rows: rows}} ->
        oversized = Enum.filter(rows, fn [_, _, notional] ->
          to_float(notional) > @max_single_position_pct * 10_000
        end)
        if oversized != [] do
          [{:concentration_exceeded, Enum.map(oversized, fn [sym, ex, n] -> "#{ex}/#{sym} $#{n}" end)} | violations]
        else
          violations
        end
      _ -> violations
    end
  end

  defp check_total_exposure(violations) do
    violations  # TODO: NAV 대비 전체 노출 계산
  end

  defp check_daily_loss(violations) do
    query = """
    SELECT COALESCE(SUM(realized_pnl_usd), 0)
    FROM investment.live_positions
    WHERE DATE(created_at AT TIME ZONE 'Asia/Seoul') = CURRENT_DATE
      AND realized_pnl_usd < 0
    """
    case Jay.Core.Repo.query(query, []) do
      {:ok, %{rows: [[loss | _] | _]}} when not is_nil(loss) ->
        loss_f = if is_struct(loss, Decimal), do: Decimal.to_float(loss), else: loss
        if abs(loss_f) > @daily_loss_limit_usd do
          [{:daily_loss_exceeded, "일일 손실 $#{abs(loss_f)} > 한도 $#{@daily_loss_limit_usd}"} | violations]
        else
          violations
        end
      _ -> violations
    end
  end

  # KIS 포지션 -2% SL 위반 체크 (force_exit 사전 방지)
  defp check_kis_stop_loss(violations, symbol, exchange)
       when exchange in [nil, "", "kis", :kis, "kis_overseas", :kis_overseas] do
    {filters, params} = kis_stop_loss_filters(symbol, exchange)

    query = """
    SELECT symbol, exchange,
      CASE
        WHEN COALESCE(size, 0) * COALESCE(entry_price, 0) > 0
        THEN COALESCE(unrealized_pnl, 0) / (COALESCE(size, 0) * COALESCE(entry_price, 0))
        ELSE NULL
      END AS pnl_ratio
    FROM investment.live_positions
    WHERE status = 'open'
      #{filters}
    """

    case Jay.Core.Repo.query(query, params) do
      {:ok, %{rows: rows}} ->
        breaches =
          Enum.filter(rows, fn [_, _, pnl_ratio] ->
            not is_nil(pnl_ratio) and to_float(pnl_ratio) < -@kis_sl_pct
          end)

        if breaches != [] do
          msgs = Enum.map(breaches, fn [sym, ex, ratio] ->
            ratio_f = if is_struct(ratio, Decimal), do: Decimal.to_float(ratio), else: ratio
            "#{ex}/#{sym} PnL #{Float.round(ratio_f * 100, 2)}% < -#{@kis_sl_pct * 100}%"
          end)
          [{:kis_sl_breach, msgs} | violations]
        else
          violations
        end

      _ ->
        violations
    end
  end

  defp check_kis_stop_loss(violations, _symbol, _exchange), do: violations

  defp symbol_exchange_filters(symbol, exchange) do
    []
    |> maybe_add_filter([], "symbol", symbol)
    |> maybe_add_filter("exchange", exchange)
    |> render_filters()
  end

  defp kis_stop_loss_filters(symbol, exchange) do
    base_exchange =
      if exchange in ["kis", :kis, "kis_overseas", :kis_overseas] do
        {[filter_clause("exchange", 1)], [to_string(exchange)]}
      else
        {["AND exchange IN ('kis', 'kis_overseas')"], []}
      end

    base_exchange
    |> maybe_add_filter("symbol", symbol)
    |> render_filters()
  end

  defp maybe_add_filter({clauses, params}, column, value) do
    if present?(value) do
      {[filter_clause(column, length(params) + 1) | clauses], params ++ [to_string(value)]}
    else
      {clauses, params}
    end
  end

  defp maybe_add_filter(clauses, params, column, value) when is_list(clauses) and is_list(params) do
    maybe_add_filter({clauses, params}, column, value)
  end

  defp filter_clause(column, index), do: "AND #{column} = $#{index}"

  defp render_filters({clauses, params}) do
    {clauses |> Enum.reverse() |> Enum.join("\n"), params}
  end

  defp present?(nil), do: false
  defp present?(""), do: false
  defp present?(_), do: true

  defp to_float(nil), do: 0.0
  defp to_float(value) when is_float(value), do: value
  defp to_float(value) when is_integer(value), do: value * 1.0
  defp to_float(%Decimal{} = value), do: Decimal.to_float(value)

  defp to_float(value) do
    case Float.parse(to_string(value)) do
      {parsed, _} -> parsed
      _ -> 0.0
    end
  end
end
