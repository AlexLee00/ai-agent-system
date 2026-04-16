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

  defstruct seen_ids: MapSet.new(), seen_order: []

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
    case TeamJay.HubClient.command_inbox("blog", limit: 20, minutes: 7 * 24 * 60) do
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

    cond do
      is_nil(command_id) or command_id == "" ->
        state

      MapSet.member?(state.seen_ids, command_id) ->
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
      TeamJay.HubClient.command_ack(command_id, "blog",
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
        TeamJay.EventLake.record(%{
          team: "blog",
          bot_name: "blog_command_inbox",
          event_type: "blog_cross_team_command_unsupported",
          severity: "warn",
          title: "지원하지 않는 cross-team command",
          message: "[#{pipeline}] #{other}",
          metadata: %{pipeline: pipeline, command: command, summary: summary}
        })

        _ =
          TeamJay.HubClient.command_fail(command_id, "blog",
            bot_name: "blog_command_inbox",
            source: "blog.command_inbox",
            pipeline: pipeline,
            message: "unsupported blog command: #{other}"
          )

        {:error, :unsupported}
    end
  end

  defp handle_content_command(kind, command_id, pipeline, summary, command) do
    TeamJay.EventLake.record(%{
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
        summary: summary
      }
    })

    TeamJay.Blog.PubSub.broadcast_cross_team_command(kind, %{
      pipeline: pipeline,
      command: command,
      summary: summary
    })

    case kind do
      :promotion ->
        TeamJay.Blog.PubSub.broadcast_promotion_request(%{
          pipeline: pipeline,
          command: command,
          summary: summary
        })

      :investment ->
        TeamJay.Blog.PubSub.broadcast_investment_content_request(%{
          pipeline: pipeline,
          command: command,
          summary: summary
        })
    end

    TeamJay.Blog.TopicCurator.curate_now()

    _ =
      TeamJay.HubClient.command_complete(command_id, "blog",
        bot_name: "blog_command_inbox",
        source: "blog.command_inbox",
        pipeline: pipeline,
        message: "blog queued #{kind} command for topic curation"
      )

    Logger.info("[BlogCommandInbox] #{pipeline} 수신 → #{kind} 큐레이션 트리거")
    :ok
  rescue
    error ->
      TeamJay.EventLake.record(%{
        team: "blog",
        bot_name: "blog_command_inbox",
        event_type: "blog_cross_team_command_failed",
        severity: "warn",
        title: "blog cross-team command failed",
        message: "[#{pipeline}] #{inspect(error)}",
        metadata: %{pipeline: pipeline, command: command, summary: summary}
      })

      _ =
        TeamJay.HubClient.command_fail(command_id, "blog",
          bot_name: "blog_command_inbox",
          source: "blog.command_inbox",
          pipeline: pipeline,
          message: "blog command failed: #{inspect(error)}"
        )

      {:error, error}
  end

  defp remember_command(state, command_id) do
    next_order = [command_id | state.seen_order] |> Enum.take(@max_seen)
    next_seen = MapSet.new(next_order)
    %{state | seen_ids: next_seen, seen_order: next_order}
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
