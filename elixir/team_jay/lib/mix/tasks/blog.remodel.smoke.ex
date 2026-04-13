defmodule Mix.Tasks.Blog.Remodel.Smoke do
  use Mix.Task

  @shortdoc "블로팀 리모델링 Phase 1~3를 한 번에 스모크 점검합니다"
  @requirements ["app.start"]

  @moduledoc """
  블로그 리모델링 전체 흐름을 한 번에 점검하는 통합 스모크 태스크.

  - Orchestrator를 트리거해 Phase 1 파이프라인을 흘리고
  - Phase 3 feedback이 실제로 생성되는지 기다린 뒤
  - Phase 1 brief report + Phase 3 digest를 함께 출력한다.

  ## Examples

      mix blog.remodel.smoke
      mix blog.remodel.smoke --json
      mix blog.remodel.smoke --wait-ms 6000 --interval-ms 500
      mix blog.remodel.smoke --no-trigger
  """

  alias TeamJay.Blog.DailySummary
  alias TeamJay.Blog.AutonomyDigest
  alias TeamJay.Blog.FeedbackDigest
  alias TeamJay.Blog.Orchestrator
  alias TeamJay.Blog.StatusSnapshot
  alias TeamJay.Blog.SummaryFormatter

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

    wait_ms = Keyword.get(opts, :wait_ms, 6_000)
    interval_ms = Keyword.get(opts, :interval_ms, 500)
    trigger? = !Keyword.get(opts, :no_trigger, false)

    initial = StatusSnapshot.collect()
    current_feedback = initial |> Map.get(:feedback, %{}) |> Map.get(:feedback_count, 0)
    planned = if trigger?, do: Orchestrator.plan_today() |> length(), else: 0
    expected_feedback_count = current_feedback + planned

    if trigger? do
      Orchestrator.trigger_daily_run()
    end

    status =
      wait_until_feedback(
        System.monotonic_time(:millisecond),
        wait_ms,
        interval_ms,
        expected_feedback_count
      )

    summary = DailySummary.build()
    digest = FeedbackDigest.build(status)
    autonomy = AutonomyDigest.build()

    payload = %{
      trigger: trigger?,
      wait_ms: wait_ms,
      interval_ms: interval_ms,
      expected_feedback_count: expected_feedback_count,
      wait_status: Map.get(status, :wait_status, :completed),
      phase1_brief: SummaryFormatter.format(summary, :brief),
      phase1_health: Map.get(summary, :health, %{}),
      phase3_health: Map.get(digest, :health, %{}),
      phase3_feedback: Map.get(digest, :feedback, %{}),
      phase3_alerts: Map.get(digest, :alerts, %{}),
      autonomy: autonomy,
      digest: digest
    }

    if Keyword.get(opts, :json, false) do
      Mix.shell().info(Jason.encode!(payload))
    else
      Mix.shell().info(render_text(payload))
    end
  end

  defp wait_until_feedback(started_at, wait_ms, interval_ms, expected_feedback_count) do
    status = StatusSnapshot.collect()
    current_feedback = status |> Map.get(:feedback, %{}) |> Map.get(:feedback_count, 0)

    cond do
      current_feedback >= expected_feedback_count ->
        status

      System.monotonic_time(:millisecond) - started_at >= wait_ms ->
        Map.put(status, :wait_status, :timeout)

      true ->
        Process.sleep(interval_ms)
        wait_until_feedback(started_at, wait_ms, interval_ms, expected_feedback_count)
    end
  end

  defp render_text(payload) do
    phase1_health = payload.phase1_health
    phase3_health = payload.phase3_health
    phase3_feedback = payload.phase3_feedback
    phase3_alerts = payload.phase3_alerts
    autonomy = payload.autonomy
    autonomy_health = Map.get(autonomy, :health, %{})
    autonomy_latest = Map.get(autonomy, :latest_decision, %{}) || %{}
    recent_key = phase3_feedback |> Map.get(:recent_keys, []) |> List.first() || "none"

    """
    Blog Remodel Smoke
    trigger: #{payload.trigger}
    wait_ms: #{payload.wait_ms}
    interval_ms: #{payload.interval_ms}
    expected_feedback_count: #{payload.expected_feedback_count}
    wait_status: #{payload.wait_status}

    #{payload.phase1_brief}
    phase1.status=#{Map.get(phase1_health, :status, :ok)}
    phase3.status=#{Map.get(phase3_health, :status, :warming_up)}
    phase3.feedback=#{Map.get(phase3_feedback, :feedback_count, 0)}
    phase3.recent=#{recent_key}
    phase3.failSignals=#{Map.get(phase3_health, :failed_signal_count, 0)}
    phase3.alerts=#{Map.get(phase3_alerts, :total_count, 0)}
    autonomy.status=#{Map.get(autonomy_health, :status, :warming_up)}
    autonomy.decisions=#{Map.get(autonomy_health, :total_count, 0)}
    autonomy.auto=#{Map.get(autonomy_health, :auto_publish_count, 0)}
    autonomy.latest=#{Map.get(autonomy_latest, :decision, "none")}
    """
    |> String.trim()
  end
end
