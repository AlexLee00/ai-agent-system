defmodule TeamJay.Claude.Codex.CodexWatcher do
  @moduledoc """
  Deprecated compatibility shim.

  `docs/codex` must not trigger automatic implementation. The only supported
  Claude auto-dev inbox is `docs/auto_dev`, owned by the launchd-backed
  `bots/claude/scripts/auto-dev-runner.ts` pipeline.
  """

  use GenServer
  require Logger

  defstruct known_files: %{},
            scan_count: 0,
            last_scan: nil,
            disabled: true

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  def get_status do
    GenServer.call(__MODULE__, :get_status)
  end

  def scan_now do
    GenServer.cast(__MODULE__, :scan)
  end

  @impl true
  def init(_opts) do
    Logger.info("[CodexWatcher] disabled: docs/codex auto execution is decommissioned")
    {:ok, %__MODULE__{}}
  end

  @impl true
  def handle_cast(:scan, state) do
    Logger.info("[CodexWatcher] scan ignored: use docs/auto_dev for Claude auto-dev")
    {:noreply, %{state | scan_count: state.scan_count + 1, last_scan: DateTime.utc_now()}}
  end

  @impl true
  def handle_call(:get_status, _from, state) do
    {:reply,
     %{
       disabled: state.disabled,
       reason: "docs/codex auto execution decommissioned; use docs/auto_dev",
       known_files: map_size(state.known_files),
       scan_count: state.scan_count,
       last_scan: state.last_scan
     }, state}
  end
end
