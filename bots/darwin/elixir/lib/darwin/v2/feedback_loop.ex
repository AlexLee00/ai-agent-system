defmodule Darwin.V2.FeedbackLoop do
  @moduledoc "다윈 V2 FeedbackLoop — PortAgent를 통해 기존 TS 로직 위임 + Phase 3에서 완전 Elixir 전환 예정."

  use GenServer
  require Logger

  def start_link(opts \\  []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @impl GenServer
  def init(_opts) do
    Logger.info("[darwin/feedback_loop] 시작")
    {:ok, %{}}
  end

  @impl GenServer
  def handle_cast(msg, state) do
    Logger.debug("[darwin/feedback_loop] cast: #{inspect(msg)}")
    {:noreply, state}
  end

  @impl GenServer
  def handle_info(msg, state) do
    Logger.debug("[darwin/feedback_loop] info: #{inspect(msg)}")
    {:noreply, state}
  end

  @impl GenServer
  def handle_call(msg, _from, state) do
    Logger.debug("[darwin/feedback_loop] call: #{inspect(msg)}")
    {:reply, :ok, state}
  end
end
