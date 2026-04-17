defmodule TeamJay.Blog.CommandActionHandler do
  @moduledoc """
  Blog cross-team command action handler.

  CommandInbox가 받은 typed internal event를 실제 blog 액션으로 연결하고,
  command lifecycle completed/failed를 여기서 마무리한다.
  """

  use GenServer
  require Logger

  alias TeamJay.Blog.PubSub
  alias TeamJay.Blog.Topics

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @impl true
  def init(_opts) do
    {:ok, _promotion_ref} = PubSub.subscribe(Topics.promotion_requests())
    {:ok, _investment_ref} = PubSub.subscribe(Topics.investment_content_requests())

    Logger.info("[BlogCommandActionHandler] 시작! cross-team action handling 활성화")
    {:ok, %{}}
  end

  @impl true
  def handle_info({:blog_event, topic, %{kind: kind, payload: payload}}, state) do
    if topic in [Topics.promotion_requests(), Topics.investment_content_requests()] do
      handle_payload(kind, payload)
    end

    {:noreply, state}
  end

  @impl true
  def handle_info(_msg, state), do: {:noreply, state}

  defp handle_payload(kind, payload) do
    pipeline = Map.get(payload, :pipeline, "unknown")
    command_id = Map.get(payload, :command_id, "")
    summary = Map.get(payload, :summary, "")
    command = Map.get(payload, :command, %{})

    TeamJay.EventLake.record(%{
      team: "blog",
      bot_name: "blog_command_action_handler",
      event_type: "blog_cross_team_command_handling",
      severity: "info",
      title: "blog cross-team command handling",
      message: "[#{pipeline}] #{kind}",
      tags: ["cross-team", "command", "blog", "handler", Atom.to_string(kind)],
      metadata: %{
        pipeline: pipeline,
        command_id: command_id,
        kind: Atom.to_string(kind),
        summary: summary,
        command: command
      }
    })

    TeamJay.Blog.TopicPlanner.run_now()
    TeamJay.Blog.TopicCurator.curate_now()
    TeamJay.Blog.InsightsCollector.collect_now()

    _ =
      TeamJay.HubClient.command_complete(command_id, "blog",
        bot_name: "blog_command_action_handler",
        source: "blog.command_action_handler",
        pipeline: pipeline,
        message: "blog handled #{kind} command via planner/curator/insights"
      )

    Logger.info("[BlogCommandActionHandler] #{pipeline} 처리 완료 → #{kind}")
    :ok
  rescue
    error ->
      pipeline = Map.get(payload, :pipeline, "unknown")
      command_id = Map.get(payload, :command_id, "")
      summary = Map.get(payload, :summary, "")
      command = Map.get(payload, :command, %{})

      TeamJay.EventLake.record(%{
        team: "blog",
        bot_name: "blog_command_action_handler",
        event_type: "blog_cross_team_command_action_failed",
        severity: "warn",
        title: "blog cross-team command action failed",
        message: "[#{pipeline}] #{inspect(error)}",
        metadata: %{
          pipeline: pipeline,
          command_id: command_id,
          kind: Atom.to_string(kind),
          summary: summary,
          command: command
        }
      })

      _ =
        TeamJay.HubClient.command_fail(command_id, "blog",
          bot_name: "blog_command_action_handler",
          source: "blog.command_action_handler",
          pipeline: pipeline,
          message: "blog action handler failed: #{inspect(error)}"
        )

      Logger.warning("[BlogCommandActionHandler] #{pipeline} 처리 실패: #{inspect(error)}")
      :error
  end
end
