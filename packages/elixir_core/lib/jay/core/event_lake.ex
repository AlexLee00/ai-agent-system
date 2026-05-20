defmodule Jay.Core.EventLake do
  @moduledoc """
  실시간 event_lake 수신 + 캐시 + 통계 관리 GenServer.
  """
  use GenServer
  import Ecto.Query
  require Logger

  alias Jay.Core.Repo
  alias Jay.Core.Schemas.EventLake, as: EventLakeSchema

  @max_cache 1_000
  @stats_top_limit 100
  defstruct [:events, :stats, :started_at, :pg_pid, :ref, :channel]

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @impl true
  def init(_opts) do
    channel = Jay.Core.Config.pg_notify_channel()
    db_opts = Jay.Core.Config.notification_db_opts()
    {events, stats} = load_initial_state()

    {:ok, pid} = Postgrex.Notifications.start_link(db_opts)
    {:ok, ref} = Postgrex.Notifications.listen(pid, channel)

    Logger.info("[EventLake] 실시간 수신 시작! channel=#{channel}")

    {:ok,
     %__MODULE__{
       events: events,
       stats: stats,
       started_at: DateTime.utc_now(),
       pg_pid: pid,
       ref: ref,
       channel: channel
     }}
  end

  @impl true
  def handle_info({:notification, _pid, _ref, _channel, payload}, state) do
    event = payload |> Jason.decode!() |> ensure_event_time()
    Logger.info("[EventLake] #{event["event_type"]} (#{event["bot_name"]})")

    new_events = [event | Enum.take(state.events, @max_cache - 1)]
    new_stats = update_stats(state.stats, event)

    broadcast_dashboard_event(event)

    {:noreply, %{state | events: new_events, stats: new_stats}}
  end

  def get_recent(count \\ 10), do: GenServer.call(__MODULE__, {:get_recent, count})
  def get_stats, do: GenServer.call(__MODULE__, :get_stats)
  def get_by_type(type, count \\ 10), do: GenServer.call(__MODULE__, {:get_by_type, type, count})

  def record(attrs) when is_map(attrs) do
    GenServer.cast(__MODULE__, {:record, maybe_attach_current_trace_id(attrs)})
  end

  def record_sync(attrs) when is_map(attrs) do
    attrs = maybe_attach_current_trace_id(attrs)
    insert_record(attrs)
  end

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
    insert_record(attrs)
    {:noreply, state}
  end

  defp insert_record(attrs) do
    changeset =
      attrs
      |> normalize_record_attrs()
      |> then(&EventLakeSchema.changeset(%EventLakeSchema{}, &1))

    case Repo.insert(changeset) do
      {:ok, row} ->
        Logger.debug(
          "[EventLake] 기록 성공: #{Map.get(attrs, :event_type) || Map.get(attrs, "event_type")}"
        )

        {:ok, row}

      {:error, err} ->
        Logger.error("[EventLake] 기록 실패: #{inspect(err)}")
        {:error, err}
    end
  end

  defp ensure_event_time(event) when is_map(event) do
    if Enum.any?(
         ["created_at", "inserted_at", "event_at", "occurred_at", "timestamp", "received_at"],
         &Map.has_key?(event, &1)
       ) do
      event
    else
      Map.put(
        event,
        "received_at",
        DateTime.utc_now() |> DateTime.truncate(:second) |> DateTime.to_iso8601()
      )
    end
  end

  defp ensure_event_time(event), do: event

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

  defp maybe_attach_current_trace_id(attrs) do
    if blank_trace_id?(map_get(attrs, :trace_id)) do
      case current_otel_trace_id() do
        trace_id when is_binary(trace_id) -> Map.put(attrs, :trace_id, trace_id)
        _ -> attrs
      end
    else
      attrs
    end
  end

  defp current_otel_trace_id do
    case OpenTelemetry.Tracer.current_span_ctx() |> OpenTelemetry.Span.hex_span_ctx() do
      %{otel_trace_id: trace_id} when is_binary(trace_id) ->
        if blank_trace_id?(trace_id), do: nil, else: trace_id

      _ ->
        nil
    end
  rescue
    _ -> nil
  end

  defp blank_trace_id?(nil), do: true
  defp blank_trace_id?(""), do: true
  defp blank_trace_id?("00000000000000000000000000000000"), do: true
  defp blank_trace_id?(_), do: false

  defp normalize_severity("warning"), do: "warn"

  defp normalize_severity(severity) when is_atom(severity),
    do: severity |> Atom.to_string() |> normalize_severity()

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

  defp load_initial_state do
    {load_recent_events_from_db(), load_stats_from_db()}
  rescue
    error ->
      Logger.warning("[EventLake] DB 초기 캐시 로드 실패: #{inspect(error)}")
      {[], %{total: 0, by_type: %{}, by_team: %{}}}
  end

  defp load_recent_events_from_db do
    EventLakeSchema
    |> order_by([event], desc: event.created_at, desc: event.id)
    |> limit(^@max_cache)
    |> Repo.all()
    |> Enum.map(&schema_event_to_dashboard_map/1)
  end

  defp load_stats_from_db do
    %{
      total: Repo.aggregate(EventLakeSchema, :count, :id),
      by_type: grouped_counts(:event_type),
      by_team: grouped_counts(:team)
    }
  end

  defp grouped_counts(field) do
    EventLakeSchema
    |> group_by([event], field(event, ^field))
    |> order_by([event], desc: count(event.id))
    |> limit(^@stats_top_limit)
    |> select([event], {field(event, ^field), count(event.id)})
    |> Repo.all()
    |> Map.new(fn {key, count} -> {key || "unknown", count} end)
  end

  defp schema_event_to_dashboard_map(%EventLakeSchema{} = event) do
    %{
      "id" => event.id,
      "event_type" => event.event_type,
      "team" => event.team,
      "bot_name" => event.bot_name,
      "severity" => event.severity,
      "trace_id" => event.trace_id,
      "title" => event.title,
      "message" => event.message,
      "tags" => event.tags || [],
      "metadata" => event.metadata || %{},
      "feedback_score" => event.feedback_score,
      "feedback" => event.feedback,
      "created_at" => event.created_at,
      "updated_at" => event.updated_at
    }
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

  defp broadcast_dashboard_event(event) do
    case dashboard_pubsub() do
      nil -> :ok
      pubsub -> Phoenix.PubSub.broadcast(pubsub, "event_lake:new", {:event_lake_new, event})
    end
  rescue
    _ -> :ok
  end

  defp dashboard_pubsub do
    Application.get_env(:jay_core, :dashboard_pubsub) ||
      Application.get_env(:team_jay, :dashboard_pubsub)
  end
end
