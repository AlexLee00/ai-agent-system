defmodule TeamJay.Blog.FeedbackDigest do
  @moduledoc """
  블로그팀 Phase 3 피드백 다이제스트.

  Phase 1에서 쌓이는 실행/소셜/알람/피드백 신호를 한 payload로 묶어
  운영 회고와 후속 학습 입력으로 바로 쓰기 위한 요약 레이어다.
  """

  alias TeamJay.Blog.StatusSnapshot
  alias TeamJay.Blog.AutonomyDigest
  alias Ecto.Adapters.SQL
  alias TeamJay.Repo

  def build(snapshot \\ StatusSnapshot.collect()) do
    feedback = build_feedback_store()
    node = Map.get(snapshot, :execution_monitor, %{})
    social = Map.get(snapshot, :social_execution_monitor, %{})
    node_alerts = Map.get(snapshot, :alert_relay, %{})
    social_alerts = Map.get(snapshot, :social_alert_relay, %{})
    autonomy = AutonomyDigest.build()

    %{
      generated_at: DateTime.utc_now(),
      health: build_health(feedback, node, social, node_alerts, social_alerts),
      feedback: summarize_feedback(feedback),
      execution: summarize_execution(node),
      social: summarize_social(social),
      alerts: summarize_alerts(node_alerts, social_alerts),
      autonomy: autonomy,
      recommendations: build_recommendations(feedback, node, social, node_alerts, social_alerts)
    }
  end

  defp build_feedback_store do
    with {:ok, count_result} <- SQL.query(Repo, feedback_count_sql(), []),
         {:ok, recent_result} <- SQL.query(Repo, feedback_recent_sql(), []) do
      count_row = List.first(count_result.rows) || [0, nil]
      [feedback_count, last_feedback_at] = count_row

      recent_items =
        recent_result.rows
        |> Enum.map(fn row ->
          row
          |> Enum.zip(recent_result.columns)
          |> Map.new(fn {value, key} -> {String.to_atom(key), value} end)
        end)

      %{
        feedback_count: int(feedback_count),
        last_feedback_at: last_feedback_at,
        last_items: recent_items
      }
    else
      _ ->
        %{feedback_count: 0, last_feedback_at: nil, last_items: []}
    end
  end

  defp build_health(feedback, node, social, node_alerts, social_alerts) do
    failed_total =
      int(Map.get(node, :failed_count)) +
        int(Map.get(social, :failed_count)) +
        int(Map.get(node_alerts, :alert_count)) +
        int(Map.get(social_alerts, :alert_count))

    status =
      cond do
        failed_total >= 4 -> :warn
        int(Map.get(feedback, :feedback_count)) == 0 -> :warming_up
        true -> :ok
      end

    %{
      status: status,
      failed_signal_count: failed_total,
      feedback_ready_count: int(Map.get(feedback, :feedback_count)),
      node_failure_count: int(Map.get(node, :failed_count)),
      social_failure_count: int(Map.get(social, :failed_count))
    }
  end

  defp summarize_feedback(feedback) do
    items = Map.get(feedback, :last_items, [])

    %{
      feedback_count: int(Map.get(feedback, :feedback_count)),
      last_feedback_at: Map.get(feedback, :last_feedback_at),
      recent_keys: Enum.map(items, &Map.get(&1, :feedback_key)),
      recent_items:
        Enum.map(items, fn item ->
          %{
            feedback_key: Map.get(item, :feedback_key),
            created_at: Map.get(item, :created_at),
            status: Map.get(item, :status),
            note: Map.get(item, :note)
          }
        end)
    }
  end

  defp summarize_execution(node) do
    recent_results = Enum.take(Map.get(node, :last_results, []), 3)

    %{
      total_count: int(Map.get(node, :total_count)),
      verify_ok_count: int(Map.get(node, :verify_ok_count)),
      dry_run_ok_count: int(Map.get(node, :dry_run_ok_count)),
      failed_count: int(Map.get(node, :failed_count)),
      recent_results: recent_results,
      recent_failures: Enum.filter(recent_results, &(Map.get(&1, :run_status) != :dry_run_verified))
    }
  end

  defp summarize_social(social) do
    recent_results = Enum.take(Map.get(social, :last_results, []), 4)

    %{
      total_count: int(Map.get(social, :total_count)),
      ok_count: int(Map.get(social, :ok_count)),
      failed_count: int(Map.get(social, :failed_count)),
      by_channel: Map.get(social, :by_channel, %{}),
      recent_results: recent_results,
      recent_failures:
        Enum.filter(recent_results, fn result ->
          not truthy?(Map.get(result, :ok))
        end)
    }
  end

  defp summarize_alerts(node_alerts, social_alerts) do
    %{
      total_count: int(Map.get(node_alerts, :alert_count)) + int(Map.get(social_alerts, :alert_count)),
      node_publish: %{
        alert_count: int(Map.get(node_alerts, :alert_count)),
        recent: Enum.take(Map.get(node_alerts, :last_alerts, []), 3)
      },
      social: %{
        alert_count: int(Map.get(social_alerts, :alert_count)),
        recent: Enum.take(Map.get(social_alerts, :last_alerts, []), 4)
      }
    }
  end

  defp truthy?(true), do: true
  defp truthy?("true"), do: true
  defp truthy?(1), do: true
  defp truthy?(_value), do: false

  defp build_recommendations(feedback, node, social, node_alerts, social_alerts) do
    []
    |> maybe_add(int(Map.get(feedback, :feedback_count)) == 0, "published 이후 feedback 수집 키가 아직 쌓이지 않아 후속 학습 데이터가 비어 있습니다.")
    |> maybe_add(int(Map.get(node, :failed_count)) > 0, "node_publish 실패 이력이 있어 verify/dry-run 러너 로그를 우선 점검하는 편이 좋습니다.")
    |> maybe_add(int(Map.get(social, :failed_count)) > 0, "소셜 채널 실행 실패가 있어 채널별 executor/runner 상태를 다시 보는 것이 좋습니다.")
    |> maybe_add(int(Map.get(node_alerts, :alert_count)) > 0, "node_publish alert가 쌓여 있어 실행 결과를 회고 데이터에 함께 포함하는 것이 좋습니다.")
    |> maybe_add(int(Map.get(social_alerts, :alert_count)) > 0, "social alert가 누적돼 있어 인스타/네이버 채널별 실패 패턴을 분리해서 보는 것이 좋습니다.")
    |> case do
      [] -> ["현재는 Phase 3 피드백 신호가 안정적이라 주간 회고용 요약으로 바로 활용할 수 있습니다."]
      list -> list
    end
  end

  defp maybe_add(list, true, message), do: list ++ [message]
  defp maybe_add(list, false, _message), do: list

  defp feedback_count_sql do
    """
    SELECT
      COALESCE(count(*), 0)::int AS feedback_count,
      max(created_at) AS last_feedback_at
    FROM agent.event_lake
    WHERE team = 'blog'
      AND event_type = 'blog_feedback_created'
    """
  end

  defp feedback_recent_sql do
    """
    SELECT
      metadata->>'feedback_key' AS feedback_key,
      metadata->>'status' AS status,
      metadata->>'note' AS note,
      created_at
    FROM agent.event_lake
    WHERE team = 'blog'
      AND event_type = 'blog_feedback_created'
    ORDER BY created_at DESC
    LIMIT 5
    """
  end

  defp int(value) when is_integer(value), do: value
  defp int(value) when is_float(value), do: trunc(value)
  defp int(value) when is_binary(value) do
    case Integer.parse(value) do
      {parsed, _} -> parsed
      :error -> 0
    end
  end

  defp int(_value), do: 0
end
