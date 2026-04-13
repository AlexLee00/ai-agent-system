defmodule Mix.Tasks.Blog.Phase1.Wait do
  use Mix.Task

  @shortdoc "블로그팀 Phase 1 실행이 끝날 때까지 기다린 뒤 상태를 출력합니다"
  @requirements ["app.start"]

  @moduledoc """
  블로그팀 Phase 1 파이프라인을 트리거하고 완료까지 기다린 뒤 상태를 출력한다.

  ## Examples

      mix blog.phase1.wait
      mix blog.phase1.wait --json
      mix blog.phase1.wait --timeout-ms 20000 --interval-ms 500
      mix blog.phase1.wait --no-trigger
  """

  alias TeamJay.Blog.Orchestrator
  alias TeamJay.Blog.StatusSnapshot

  @impl Mix.Task
  def run(args) do
    {opts, _argv, _invalid} =
      OptionParser.parse(args,
        strict: [
          json: :boolean,
          timeout_ms: :integer,
          interval_ms: :integer,
          no_trigger: :boolean
        ]
      )

    timeout_ms = Keyword.get(opts, :timeout_ms, 20_000)
    interval_ms = Keyword.get(opts, :interval_ms, 500)
    trigger? = !Keyword.get(opts, :no_trigger, false)

    if trigger? do
      Orchestrator.trigger_daily_run()
    end

    started_at = System.monotonic_time(:millisecond)
    initial_status = StatusSnapshot.collect()
    expected_runs = expected_runs(initial_status)

    final_status =
      wait_until_complete(
        started_at,
        timeout_ms,
        interval_ms,
        expected_runs
      )

    if Keyword.get(opts, :json, false) do
      Mix.shell().info(Jason.encode_to_iodata!(final_status, pretty: true))
    else
      Mix.shell().info(render_text(trigger?, timeout_ms, interval_ms, expected_runs, final_status))
    end
  end

  defp wait_until_complete(started_at, timeout_ms, interval_ms, expected_runs) do
    status = StatusSnapshot.collect()

    cond do
      complete?(status, expected_runs) ->
        status

      System.monotonic_time(:millisecond) - started_at >= timeout_ms ->
        Map.put(status, :wait_status, :timeout)

      true ->
        Process.sleep(interval_ms)
        wait_until_complete(started_at, timeout_ms, interval_ms, expected_runs)
    end
  end

  defp expected_runs(status) do
    status
    |> Map.get(:orchestrator, %{})
    |> Map.get(:planned_count, 0)
  end

  defp complete?(status, expected_runs) do
    runner = Map.get(status, :node_publish_runner, %{})
    monitor = Map.get(status, :execution_monitor, %{})

    inflight_count = Map.get(runner, :inflight_count, 0)
    run_count = Map.get(runner, :run_count, 0)
    total_count = Map.get(monitor, :total_count, 0)

    inflight_count == 0 and run_count >= expected_runs and total_count >= expected_runs
  end

  defp render_text(trigger?, timeout_ms, interval_ms, expected_runs, status) do
    runner = Map.get(status, :node_publish_runner, %{})
    monitor = Map.get(status, :execution_monitor, %{})

    """
    Blog Phase 1 Wait
    trigger: #{trigger?}
    timeout_ms: #{timeout_ms}
    interval_ms: #{interval_ms}
    expected_runs: #{expected_runs}
    wait_status: #{Map.get(status, :wait_status, :completed)}

    node_publish_runner.run_count=#{Map.get(runner, :run_count, 0)}
    node_publish_runner.inflight_count=#{Map.get(runner, :inflight_count, 0)}
    node_publish_runner.ok_count=#{Map.get(runner, :ok_count, 0)}
    node_publish_runner.dry_run_ok_count=#{Map.get(runner, :dry_run_ok_count, 0)}
    execution_monitor.total_count=#{Map.get(monitor, :total_count, 0)}
    execution_monitor.verify_ok_count=#{Map.get(monitor, :verify_ok_count, 0)}
    execution_monitor.dry_run_ok_count=#{Map.get(monitor, :dry_run_ok_count, 0)}
    execution_monitor.failed_count=#{Map.get(monitor, :failed_count, 0)}
    """
    |> String.trim()
  end
end
