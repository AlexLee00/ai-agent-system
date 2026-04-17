defmodule TeamJay.Ska.CommandInbox do
  @moduledoc """
  Ska team cross-team command inbox consumer.

  Jay가 발행한 cross-team command를 허브 inbox에서 읽고,
  ska 팀 내부 이벤트로 연결한 뒤 ack/completed를 남긴다.
  """

  use GenServer
  require Logger

  @poll_ms 60_000
  @max_seen 200
  @retry_after_ms 5 * 60_000

  defstruct seen: %{}, seen_order: []

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @impl true
  def init(_opts) do
    Logger.info("[SkaCommandInbox] 시작! cross-team command polling 활성화")
    send(self(), :poll)
    {:ok, %__MODULE__{}}
  end

  @impl true
  def handle_info(:poll, state) do
    new_state = poll_inbox(state)
    Process.send_after(self(), :poll, @poll_ms)
    {:noreply, new_state}
  end

  @impl true
  def handle_info(_msg, state), do: {:noreply, state}

  defp poll_inbox(state) do
    case TeamJay.HubClient.command_inbox("ska", limit: 20, minutes: 7 * 24 * 60) do
      {:ok, %{"results" => results}} when is_list(results) ->
        results
        |> Enum.reverse()
        |> Enum.reduce(state, &process_inbox_entry/2)

      {:ok, %{results: results}} when is_list(results) ->
        results
        |> Enum.reverse()
        |> Enum.reduce(state, &process_inbox_entry/2)

      {:ok, _} ->
        state

      {:error, reason} ->
        maybe_log_poll_error(reason)
        state
    end
  rescue
    error ->
      Logger.warning("[SkaCommandInbox] poll 예외: #{inspect(error)}")
      state
  end

  defp process_inbox_entry(entry, state) do
    command_id = nested(entry, ["command_id"]) || nested(entry, [:command_id])
    status = nested(entry, ["status"]) || nested(entry, [:status]) || "issued"

    cond do
      is_nil(command_id) or command_id == "" ->
        state

      should_skip_command?(state, command_id, status) ->
        state

      true ->
        case dispatch_command(entry) do
          :ok -> remember_command(state, command_id)
          {:error, _reason} -> remember_command(state, command_id)
        end
    end
  end

  defp dispatch_command(entry) do
    command = nested(entry, ["command"]) || nested(entry, [:command]) || %{}
    command_id =
      nested(command, ["command_id"]) ||
        nested(command, [:command_id]) ||
        nested(entry, ["command_id"]) ||
        ""

    pipeline =
      nested(entry, ["pipeline"]) ||
        nested(entry, [:pipeline]) ||
        nested(command, ["pipeline"]) ||
        ""

    action_type = nested(command, ["action_type"]) || nested(command, [:action_type]) || ""
    summary = nested(entry, ["summary"]) || nested(entry, [:summary]) || ""

    if stale_core_risk_command?(action_type, command) do
      TeamJay.EventLake.record(%{
        team: "ska",
        bot_name: "ska_command_inbox",
        event_type: "ska_cross_team_command_suppressed",
        severity: "info",
        title: "stale core risk command suppressed",
        message: "[#{pipeline}] #{summary}",
        metadata: %{
          pipeline: pipeline,
          command: command,
          summary: summary,
          reason: "core_health_ok"
        }
      })

      _ =
        TeamJay.HubClient.command_complete(command_id, "ska",
          bot_name: "ska_command_inbox",
          source: "ska.command_inbox",
          pipeline: pipeline,
          message: "suppressed stale core risk command"
        )

      Logger.info("[SkaCommandInbox] #{pipeline} stale core risk command suppressed")
      :ok
    else

      _ =
        TeamJay.HubClient.command_ack(command_id, "ska",
          bot_name: "ska_command_inbox",
          source: "ska.command_inbox",
          pipeline: pipeline,
          message: "ska inbox accepted #{action_type}"
        )

      case action_type do
        "apply_seo" ->
          handle_ska_command(:apply_seo, command_id, pipeline, summary, command)

        "notify_budget_surplus" ->
          handle_ska_command(:notify_budget_surplus, command_id, pipeline, summary, command)

        "reduce_workload" ->
          handle_ska_command(:reduce_workload, command_id, pipeline, summary, command)

        other ->
          TeamJay.EventLake.record(%{
            team: "ska",
            bot_name: "ska_command_inbox",
            event_type: "ska_cross_team_command_unsupported",
            severity: "warn",
            title: "지원하지 않는 cross-team command",
            message: "[#{pipeline}] #{other}",
            metadata: %{pipeline: pipeline, command: command, summary: summary}
          })

          _ =
            TeamJay.HubClient.command_fail(command_id, "ska",
              bot_name: "ska_command_inbox",
              source: "ska.command_inbox",
              pipeline: pipeline,
              message: "unsupported ska command: #{other}"
            )

          {:error, :unsupported}
      end
    end
  end

  defp handle_ska_command(kind, command_id, pipeline, summary, command) do
    metadata = %{
      pipeline: pipeline,
      command: command,
      command_id: command_id,
      summary: summary,
      action_type: Atom.to_string(kind)
    }

    TeamJay.EventLake.record(%{
      team: "ska",
      bot_name: "ska_command_inbox",
      event_type: "ska_cross_team_command_received",
      severity: "info",
      title: "ska cross-team command received",
      message: "[#{pipeline}] #{summary}",
      tags: ["cross-team", "command", "ska", Atom.to_string(kind)],
      metadata: metadata
    })

    TeamJay.Ska.PubSub.broadcast_cross_team_command(kind, metadata)

    case kind do
      :apply_seo ->
        TeamJay.Ska.PubSub.broadcast_seo_requested(metadata)

      :notify_budget_surplus ->
        TeamJay.Ska.PubSub.broadcast_budget_surplus_notified(metadata)

      :reduce_workload ->
        TeamJay.Ska.PubSub.broadcast_workload_reduction_requested(metadata)
    end

    Logger.info("[SkaCommandInbox] #{pipeline} 수신 → #{kind} internal handler dispatch")
    :ok
  rescue
    error ->
      TeamJay.EventLake.record(%{
        team: "ska",
        bot_name: "ska_command_inbox",
        event_type: "ska_cross_team_command_failed",
        severity: "warn",
        title: "ska cross-team command failed",
        message: "[#{pipeline}] #{inspect(error)}",
        metadata: %{pipeline: pipeline, command: command, summary: summary}
      })

      _ =
        TeamJay.HubClient.command_fail(command_id, "ska",
          bot_name: "ska_command_inbox",
          source: "ska.command_inbox",
          pipeline: pipeline,
          message: "ska command failed: #{inspect(error)}"
        )

      {:error, error}
  end

  defp remember_command(state, command_id) do
    next_order = [command_id | state.seen_order] |> Enum.take(@max_seen)
    now_ms = System.monotonic_time(:millisecond)

    next_seen =
      next_order
      |> Enum.reduce(%{}, fn id, acc ->
        Map.put(acc, id, Map.get(state.seen, id, now_ms))
      end)
      |> Map.put(command_id, now_ms)

    %{state | seen: next_seen, seen_order: next_order}
  end

  defp should_skip_command?(state, command_id, status) do
    case Map.get(state.seen, command_id) do
      nil ->
        false

      seen_at ->
        age_ms = System.monotonic_time(:millisecond) - seen_at

        if status in ["issued", "acknowledged"] and age_ms >= @retry_after_ms do
          false
        else
          true
        end
    end
  end

  defp maybe_log_poll_error(reason) do
    message = inspect(reason)

    if String.contains?(message, "HTTP 404") and String.contains?(message, "/events/commands/inbox") do
      Logger.debug("[SkaCommandInbox] hub inbox route 미반영 상태 — 다음 재기동 후 자동 연결")
    else
      Logger.debug("[SkaCommandInbox] inbox 조회 실패: #{message}")
    end
  end

  defp nested(map, [key | rest]) when is_map(map) do
    value = Map.get(map, key)
    if rest == [], do: value, else: nested(value, rest)
  end

  defp nested(_map, _path), do: nil

  defp stale_core_risk_command?(action_type, command) do
    action_type == "reduce_workload" and core_alias_services_only?(command) and current_core_health_ok?()
  end

  defp core_alias_services_only?(command) do
    services =
      nested(command, ["payload", "affected_services"]) ||
        nested(command, [:payload, :affected_services]) ||
        []

    normalized =
      services
      |> List.wrap()
      |> Enum.map(&(&1 |> to_string() |> String.downcase()))
      |> Enum.reject(&(&1 == ""))

    normalized != [] and
      Enum.all?(normalized, &(&1 in ["api", "db", "database", "postgres", "postgresql", "pg_pool", "hub"]))
  end

  defp current_core_health_ok? do
    case TeamJay.HubClient.health() do
      {:ok, %{"resources" => resources}} when is_map(resources) ->
        resource_ok?(resources, "core_services") and
          resource_ok?(resources, "postgresql") and
          resource_ok?(resources, "pg_pool")

      _ ->
        false
    end
  end

  defp resource_ok?(resources, key) do
    case Map.get(resources, key) do
      %{"status" => "ok"} -> true
      _ -> false
    end
  end
end
