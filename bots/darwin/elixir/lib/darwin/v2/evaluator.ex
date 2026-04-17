defmodule Darwin.V2.Evaluator do
  @moduledoc "다윈 V2 Evaluator — PortAgent를 통해 기존 TS 로직 위임 + Phase 3에서 완전 Elixir 전환 예정."

  use GenServer
  require Logger

  def start_link(opts \\  []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @impl GenServer
  def init(_opts) do
    Logger.info("[darwin/evaluator] 시작")
    {:ok, %{}}
  end

  @impl GenServer
  def handle_cast(msg, state) do
    Logger.debug("[darwin/evaluator] cast: #{inspect(msg)}")
    {:noreply, state}
  end

  @impl GenServer
  def handle_info(msg, state) do
    Logger.debug("[darwin/evaluator] info: #{inspect(msg)}")
    {:noreply, state}
  end

  @impl GenServer
  def handle_call(msg, _from, state) do
    Logger.debug("[darwin/evaluator] call: #{inspect(msg)}")
    {:reply, :ok, state}
  end
end
