defmodule Luna.V2.Prediction.Engine do
  @moduledoc """
  확률 feature 공급 엔진 (Freqtrade FreqAI 영감).

  단독 실행권 없음 — Luna/Nemesis의 입력 feature로만 사용.
  모든 계산은 deterministic (수학/통계, no LLM).

  생성 feature:
  - breakout_probability  : 이탈 확률
  - trend_cont_probability: 추세 지속 확률
  - regime_probability    : regime 전환 확률
  - expected_vol_band     : 예상 변동성 밴드
  - mean_rev_signal       : 평균 회귀 신호
  """
  use GenServer
  require Logger

  @snapshot_interval_ms 5 * 60_000  # 5분

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  def predict(symbol, market) do
    GenServer.call(__MODULE__, {:predict, symbol, market}, 30_000)
  end

  def get_latest(symbol, market) do
    GenServer.call(__MODULE__, {:get_latest, symbol, market})
  end

  # ─── GenServer ───────────────────────────────────────────────────

  def init(_opts) do
    schedule_snapshot()
    {:ok, %{cache: %{}}}
  end

  def handle_call({:predict, symbol, market}, _from, state) do
    features = compute_features(symbol, market)
    save_snapshot(symbol, market, features)
    new_cache = put_in(state.cache, [{symbol, market}], features)
    {:reply, {:ok, features}, %{state | cache: new_cache}}
  end

  def handle_call({:get_latest, symbol, market}, _from, state) do
    case Map.get(state.cache, {symbol, market}) do
      nil ->
        result = fetch_latest_snapshot(symbol, market)
        {:reply, result, state}
      cached ->
        {:reply, {:ok, cached}, state}
    end
  end

  def handle_info(:snapshot_tick, state) do
    # 활성 심볼에 대해 주기적 스냅샷
    Task.start(fn -> refresh_active_symbols() end)
    schedule_snapshot()
    {:noreply, state}
  end

  # ─── Feature 계산 ─────────────────────────────────────────────────

  defp compute_features(symbol, market) do
    ohlcv = fetch_recent_ohlcv(symbol, market, 50)

    %{
      symbol:               symbol,
      market:               market,
      breakout_prob:        calc_breakout_probability(ohlcv),
      trend_cont_prob:      calc_trend_continuation(ohlcv),
      regime_prob:          calc_regime_transition(ohlcv),
      expected_vol_band:    calc_vol_band(ohlcv),
      mean_rev_signal:      calc_mean_reversion(ohlcv),
      computed_at:          DateTime.utc_now()
    }
  end

  defp calc_breakout_probability(ohlcv) when length(ohlcv) >= 20 do
    closes = Enum.map(ohlcv, &elem(&1, 3))
    highs  = Enum.map(ohlcv, &elem(&1, 1))
    lows   = Enum.map(ohlcv, &elem(&1, 2))

    recent_20 = Enum.take(closes, 20)
    last_close = hd(closes)
    resistance = Enum.max(highs |> Enum.take(20))
    support    = Enum.min(lows  |> Enum.take(20))

    range = resistance - support
    if range <= 0 do
      0.5
    else
      position = (last_close - support) / range
      vol_norm = calc_volatility_norm(recent_20)
      min(1.0, max(0.0, position * 0.6 + vol_norm * 0.4))
    end
  end
  defp calc_breakout_probability(_), do: 0.5

  defp calc_trend_continuation(ohlcv) when length(ohlcv) >= 10 do
    closes = Enum.map(ohlcv, &elem(&1, 3)) |> Enum.take(10)
    diffs = Enum.zip(closes, tl(closes)) |> Enum.map(fn {a, b} -> b - a end)
    positive = Enum.count(diffs, &(&1 > 0))
    min(1.0, max(0.0, positive / length(diffs)))
  end
  defp calc_trend_continuation(_), do: 0.5

  defp calc_regime_transition(ohlcv) when length(ohlcv) >= 30 do
    closes = Enum.map(ohlcv, &elem(&1, 3))
    vol_short = calc_volatility_norm(Enum.take(closes, 5))
    vol_long  = calc_volatility_norm(Enum.take(closes, 30))
    if vol_long > 0, do: min(1.0, vol_short / vol_long), else: 0.5
  end
  defp calc_regime_transition(_), do: 0.5

  defp calc_vol_band(ohlcv) when length(ohlcv) >= 20 do
    closes = Enum.map(ohlcv, &elem(&1, 3)) |> Enum.take(20)
    avg = Enum.sum(closes) / length(closes)
    variance = Enum.reduce(closes, 0, fn c, acc -> acc + (c - avg) * (c - avg) end) / length(closes)
    stdev = :math.sqrt(variance)
    %{upper: avg + 2 * stdev, lower: avg - 2 * stdev, mid: avg, stdev: stdev}
  end
  defp calc_vol_band(_), do: %{upper: 0, lower: 0, mid: 0, stdev: 0}

  defp calc_mean_reversion(ohlcv) when length(ohlcv) >= 20 do
    closes = Enum.map(ohlcv, &elem(&1, 3))
    last = hd(closes)
    avg = Enum.sum(Enum.take(closes, 20)) / 20
    if avg > 0, do: min(1.0, max(-1.0, (avg - last) / avg)), else: 0.0
  end
  defp calc_mean_reversion(_), do: 0.0

  defp calc_volatility_norm(closes) when length(closes) >= 2 do
    diffs = Enum.zip(closes, tl(closes)) |> Enum.map(fn {a, b} -> abs((b - a) / max(a, 0.001)) end)
    Enum.sum(diffs) / length(diffs)
  end
  defp calc_volatility_norm(_), do: 0.0

  defp fetch_recent_ohlcv(symbol, market, limit) do
    query = """
    SELECT timestamp, high, low, close, volume
    FROM investment.ohlcv_cache
    WHERE symbol = $1 AND market = $2
    ORDER BY timestamp DESC
    LIMIT $3
    """
    case Jay.Core.Repo.query(query, [symbol, to_string(market), limit]) do
      {:ok, %{rows: rows}} ->
        Enum.map(rows, fn [ts, h, l, c, v] -> {ts, to_f(h), to_f(l), to_f(c), to_f(v)} end)
      _ -> []
    end
  end

  defp save_snapshot(symbol, market, features) do
    query = """
    INSERT INTO luna_prediction_feature_snapshot (symbol, market, timestamp, features)
    VALUES ($1, $2, NOW(), $3)
    """
    Jay.Core.Repo.query(query, [symbol, to_string(market), Jason.encode!(features)])
  rescue
    _ -> :ok
  end

  defp fetch_latest_snapshot(symbol, market) do
    query = """
    SELECT features FROM luna_prediction_feature_snapshot
    WHERE symbol = $1 AND market = $2
    ORDER BY timestamp DESC LIMIT 1
    """
    case Jay.Core.Repo.query(query, [symbol, to_string(market)]) do
      {:ok, %{rows: [[features | _] | _]}} when is_map(features) -> {:ok, features}
      _ -> {:error, :no_snapshot}
    end
  end

  defp refresh_active_symbols do
    query = "SELECT DISTINCT symbol, market FROM investment.live_positions WHERE status = 'open'"
    case Jay.Core.Repo.query(query, []) do
      {:ok, %{rows: rows}} ->
        Enum.each(rows, fn [sym, mkt] -> compute_features(sym, String.to_atom(mkt)) end)
      _ -> :ok
    end
  rescue
    _ -> :ok
  end

  defp schedule_snapshot do
    Process.send_after(self(), :snapshot_tick, @snapshot_interval_ms)
  end

  defp to_f(nil), do: 0.0
  defp to_f(d) when is_struct(d, Decimal), do: Decimal.to_float(d)
  defp to_f(n) when is_number(n), do: n * 1.0
  defp to_f(_), do: 0.0
end
