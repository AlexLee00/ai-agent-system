defmodule Mix.Tasks.Blog.Phase1.AlertSmoke do
  use Mix.Task

  @shortdoc "블로그팀 Phase 1 alert 흐름을 검증합니다"
  @requirements ["app.start"]

  @moduledoc """
  블로그팀 Elixir 리모델링 Phase 1의 alert 분기 경로를 검증하기 위해
  실패 execution_result를 주입하고 monitor/relay 상태를 확인한다.

  ## Examples

      mix blog.phase1.alert_smoke
      mix blog.phase1.alert_smoke --target node_publish
      mix blog.phase1.alert_smoke --target social
      mix blog.phase1.alert_smoke --json
  """

  alias TeamJay.Blog.AlertRelay
  alias TeamJay.Blog.PubSub
  alias TeamJay.Blog.SocialAlertRelay
  alias TeamJay.Blog.StatusSnapshot

  @impl Mix.Task
  def run(args) do
    {opts, _argv, _invalid} =
      OptionParser.parse(args,
        strict: [
          json: :boolean,
          target: :string,
          wait_ms: :integer
        ]
      )

    target = Keyword.get(opts, :target, "all")
    wait_ms = Keyword.get(opts, :wait_ms, 300)

    before_snapshot = StatusSnapshot.collect()
    inject(target)
    Process.sleep(wait_ms)
    after_snapshot = StatusSnapshot.collect()

    result = %{
      target: target,
      wait_ms: wait_ms,
      before: summarize(before_snapshot),
      after: summarize(after_snapshot)
    }

    if Keyword.get(opts, :json, false) do
      Mix.shell().info(Jason.encode_to_iodata!(result, pretty: true))
    else
      Mix.shell().info(render_text(result))
    end
  end

  defp inject("all") do
    inject_node_publish()
    inject_social()
  end

  defp inject("node_publish"), do: inject_node_publish()
  defp inject("social"), do: inject_social()
  defp inject("instagram"), do: inject_instagram()
  defp inject("naver_blog"), do: inject_naver_blog()
  defp inject(_other), do: inject("all")

  defp inject_node_publish do
    :ok =
      PubSub.broadcast_execution_result("node_publish", %{
        target: "node_publish",
        run_status: :forced_failure,
        ok: false,
        dry_run_ok: false,
        exit_code: 99,
        dry_run_exit_code: 99,
        verify_status: :forced_failure,
        dry_run_status: :forced_failure,
        output_preview: "forced node_publish failure for alert smoke",
        dry_run_output_preview: "forced node_publish dry-run failure for alert smoke",
        payload: %{post_type: :lecture, writer: "pos", date: Date.utc_today() |> Date.to_iso8601()}
      })
  end

  defp inject_social do
    inject_instagram()
    inject_naver_blog()
  end

  defp inject_instagram do
    :ok =
      PubSub.broadcast_execution_result("instagram", %{
        target: "instagram",
        run_status: :forced_failure,
        ok: false,
        exit_code: 91,
        finished_at: DateTime.utc_now(),
        duration_ms: 12,
        payload: %{post_type: :general, writer: "gems", date: Date.utc_today() |> Date.to_iso8601()}
      })
  end

  defp inject_naver_blog do
    :ok =
      PubSub.broadcast_execution_result("naver_blog", %{
        target: "naver_blog",
        run_status: :forced_failure,
        ok: false,
        exit_code: 92,
        finished_at: DateTime.utc_now(),
        duration_ms: 14,
        payload: %{post_type: :lecture, writer: "pos", date: Date.utc_today() |> Date.to_iso8601()}
      })
  end

  defp summarize(snapshot) do
    %{
      execution_monitor: %{
        alert_count: get_in(snapshot, [:execution_monitor, :alert_count]) || 0,
        failed_count: get_in(snapshot, [:execution_monitor, :failed_count]) || 0
      },
      alert_relay: %{
        alert_count: AlertRelay.status().alert_count
      },
      social_execution_monitor: %{
        alert_count: get_in(snapshot, [:social_execution_monitor, :alert_count]) || 0,
        failed_count: get_in(snapshot, [:social_execution_monitor, :failed_count]) || 0
      },
      social_alert_relay: %{
        alert_count: SocialAlertRelay.status().alert_count,
        by_channel: get_in(snapshot, [:social_alert_relay, :by_channel]) || %{}
      }
    }
  end

  defp render_text(result) do
    """
    Blog Phase 1 Alert Smoke
    target: #{result.target}
    wait_ms: #{result.wait_ms}

    before.node_alerts=#{result.before.alert_relay.alert_count}
    after.node_alerts=#{result.after.alert_relay.alert_count}
    before.node_failed=#{result.before.execution_monitor.failed_count}
    after.node_failed=#{result.after.execution_monitor.failed_count}

    before.social_alerts=#{result.before.social_alert_relay.alert_count}
    after.social_alerts=#{result.after.social_alert_relay.alert_count}
    before.social_failed=#{result.before.social_execution_monitor.failed_count}
    after.social_failed=#{result.after.social_execution_monitor.failed_count}
    """
    |> String.trim()
  end
end
