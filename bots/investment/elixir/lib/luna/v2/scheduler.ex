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

  @crypto_interval_ms   60_000
  @stock_interval_ms   180_000

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  def status do
    GenServer.call(__MODULE__, :status)
  end

  # ─── GenServer ───────────────────────────────────────────────────

  def init(_opts) do
    Logger.info("[Scheduler] 기동 — crypto 60s / stock 180s")
    schedule(:crypto, @crypto_interval_ms)
    schedule(:domestic, @stock_interval_ms)
    schedule(:overseas, @stock_interval_ms)
    {:ok, %{ticks: %{crypto: 0, domestic: 0, overseas: 0}, started_at: DateTime.utc_now()}}
  end

  def handle_call(:status, _from, state) do
    {:reply, state, state}
  end

  def handle_info({:tick, :crypto}, state) do
    if KillSwitch.mapek_enabled?() do
      MapeKLoop.trigger_cycle(:crypto)
    end
    schedule(:crypto, @crypto_interval_ms)
    {:noreply, update_in(state, [:ticks, :crypto], &(&1 + 1))}
  end

  def handle_info({:tick, market}, state) when market in [:domestic, :overseas] do
    if KillSwitch.mapek_enabled?() and MarketHoursGate.open?(market) do
      MapeKLoop.trigger_cycle(market)
    end
    schedule(market, @stock_interval_ms)
    {:noreply, update_in(state, [:ticks, market], &(&1 + 1))}
  end

  def handle_info(_, state), do: {:noreply, state}

  # ─── Internal ────────────────────────────────────────────────────

  defp schedule(market, interval_ms) do
    Process.send_after(self(), {:tick, market}, interval_ms)
  end
end
