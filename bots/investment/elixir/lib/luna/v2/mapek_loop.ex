defmodule Luna.V2.MapeKLoop do
  @moduledoc """
  MAPE-K 완전자율 피드백 루프 GenServer.

  Monitor → Analyze → Plan → Execute → Knowledge → (Monitor로 복귀)

  시장별 주기:
  - crypto:   60초 (24/7)
  - domestic: 120초 (장중 09:00~15:30 KST)
  - overseas: 120초 (장중 22:30~05:00 KST)
  """
  use GenServer
  require Logger

  alias Luna.V2.Commander
  alias Luna.V2.KillSwitch

  @crypto_interval_ms   60_000   # 1분
  @domestic_interval_ms 120_000  # 2분
  @overseas_interval_ms 120_000  # 2분

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  def trigger_cycle(market) do
    GenServer.cast(__MODULE__, {:run_cycle, market})
  end

  def status do
    GenServer.call(__MODULE__, :status)
  end

  # ─── GenServer ───────────────────────────────────────────────────

  def init(_opts) do
    if KillSwitch.mapek_enabled?() do
      Logger.info("[루나V2/MAPE-K] 완전자율 루프 시작")

      # JayBus 구독 (실시간 이벤트)
      Phoenix.PubSub.subscribe(Luna.V2.PubSub, "luna:mapek_events")

      # 시장별 주기적 사이클 시작
      start_market_loop(:crypto, @crypto_interval_ms)
      start_market_loop(:domestic, @domestic_interval_ms)
      start_market_loop(:overseas, @overseas_interval_ms)
    end

    {:ok, %{cycles: %{crypto: 0, domestic: 0, overseas: 0}, last_runs: %{}}}
  end

  # 실시간 이벤트 대응
  def handle_info({:luna_event, topic, payload}, state) do
    market = extract_market_from_topic(topic)
    if market && should_trigger_cycle?(topic, payload) do
      Task.start(fn -> run_cycle_safe(market, []) end)
    end
    {:noreply, state}
  end

  # MAPE-K 내부 이벤트
  def handle_info({:evaluate_signal, signal_params}, state) do
    market = signal_params[:market] || :crypto
    if should_trigger_now?(market) do
      Task.start(fn -> run_cycle_safe(market, []) end)
    end
    {:noreply, state}
  end

  def handle_info({:cycle_complete, %{market: market}}, state) do
    new_cycles = Map.update(state.cycles, market, 1, &(&1 + 1))
    {:noreply, %{state | cycles: new_cycles, last_runs: Map.put(state.last_runs, market, DateTime.utc_now())}}
  end

  # 주기적 사이클 tick
  def handle_info({:market_tick, market, interval_ms}, state) do
    if KillSwitch.mapek_enabled?() and market_active?(market) do
      Task.start(fn -> run_cycle_safe(market, []) end)
    end
    start_market_loop(market, interval_ms)
    {:noreply, state}
  end

  def handle_cast({:run_cycle, market}, state) do
    Task.start(fn -> run_cycle_safe(market, []) end)
    {:noreply, state}
  end

  def handle_call(:status, _from, state) do
    {:reply, state, state}
  end

  # ─── 사이클 실행 ───────────────────────────────────────────────

  defp run_cycle_safe(market, opts) do
    shadow? = not KillSwitch.live_enabled?(market)

    case Commander.run_cycle(market, Keyword.put(opts, :shadow, shadow?)) do
      {:ok, result} ->
        Logger.info("[루나V2/MAPE-K] #{market} 사이클 완료 — shadow=#{shadow?} result=#{inspect(Map.keys(result))}")
      {:error, reason} ->
        Logger.warning("[루나V2/MAPE-K] #{market} 사이클 실패: #{inspect(reason)}")
    end
  rescue
    e ->
      Logger.error("[루나V2/MAPE-K] 사이클 예외 — market=#{market}: #{inspect(e)}")
  end

  # ─── 유틸 ─────────────────────────────────────────────────────

  defp start_market_loop(market, interval_ms) do
    Process.send_after(self(), {:market_tick, market, interval_ms}, interval_ms)
  end

  defp market_active?(:crypto), do: true  # 24/7
  defp market_active?(:domestic) do
    now_kst = DateTime.utc_now() |> DateTime.add(9 * 3600, :second)
    h = now_kst.hour
    day = Date.day_of_week(DateTime.to_date(now_kst))
    day in 1..5 and h >= 9 and h < 15
  end
  defp market_active?(:overseas) do
    now_kst = DateTime.utc_now() |> DateTime.add(9 * 3600, :second)
    h = now_kst.hour
    day = Date.day_of_week(DateTime.to_date(now_kst))
    day in 1..5 and (h >= 22 or h < 5)
  end
  defp market_active?(_), do: false

  defp should_trigger_cycle?(topic, _payload) do
    # orderbook/kline 이벤트만 사이클 트리거
    String.contains?(topic, "kline") or String.contains?(topic, "tick")
  end

  defp should_trigger_now?(market) do
    # 동일 시장 2분 이내 중복 사이클 방지
    market_active?(market)
  end

  defp extract_market_from_topic(topic) do
    cond do
      String.contains?(topic, "binance") -> :crypto
      String.contains?(topic, "kis") -> :domestic
      true -> nil
    end
  end
end
