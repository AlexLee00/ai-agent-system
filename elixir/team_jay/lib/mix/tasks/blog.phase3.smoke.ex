defmodule Mix.Tasks.Blog.Phase3.Smoke do
  use Mix.Task

  @shortdoc "블로그팀 Phase 3 피드백 흐름을 스모크 검증합니다"
  @requirements ["app.start"]

  @moduledoc """
  블로그팀 파이프라인을 한 번 트리거하고,
  feedback이 실제로 쌓일 때까지 기다린 뒤
  Phase 3 digest를 출력한다.

  ## Examples

      mix blog.phase3.smoke
      mix blog.phase3.smoke --json
      mix blog.phase3.smoke --wait-ms 5000 --interval-ms 250
      mix blog.phase3.smoke --no-trigger
  """

  alias TeamJay.Blog.FeedbackDigest
  alias TeamJay.Blog.Orchestrator
  alias TeamJay.Blog.StatusSnapshot

  @impl Mix.Task
  def run(args) do
    {opts, _argv, _invalid} =
      OptionParser.parse(args,
        strict: [
          json: :boolean,
          wait_ms: :integer,
          interval_ms: :integer,
          no_trigger: :boolean
        ]
      )

    wait_ms = Keyword.get(opts, :wait_ms, 5_000)
    interval_ms = Keyword.get(opts, :interval_ms, 250)
    trigger? = !Keyword.get(opts, :no_trigger, false)

    initial = StatusSnapshot.collect()
    current_feedback = initial |> Map.get(:feedback, %{}) |> Map.get(:feedback_count, 0)
    planned = if trigger?, do: planned_count(), else: 0
    expected_feedback = current_feedback + planned

    if trigger? do
      Orchestrator.trigger_daily_run()
    end

    status =
      wait_until_feedback(
        System.monotonic_time(:millisecond),
        wait_ms,
        interval_ms,
        expected_feedback
      )

    digest = FeedbackDigest.build(status)
    payload = %{
      trigger: trigger?,
      wait_ms: wait_ms,
      interval_ms: interval_ms,
      expected_feedback_count: expected_feedback,
      wait_status: Map.get(status, :wait_status, :completed),
      status: status,
      digest: digest
    }

    if Keyword.get(opts, :json, false) do
      Mix.shell().info(Jason.encode!(payload))
    else
      Mix.shell().info(render_text(payload))
    end
  end

  defp wait_until_feedback(started_at, wait_ms, interval_ms, expected_feedback) do
    status = StatusSnapshot.collect()
    current_feedback = status |> Map.get(:feedback, %{}) |> Map.get(:feedback_count, 0)

    cond do
      current_feedback >= expected_feedback ->
        status

      System.monotonic_time(:millisecond) - started_at >= wait_ms ->
        Map.put(status, :wait_status, :timeout)

      true ->
        Process.sleep(interval_ms)
        wait_until_feedback(started_at, wait_ms, interval_ms, expected_feedback)
    end
  end

  defp planned_count do
    Orchestrator.plan_today()
    |> length()
  end

  defp render_text(payload) do
    digest = payload.digest
    health = Map.get(digest, :health, %{})
    feedback = Map.get(digest, :feedback, %{})
    execution = Map.get(digest, :execution, %{})
    social = Map.get(digest, :social, %{})

    """
    Blog Phase 3 Smoke
    trigger: #{payload.trigger}
    wait_ms: #{payload.wait_ms}
    interval_ms: #{payload.interval_ms}
    expected_feedback_count: #{payload.expected_feedback_count}
    wait_status: #{payload.wait_status}

    phase3.status=#{Map.get(health, :status, :warming_up)}
    phase3.feedback_count=#{Map.get(feedback, :feedback_count, 0)}
    phase3.last_feedback=#{feedback |> Map.get(:recent_keys, []) |> List.first() || "none"}
    phase3.node_failures=#{Map.get(health, :node_failure_count, 0)}
    phase3.social_failures=#{Map.get(health, :social_failure_count, 0)}
    phase3.execution_total=#{Map.get(execution, :total_count, 0)}
    phase3.social_total=#{Map.get(social, :total_count, 0)}
    """
    |> String.trim()
  end
end
