defmodule TeamJay.Blog.DailySummary do
  @moduledoc """
  블로그팀 Phase 1 일간 요약 도우미.

  상태 스냅샷을 바탕으로 Node publish, social relay, alert 현황을
  운영자가 빠르게 읽을 수 있는 요약 payload로 정리한다.
  """

  alias TeamJay.Blog.StatusSnapshot
  alias TeamJay.Blog.FeedbackDigest
  alias TeamJay.Blog.CompetitionDigest
  alias TeamJay.Blog.AutonomyDigest
  alias TeamJay.Blog.MarketingDigest

  def build do
    snapshot = StatusSnapshot.collect()
    phase3 = FeedbackDigest.build(snapshot)
    phase4 = CompetitionDigest.build()
    autonomy = AutonomyDigest.build()
    marketing = MarketingDigest.build()

    %{
      generated_at: DateTime.utc_now(),
      node_publish: build_node_publish_summary(snapshot),
      social: build_social_summary(snapshot),
      alerts: build_alert_summary(snapshot),
      health: build_health_summary(snapshot),
      phase3_feedback: phase3,
      phase4_competition: phase4,
      autonomy: autonomy,
      marketing: marketing,
      raw: snapshot
    }
  end

  defp build_node_publish_summary(snapshot) do
    runner = Map.get(snapshot, :node_publish_runner, %{})
    monitor = Map.get(snapshot, :execution_monitor, %{})

    %{
      run_count: Map.get(runner, :run_count, 0),
      inflight_count: Map.get(runner, :inflight_count, 0),
      ok_count: Map.get(runner, :ok_count, 0),
      dry_run_ok_count: Map.get(runner, :dry_run_ok_count, 0),
      failed_count: Map.get(monitor, :failed_count, 0),
      alert_count: Map.get(monitor, :alert_count, 0),
      last_run_at: Map.get(runner, :last_run_at),
      last_results: Map.get(runner, :last_results, [])
    }
  end

  defp build_social_summary(snapshot) do
    relay = Map.get(snapshot, :social_relay, %{})
    monitor = Map.get(snapshot, :social_execution_monitor, %{})

    %{
      relayed_count: Map.get(relay, :relayed_count, 0),
      total_count: Map.get(monitor, :total_count, 0),
      ok_count: Map.get(monitor, :ok_count, 0),
      failed_count: Map.get(monitor, :failed_count, 0),
      alert_count: Map.get(monitor, :alert_count, 0),
      by_channel: Map.get(monitor, :by_channel, %{}),
      last_seen_at: Map.get(monitor, :last_seen_at),
      last_results: Map.get(monitor, :last_results, [])
    }
  end

  defp build_alert_summary(snapshot) do
    node_alerts = Map.get(snapshot, :alert_relay, %{})
    social_alerts = Map.get(snapshot, :social_alert_relay, %{})

    %{
      total_count:
        Map.get(node_alerts, :alert_count, 0) + Map.get(social_alerts, :alert_count, 0),
      node_publish: %{
        alert_count: Map.get(node_alerts, :alert_count, 0),
        last_alert_at: Map.get(node_alerts, :last_alert_at),
        last_alerts: Map.get(node_alerts, :last_alerts, [])
      },
      social: %{
        alert_count: Map.get(social_alerts, :alert_count, 0),
        by_channel: Map.get(social_alerts, :by_channel, %{}),
        last_alert_at: Map.get(social_alerts, :last_alert_at),
        last_alerts: Map.get(social_alerts, :last_alerts, [])
      }
    }
  end

  defp build_health_summary(snapshot) do
    node_monitor = Map.get(snapshot, :execution_monitor, %{})
    social_monitor = Map.get(snapshot, :social_execution_monitor, %{})

    %{
      status:
        cond do
          Map.get(node_monitor, :alert_count, 0) > 0 -> :warn
          Map.get(social_monitor, :alert_count, 0) > 0 -> :warn
          Map.get(node_monitor, :failed_count, 0) > 0 -> :warn
          Map.get(social_monitor, :failed_count, 0) > 0 -> :warn
          true -> :ok
        end,
      node_publish_ok?: Map.get(node_monitor, :failed_count, 0) == 0,
      social_ok?: Map.get(social_monitor, :failed_count, 0) == 0
    }
  end
end
