defmodule TeamJay.Dashboard.MilestoneSentry do
  @moduledoc """
  Visibility v3.3 milestone status sentry.

  The sentry periodically reconciles project milestones without destructive
  writes: done-linked milestones become `achieved`, overdue incomplete
  milestones become `missed`, and future incomplete milestones stay `upcoming`.
  """

  use GenServer
  require Logger

  alias TeamJay.Dashboard.ProjectRepo

  @default_interval_ms 5 * 60 * 1_000

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  def reconcile_now do
    GenServer.call(__MODULE__, :reconcile_now, 30_000)
  end

  @impl true
  def init(opts) do
    interval_ms = Keyword.get(opts, :interval_ms, interval_ms())
    enabled? = Keyword.get(opts, :enabled?, enabled?())

    state = %{enabled?: enabled?, interval_ms: interval_ms}

    if enabled? do
      Process.send_after(self(), :reconcile, min(interval_ms, 60_000))
      Logger.info("[MilestoneSentry] enabled interval_ms=#{interval_ms}")
    else
      Logger.info("[MilestoneSentry] disabled")
    end

    {:ok, state}
  end

  @impl true
  def handle_call(:reconcile_now, _from, state) do
    {:reply, run_reconcile(), state}
  end

  @impl true
  def handle_info(:reconcile, %{enabled?: true, interval_ms: interval_ms} = state) do
    result = run_reconcile()

    Logger.info(
      "[MilestoneSentry] checked=#{result.checked} changed=#{result.changed} achieved=#{result.achieved} missed=#{result.missed}"
    )

    Process.send_after(self(), :reconcile, interval_ms)
    {:noreply, state}
  end

  def handle_info(:reconcile, state), do: {:noreply, state}

  defp run_reconcile do
    ProjectRepo.reconcile_milestones!()
  rescue
    error ->
      Logger.warning("[MilestoneSentry] reconcile failed: #{inspect(error)}")
      %{checked: 0, changed: 0, achieved: 0, missed: 0, error: inspect(error)}
  end

  defp interval_ms do
    System.get_env("TEAM_JAY_MILESTONE_SENTRY_INTERVAL_MS", "#{@default_interval_ms}")
    |> String.to_integer()
  rescue
    _ -> @default_interval_ms
  end

  defp enabled? do
    System.get_env("TEAM_JAY_MILESTONE_SENTRY_ENABLED", "true") in ["1", "true", "TRUE", "yes"]
  end
end
