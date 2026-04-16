defmodule TeamJay.EventLake do
  @moduledoc """
  실시간 event_lake 수신 + 캐시 + 통계 관리 GenServer.
  """
  use GenServer
  require Logger

  alias TeamJay.Repo
  alias TeamJay.Schemas.EventLake, as: EventLakeSchema

  @max_cache 1_000

  defstruct [:events, :stats, :started_at, :pg_pid, :ref, :channel]

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @impl true
  def init(_opts) do
    channel = TeamJay.Config.pg_notify_channel()
    db_opts = TeamJay.Config.notification_db_opts()

    {:ok, pid} = Postgrex.Notifications.start_link(db_opts)
    {:ok, ref} = Postgrex.Notifications.listen(pid, channel)

    Logger.info("[EventLake] 실시간 수신 시작! channel=#{channel}")

    {:ok,
     %__MODULE__{
       events: [],
       stats: %{total: 0, by_type: %{}, by_team: %{}},
       started_at: DateTime.utc_now(),
       pg_pid: pid,
       ref: ref,
       channel: channel
     }}
  end

  @impl true
  def handle_info({:notification, _pid, _ref, _channel, payload}, state) do
    event = Jason.decode!(payload)
    Logger.info("[EventLake] #{event["event_type"]} (#{event["bot_name"]})")

    new_events = [event | Enum.take(state.events, @max_cache - 1)]
    new_stats = update_stats(state.stats, event)

    {:noreply, %{state | events: new_events, stats: new_stats}}
  end

  def get_recent(count \\ 10), do: GenServer.call(__MODULE__, {:get_recent, count})
  def get_stats, do: GenServer.call(__MODULE__, :get_stats)
  def get_by_type(type, count \\ 10), do: GenServer.call(__MODULE__, {:get_by_type, type, count})

  def record(attrs) when is_map(attrs), do: GenServer.cast(__MODULE__, {:record, attrs})

  @impl true
  def handle_call({:get_recent, count}, _from, state) do
    {:reply, Enum.take(state.events, count), state}
  end

  def handle_call(:get_stats, _from, state) do
    {:reply, state.stats, state}
  end

  def handle_call({:get_by_type, type, count}, _from, state) do
    filtered =
      state.events
      |> Enum.filter(&(&1["event_type"] == type))
      |> Enum.take(count)

    {:reply, filtered, state}
  end

  @impl true
  def handle_cast({:record, attrs}, state) do
    changeset =
      attrs
      |> normalize_record_attrs()
      |> then(&EventLakeSchema.changeset(%EventLakeSchema{}, &1))

    case Repo.insert(changeset) do
      {:ok, _row} -> Logger.debug("[EventLake] 기록 성공: #{Map.get(attrs, :event_type) || Map.get(attrs, "event_type")}")
      {:error, err} -> Logger.error("[EventLake] 기록 실패: #{inspect(err)}")
    end

    {:noreply, state}
  end

  defp normalize_record_attrs(attrs) when is_map(attrs) do
    source = map_get(attrs, :source)
    payload = map_get(attrs, :payload)
    metadata = map_get(attrs, :metadata, %{}) |> ensure_map()

    merged_metadata =
      metadata
      |> maybe_put_metadata("source", source)
      |> maybe_put_metadata("payload", payload)

    %{
      event_type: map_get(attrs, :event_type, "unknown"),
      team: map_get(attrs, :team, "general"),
      bot_name: map_get(attrs, :bot_name, map_get(attrs, :bot, source || "unknown")),
      severity: normalize_severity(map_get(attrs, :severity, "info")),
      trace_id: map_get(attrs, :trace_id, ""),
      title: map_get(attrs, :title, ""),
      message: map_get(attrs, :message, ""),
      tags: map_get(attrs, :tags, []),
      metadata: merged_metadata,
      feedback_score: map_get(attrs, :feedback_score),
      feedback: map_get(attrs, :feedback)
    }
  end

  defp normalize_record_attrs(other), do: %{event_type: inspect(other)}

  defp normalize_severity("warning"), do: "warn"
  defp normalize_severity(severity) when is_atom(severity), do: severity |> Atom.to_string() |> normalize_severity()
  defp normalize_severity(severity) when is_binary(severity), do: severity
  defp normalize_severity(_), do: "info"

  defp ensure_map(value) when is_map(value), do: value
  defp ensure_map(_), do: %{}

  defp maybe_put_metadata(metadata, _key, nil), do: metadata
  defp maybe_put_metadata(metadata, _key, ""), do: metadata
  defp maybe_put_metadata(metadata, key, value), do: Map.put(metadata, key, value)

  defp map_get(map, key, default \\ nil) do
    Map.get(map, key, Map.get(map, Atom.to_string(key), default))
  end

  defp update_stats(stats, event) do
    type = event["event_type"] || "unknown"
    team = event["team"] || "unknown"

    %{
      stats
      | total: stats.total + 1,
        by_type: Map.update(stats.by_type, type, 1, &(&1 + 1)),
        by_team: Map.update(stats.by_team, team, 1, &(&1 + 1))
    }
  end
end
