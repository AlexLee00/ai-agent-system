defmodule TeamJay.Claude.Codex.CodexPipeline do
  @moduledoc """
  Deprecated compatibility shim.

  Historical CODEX pipeline execution from `docs/codex` is intentionally
  disabled. Claude auto implementation is centralized on `docs/auto_dev`.
  """

  use GenServer
  require Logger

  defstruct pending: %{},
            running: nil,
            history: [],
            approved: [],
            disabled: true

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  def codex_detected(name, path, type) do
    GenServer.cast(__MODULE__, {:ignored, :detected, name, path, type})
  end

  def approve(codex_name) do
    GenServer.cast(__MODULE__, {:ignored, :approve, codex_name})
  end

  def reject(codex_name) do
    GenServer.cast(__MODULE__, {:ignored, :reject, codex_name})
  end

  def get_status do
    GenServer.call(__MODULE__, :get_status)
  end

  def list_pending do
    GenServer.call(__MODULE__, :list_pending)
  end

  @impl true
  def init(_opts) do
    Logger.info("[CodexPipeline] disabled: docs/codex execution path is decommissioned")
    {:ok, %__MODULE__{}}
  end

  @impl true
  def handle_cast({:ignored, action, name, path, type}, state) do
    Logger.info(
      "[CodexPipeline] ignored #{action}: #{inspect(name)} path=#{inspect(path)} type=#{inspect(type)}; use docs/auto_dev"
    )

    {:noreply, state}
  end

  def handle_cast({:ignored, action, name}, state) do
    Logger.info("[CodexPipeline] ignored #{action}: #{inspect(name)}; use docs/auto_dev")
    {:noreply, state}
  end

  @impl true
  def handle_call(:get_status, _from, state) do
    {:reply,
     %{
       disabled: state.disabled,
       reason: "docs/codex execution path decommissioned; use docs/auto_dev",
       pending: 0,
       running: nil,
       approved_waiting: 0,
       recent_history: []
     }, state}
  end

  def handle_call(:list_pending, _from, state) do
    {:reply, [], state}
  end
end
