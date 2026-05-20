defmodule TeamJay.Dashboard.ProjectEventIngestor do
  @moduledoc """
  EventLake -> project schema bridge for Visibility v3.4.

  It listens to dashboard EventLake broadcasts and converts `codex.task.*` and
  `project.*` events into Project/Task/Milestone rows. The path is append/upsert
  only and does not launch, publish, trade, or restart anything.
  """

  use GenServer
  require Logger

  alias TeamJay.Dashboard.ProjectRepo

  @pubsub TeamJay.PubSub

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @impl true
  def init(opts) do
    enabled? = Keyword.get(opts, :enabled?, enabled?())

    if enabled? do
      Phoenix.PubSub.subscribe(@pubsub, "event_lake:new")
      Logger.info("[ProjectEventIngestor] EventLake project ingest enabled")
    else
      Logger.info("[ProjectEventIngestor] disabled")
    end

    {:ok, %{enabled?: enabled?, ingested: 0, ignored: 0}}
  end

  @impl true
  def handle_info({:event_lake_new, event}, %{enabled?: true} = state) do
    case ProjectRepo.ingest_event(event) do
      {:ok, _row} ->
        {:noreply, %{state | ingested: state.ingested + 1}}

      :ignored ->
        {:noreply, %{state | ignored: state.ignored + 1}}

      {:error, reason} ->
        Logger.warning("[ProjectEventIngestor] ingest failed: #{inspect(reason)}")
        {:noreply, state}
    end
  end

  def handle_info(_message, state), do: {:noreply, state}

  defp enabled? do
    System.get_env("TEAM_JAY_PROJECT_EVENT_INGEST_ENABLED", "true") in [
      "1",
      "true",
      "TRUE",
      "yes"
    ]
  end
end
