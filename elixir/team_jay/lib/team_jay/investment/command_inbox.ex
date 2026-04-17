defmodule TeamJay.Investment.CommandInbox do
  @moduledoc """
  Investment team cross-team command inbox consumer.

  Jay가 발행한 cross-team command를 허브 inbox에서 읽고,
  investment 팀 내부 이벤트로 연결한 뒤 ack만 남긴다.
  completed/failed는 실제 action handler가 마무리한다.
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
    Logger.info("[InvestmentCommandInbox] 시작! cross-team command polling 활성화")
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
    case Jay.Core.HubClient.command_inbox("luna", limit: 20, minutes: 7 * 24 * 60) do
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
      Logger.warning("[InvestmentCommandInbox] poll 예외: #{inspect(error)}")
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
      Jay.Core.EventLake.record(%{
        team: "investment",
        bot_name: "investment_command_inbox",
        event_type: "investment_cross_team_command_suppressed",
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
        Jay.Core.HubClient.command_complete(command_id, "luna",
          bot_name: "investment_command_inbox",
          source: "investment.command_inbox",
          pipeline: pipeline,
          message: "suppressed stale core risk command"
        )

      Logger.info("[InvestmentCommandInbox] #{pipeline} stale core risk command suppressed")
      :ok
    else

      _ =
        Jay.Core.HubClient.command_ack(command_id, "luna",
          bot_name: "investment_command_inbox",
          source: "investment.command_inbox",
          pipeline: pipeline,
          message: "investment inbox accepted #{action_type}"
        )

      case action_type do
        "adjust_investment_intensity" ->
          handle_investment_command(
            :adjust_investment_intensity,
            command_id,
            pipeline,
            summary,
            command
          )

        "analyze_trend_candidates" ->
          handle_investment_command(:analyze_trend_candidates, command_id, pipeline, summary, command)

        "reduce_workload" ->
          handle_investment_command(:reduce_workload, command_id, pipeline, summary, command)

        other ->
          Jay.Core.EventLake.record(%{
            team: "investment",
            bot_name: "investment_command_inbox",
            event_type: "investment_cross_team_command_unsupported",
            severity: "warn",
            title: "지원하지 않는 cross-team command",
            message: "[#{pipeline}] #{other}",
            metadata: %{pipeline: pipeline, command: command, summary: summary}
          })

          _ =
            Jay.Core.HubClient.command_fail(command_id, "luna",
              bot_name: "investment_command_inbox",
              source: "investment.command_inbox",
              pipeline: pipeline,
              message: "unsupported investment command: #{other}"
            )

          {:error, :unsupported}
      end
    end
  end

  defp handle_investment_command(kind, command_id, pipeline, summary, command) do
    metadata = %{
      pipeline: pipeline,
      command_id: command_id,
      command: command,
      summary: summary,
      action_type: Atom.to_string(kind)
    }

    Jay.Core.EventLake.record(%{
      team: "investment",
      bot_name: "investment_command_inbox",
      event_type: "investment_cross_team_command_received",
      severity: "info",
      title: "investment cross-team command received",
      message: "[#{pipeline}] #{summary}",
      tags: ["cross-team", "command", "investment", Atom.to_string(kind)],
      metadata: metadata
    })

    TeamJay.Investment.PubSub.broadcast_cross_team_command(kind, metadata)

    case kind do
      :adjust_investment_intensity ->
        TeamJay.Investment.PubSub.broadcast_intensity_adjustment(metadata)

      :analyze_trend_candidates ->
        TeamJay.Investment.PubSub.broadcast_trend_candidate_analysis(metadata)

      :reduce_workload ->
        TeamJay.Investment.PubSub.broadcast_workload_reduction(metadata)
    end

    Logger.info("[InvestmentCommandInbox] #{pipeline} 수신 → #{kind} 반영")
    :ok
  rescue
    error ->
      Jay.Core.EventLake.record(%{
        team: "investment",
        bot_name: "investment_command_inbox",
        event_type: "investment_cross_team_command_failed",
        severity: "warn",
        title: "investment cross-team command failed",
        message: "[#{pipeline}] #{inspect(error)}",
        metadata: %{pipeline: pipeline, command: command, summary: summary}
      })

      _ =
        Jay.Core.HubClient.command_fail(command_id, "luna",
          bot_name: "investment_command_inbox",
          source: "investment.command_inbox",
          pipeline: pipeline,
          message: "investment command failed: #{inspect(error)}"
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
      Logger.debug("[InvestmentCommandInbox] hub inbox route 미반영 상태 — 다음 재기동 후 자동 연결")
    else
      Logger.debug("[InvestmentCommandInbox] inbox 조회 실패: #{message}")
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
    case Jay.Core.HubClient.health() do
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
