defmodule TeamJay.Blog.RemodelSnapshot do
  @moduledoc """
  블로그 리모델링 운영 스냅샷 기록기.

  Phase 1/3/4 + autonomy 요약을 event_lake에 남겨 실운영 추세를
  날짜별로 비교하고 회고 데이터로 재활용할 수 있게 한다.
  """

  alias TeamJay.Blog.DailySummary
  alias TeamJay.Blog.SummaryFormatter
  alias TeamJay.EventLake

  def build(summary \\ DailySummary.build()) do
    phase3 = Map.get(summary, :phase3_feedback, %{})
    phase4 = Map.get(summary, :phase4_competition, %{})
    autonomy = Map.get(summary, :autonomy, %{})

    %{
      generated_at: DateTime.utc_now(),
      phase1_brief: SummaryFormatter.format(summary, :brief),
      health: Map.get(summary, :health, %{}),
      node_publish: Map.get(summary, :node_publish, %{}),
      social: Map.get(summary, :social, %{}),
      alerts: Map.get(summary, :alerts, %{}),
      phase3_feedback: %{
        health: Map.get(phase3, :health, %{}),
        feedback: Map.get(phase3, :feedback, %{}),
        execution: Map.get(phase3, :execution, %{}),
        social: Map.get(phase3, :social, %{}),
        alerts: Map.get(phase3, :alerts, %{})
      },
      phase4_competition: %{
        health: Map.get(phase4, :health, %{}),
        quality: Map.get(phase4, :quality, %{}),
        winners: Map.get(phase4, :winners, %{}),
        recent_topics: Map.get(phase4, :recent_topics, []),
        recommendations: Map.get(phase4, :recommendations, [])
      },
      autonomy: %{
        health: Map.get(autonomy, :health, %{}),
        latest_decision: Map.get(autonomy, :latest_decision),
        recommendations: Map.get(autonomy, :recommendations, [])
      }
    }
  end

  def persist(summary \\ DailySummary.build()) do
    snapshot = build(summary)

    EventLake.record(%{
      event_type: "blog_remodel_snapshot",
      team: "blog",
      bot_name: "blog.phase_remodel",
      severity: severity(snapshot),
      title: "블로그 리모델링 운영 스냅샷",
      message: snapshot.phase1_brief,
      tags: ["blog", "remodel", "phase1", "phase3", "phase4", "autonomy", "ops_snapshot"],
      metadata: snapshot
    })

    snapshot
  end

  defp severity(snapshot) do
    phase1_status = get_in(snapshot, [:health, :status])
    phase3_status = get_in(snapshot, [:phase3_feedback, :health, :status])
    phase4_status = get_in(snapshot, [:phase4_competition, :health, :status])
    autonomy_status = get_in(snapshot, [:autonomy, :health, :status])

    cond do
      phase1_status == :warn -> "warn"
      phase3_status == :warn -> "warn"
      phase4_status == :warn -> "warn"
      autonomy_status == :warn -> "warn"
      true -> "info"
    end
  end
end
