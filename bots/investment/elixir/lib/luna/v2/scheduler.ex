defmodule Luna.V2.Scheduler do
  @moduledoc """
  Luna V2 시장 스케줄러 — 시장별 주기 기동.

  crypto:          60초 tick → MapeKLoop.trigger_cycle(:crypto) (24/7)
  domestic/overseas: 180초 tick → MarketHoursGate.open? 확인 후 실행

  Kill Switch: LUNA_SCHEDULER_ENABLED=true
  """
  use GenServer
  require Logger

  alias Luna.V2.{MapeKLoop, MarketHoursGate, KillSwitch}

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  def status do
    GenServer.call(__MODULE__, :status)
  end

  # ─── GenServer ───────────────────────────────────────────────────

  def init(_opts) do
    crypto_interval = crypto_interval_ms()
    domestic_interval = stock_market_open_interval_ms(:domestic)
    overseas_interval = stock_market_open_interval_ms(:overseas)

    Logger.info(
      "[Scheduler] 기동 — crypto #{crypto_interval}ms / domestic-open #{domestic_interval}ms / overseas-open #{overseas_interval}ms"
    )

    schedule(:crypto, crypto_interval)
    schedule(:domestic, stock_interval_for(:domestic))
    schedule(:overseas, stock_interval_for(:overseas))
    {:ok, %{ticks: %{crypto: 0, domestic: 0, overseas: 0}, started_at: DateTime.utc_now()}}
  end

  def handle_call(:status, _from, state) do
    {:reply, state, state}
  end

  def handle_info({:tick, :crypto}, state) do
    if KillSwitch.mapek_enabled?() do
      MapeKLoop.trigger_cycle(:crypto)
    end

    schedule(:crypto, crypto_interval_ms())
    {:noreply, update_in(state, [:ticks, :crypto], &(&1 + 1))}
  end

  def handle_info({:tick, market}, state) when market in [:domestic, :overseas] do
    if KillSwitch.mapek_enabled?() and MarketHoursGate.open?(market) do
      MapeKLoop.trigger_cycle(market)
    end

    schedule(market, stock_interval_for(market))
    {:noreply, update_in(state, [:ticks, market], &(&1 + 1))}
  end

  def handle_info(_, state), do: {:noreply, state}

  # ─── Internal ────────────────────────────────────────────────────

  defp schedule(market, interval_ms) do
    Process.send_after(self(), {:tick, market}, interval_ms)
  end

  defp crypto_interval_ms do
    max(15_000, KillSwitch.position_watch_crypto_realtime_ms())
  end

  defp stock_market_open_interval_ms(:domestic),
    do: max(15_000, KillSwitch.position_watch_domestic_realtime_ms())

  defp stock_market_open_interval_ms(:overseas),
    do: max(15_000, KillSwitch.position_watch_overseas_realtime_ms())

  defp stock_market_open_interval_ms(_market),
    do: max(15_000, KillSwitch.position_watch_stock_realtime_ms())

  defp stock_market_closed_interval_ms do
    max(60_000, KillSwitch.position_watch_stock_offhours_ms())
  end

  defp stock_interval_for(market) do
    if MarketHoursGate.open?(market),
      do: stock_market_open_interval_ms(market),
      else: stock_market_closed_interval_ms()
  end
end
