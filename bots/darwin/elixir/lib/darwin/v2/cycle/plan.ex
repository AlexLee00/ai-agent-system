defmodule Darwin.V2.Cycle.Plan do
  @moduledoc "다윈 V2 Plan 사이클 GenServer — 7단계 R&D 루프의 Plan 단계."

  use GenServer
  require Logger

  def start_link(opts \\ []), do: GenServer.start_link(__MODULE__, opts, name: __MODULE__)

  @impl GenServer
  def init(_opts) do
    Logger.info("[darwin/cycle.plan] Plan 단계 기동")
    {:ok, %{runs: 0, last_run_at: nil}}
  end

  @doc "이 단계를 즉시 실행."
  def run_now(payload\\ %{}) do
    GenServer.cast(__MODULE__, {:run, payload})
  end

  @doc "현재 상태 조회."
  def status, do: GenServer.call(__MODULE__, :status)

  @impl GenServer
  def handle_call(:status, _from, state) do
    {:reply, Map.put(state, :phase, :plan), state}
  end

  @impl GenServer
  def handle_cast({:run, payload}, state) do
    Logger.debug("[darwin/cycle.plan] Plan 실행 — payload=#{inspect(payload)}")
    new_state = %{state | runs: state.runs + 1, last_run_at: DateTime.utc_now()}
    {:noreply, new_state}
  end
end
