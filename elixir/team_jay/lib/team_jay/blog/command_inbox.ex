defmodule TeamJay.Blog.CommandInbox do
  @moduledoc """
  Blog team cross-team command inbox consumer.

  Jay가 발행한 cross-team command를 허브 inbox에서 읽고,
  blog 팀 내부 작업으로 연결한 뒤 ack/completed를 남긴다.
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
    Logger.info("[BlogCommandInbox] 시작! cross-team command polling 활성화")
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
    case Jay.Core.HubClient.command_inbox("blog", limit: 20, minutes: 7 * 24 * 60) do
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
      Logger.warning("[BlogCommandInbox] poll 예외: #{inspect(error)}")
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
    command_id = nested(command, ["command_id"]) || nested(command, [:command_id]) || nested(entry, ["command_id"]) || ""
    pipeline = nested(entry, ["pipeline"]) || nested(entry, [:pipeline]) || nested(command, ["pipeline"]) || ""
    action_type = nested(command, ["action_type"]) || nested(command, [:action_type]) || ""
    summary = nested(entry, ["summary"]) || nested(entry, [:summary]) || ""

    _ =
      Jay.Core.HubClient.command_ack(command_id, "blog",
        bot_name: "blog_command_inbox",
        source: "blog.command_inbox",
        pipeline: pipeline,
        message: "blog inbox accepted #{action_type}"
      )

    case action_type do
      "create_promotion_content" ->
        handle_content_command(:promotion, command_id, pipeline, summary, command)

      "create_investment_content" ->
        handle_content_command(:investment, command_id, pipeline, summary, command)

      other ->
        Jay.Core.EventLake.record(%{
          team: "blog",
          bot_name: "blog_command_inbox",
          event_type: "blog_cross_team_command_unsupported",
          severity: "warn",
          title: "지원하지 않는 cross-team command",
          message: "[#{pipeline}] #{other}",
          metadata: %{pipeline: pipeline, command: command, summary: summary}
        })

        _ =
          Jay.Core.HubClient.command_fail(command_id, "blog",
            bot_name: "blog_command_inbox",
            source: "blog.command_inbox",
            pipeline: pipeline,
            message: "unsupported blog command: #{other}"
          )

        {:error, :unsupported}
    end
  end

  defp handle_content_command(kind, command_id, pipeline, summary, command) do
    payload = %{
      pipeline: pipeline,
      command: command,
      command_id: command_id,
      summary: summary,
      kind: kind
    }

    Jay.Core.EventLake.record(%{
      team: "blog",
      bot_name: "blog_command_inbox",
      event_type: "blog_cross_team_command_received",
      severity: "info",
      title: "blog cross-team command received",
      message: "[#{pipeline}] #{summary}",
      tags: ["cross-team", "command", "blog", Atom.to_string(kind)],
      metadata: %{
        pipeline: pipeline,
        content_kind: Atom.to_string(kind),
        command: command,
        command_id: command_id,
        summary: summary
      }
    })

    TeamJay.Blog.PubSub.broadcast_cross_team_command(kind, payload)

    case kind do
      :promotion ->
        TeamJay.Blog.PubSub.broadcast_promotion_request(payload)

      :investment ->
        TeamJay.Blog.PubSub.broadcast_investment_content_request(payload)
    end

    Logger.info("[BlogCommandInbox] #{pipeline} 수신 → #{kind} internal handler dispatch")
    :ok
  rescue
    error ->
      Jay.Core.EventLake.record(%{
        team: "blog",
        bot_name: "blog_command_inbox",
        event_type: "blog_cross_team_command_failed",
        severity: "warn",
        title: "blog cross-team command failed",
        message: "[#{pipeline}] #{inspect(error)}",
        metadata: %{pipeline: pipeline, command: command, summary: summary}
      })

      _ =
        Jay.Core.HubClient.command_fail(command_id, "blog",
          bot_name: "blog_command_inbox",
          source: "blog.command_inbox",
          pipeline: pipeline,
          message: "blog command failed: #{inspect(error)}"
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
      Logger.debug("[BlogCommandInbox] hub inbox route 미반영 상태 — 다음 재기동 후 자동 연결")
    else
      Logger.debug("[BlogCommandInbox] inbox 조회 실패: #{message}")
    end
  end

  defp nested(map, [key | rest]) when is_map(map) do
    value = Map.get(map, key)
    if rest == [], do: value, else: nested(value, rest)
  end

  defp nested(_map, _path), do: nil
end
