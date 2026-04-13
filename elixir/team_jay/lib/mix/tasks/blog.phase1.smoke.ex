defmodule Mix.Tasks.Blog.Phase1.Smoke do
  use Mix.Task

  @shortdoc "블로그팀 Phase 1 스모크 실행 후 상태를 출력합니다"
  @requirements ["app.start"]

  @moduledoc """
  블로그팀 Phase 1 파이프라인을 한 번 트리거하고,
  잠시 대기한 뒤 상태 스냅샷을 출력한다.

  ## Examples

      mix blog.phase1.smoke
      mix blog.phase1.smoke --json
      mix blog.phase1.smoke --wait-ms 4000
  """

  alias TeamJay.Blog.Orchestrator
  alias TeamJay.Blog.StatusSnapshot

  @impl Mix.Task
  def run(args) do
    {opts, _argv, _invalid} =
      OptionParser.parse(args, strict: [json: :boolean, wait_ms: :integer])

    wait_ms = Keyword.get(opts, :wait_ms, 4_000)

    Orchestrator.trigger_daily_run()
    Process.sleep(wait_ms)

    status = StatusSnapshot.collect()

    if Keyword.get(opts, :json, false) do
      Mix.shell().info(Jason.encode_to_iodata!(status, pretty: true))
    else
      Mix.shell().info(render_text(wait_ms, status))
    end
  end

  defp render_text(wait_ms, status) do
    """
    Blog Phase 1 Smoke
    wait_ms: #{wait_ms}

    orchestrator.planned_count=#{Map.get(status.orchestrator, :planned_count, 0)}
    researcher.completed_size=#{Map.get(status.researcher, :completed_size, 0)}
    writer_pos.drafted_count=#{Map.get(status.writer_pos, :drafted_count, 0)}
    writer_gems.drafted_count=#{Map.get(status.writer_gems, :drafted_count, 0)}
    editor.approved_count=#{Map.get(status.editor, :approved_count, 0)}
    publisher.published_count=#{Map.get(status.publisher, :published_count, 0)}
    port_bridge.handoff_count=#{Map.get(status.port_bridge, :handoff_count, 0)}
    node_publish_agent.queued_count=#{Map.get(status.node_publish_agent, :queued_count, 0)}
    node_publish_executor.executed_count=#{Map.get(status.node_publish_executor, :executed_count, 0)}
    node_publish_runner.run_count=#{Map.get(status.node_publish_runner, :run_count, 0)}
    node_publish_runner.dry_run_ok_count=#{Map.get(status.node_publish_runner, :dry_run_ok_count, 0)}
    execution_monitor.total_count=#{Map.get(status.execution_monitor, :total_count, 0)}
    execution_monitor.dry_run_ok_count=#{Map.get(status.execution_monitor, :dry_run_ok_count, 0)}
    feedback.feedback_count=#{Map.get(status.feedback, :feedback_count, 0)}
    social_relay.relayed_count=#{Map.get(status.social_relay, :relayed_count, 0)}
    instagram_agent.queued_count=#{Map.get(status.instagram_agent, :queued_count, 0)}
    naver_blog_agent.queued_count=#{Map.get(status.naver_blog_agent, :queued_count, 0)}
    """
    |> String.trim()
  end
end
