defmodule TeamJay.Blog.CompetitionDigest do
  @moduledoc """
  블로그팀 Phase 4 경쟁 실험 다이제스트.

  agent.competitions 최근 데이터를 읽어
  경쟁 실험이 실제로 돌고 있는지, timeout이나 pending 적체가 없는지
  운영자가 빠르게 파악할 수 있는 요약 payload를 만든다.
  """

  alias Ecto.Adapters.SQL
  alias TeamJay.Repo

  @default_days 7

  def build(days \\ @default_days) do
    query_days = normalize_days(days)

    case SQL.query(Repo, recent_competitions_sql(query_days), []) do
      {:ok, %{rows: rows, columns: columns}} ->
        rows =
          rows
          |> Enum.map(&Enum.zip(columns, &1))
          |> Enum.map(&Map.new/1)
          |> Enum.map(&normalize_keys/1)

        summarize(rows, query_days)

      {:error, reason} ->
        error_digest(reason, query_days)
    end
  end

  defp summarize(rows, days) do
    status_counts = Enum.frequencies_by(rows, &to_string(Map.get(&1, :status, "unknown")))
    winner_counts = Enum.frequencies_by(rows, &to_string(Map.get(&1, :winner, "none")))
    completed = Map.get(status_counts, "completed", 0)
    running = Map.get(status_counts, "running", 0)
    timed_out = Map.get(status_counts, "timeout", 0)
    pending = Map.get(status_counts, "pending", 0)

    quality_diffs =
      rows
      |> Enum.map(&to_float(Map.get(&1, :quality_diff)))
      |> Enum.filter(&is_number/1)

    avg_quality_diff =
      case quality_diffs do
        [] -> nil
        list -> Float.round(Enum.sum(list) / length(list), 2)
      end

    health_status =
      cond do
        rows == [] -> :warming_up
        running > 0 or pending > 0 -> :active
        timed_out > 0 and completed > 0 -> :cooldown
        timed_out > 0 -> :cooldown
        true -> :ok
      end

    %{
      generated_at: DateTime.utc_now(),
      lookback_days: days,
      health: %{
        status: health_status,
        total_count: length(rows),
        completed_count: completed,
        running_count: running,
        pending_count: pending,
        timeout_count: timed_out
      },
      winners: %{
        a_count: Map.get(winner_counts, "a", 0),
        b_count: Map.get(winner_counts, "b", 0),
        none_count: Map.get(winner_counts, "none", 0)
      },
      quality: %{
        avg_quality_diff: avg_quality_diff,
        max_quality_diff: Enum.max(quality_diffs, fn -> nil end)
      },
      recent_topics:
        rows
        |> Enum.take(5)
        |> Enum.map(fn row ->
          %{
            id: Map.get(row, :id),
            topic: Map.get(row, :topic),
            status: Map.get(row, :status),
            winner: Map.get(row, :winner),
            quality_diff: to_float(Map.get(row, :quality_diff)),
            created_at: Map.get(row, :created_at),
            completed_at: Map.get(row, :completed_at)
          }
        end),
      recommendations: build_recommendations(length(rows), completed, running, pending, timed_out)
    }
  end

  defp error_digest(reason, days) do
    %{
      generated_at: DateTime.utc_now(),
      lookback_days: days,
      health: %{
        status: :error,
        total_count: 0,
        completed_count: 0,
        running_count: 0,
        pending_count: 0,
        timeout_count: 0
      },
      winners: %{a_count: 0, b_count: 0, none_count: 0},
      quality: %{avg_quality_diff: nil, max_quality_diff: nil},
      recent_topics: [],
      recommendations: ["competition digest 조회 실패: #{inspect(reason)}"]
    }
  end

  defp build_recommendations(0, _completed, _running, _pending, _timed_out),
    do: ["최근 경쟁 실험 데이터가 아직 없어 competition 루프가 warming-up 상태입니다."]

  defp build_recommendations(_total, _completed, running, pending, timed_out)
       when timed_out > 0 and (running > 0 or pending > 0),
    do: ["진행 중 경쟁 실험과 timeout 건이 함께 있어 collect-competition 러너와 contract 정리를 우선 확인하는 편이 좋습니다."]

  defp build_recommendations(_total, completed, _running, _pending, timed_out)
       when timed_out > 0 and completed == 0,
    do: ["최근 timeout 이력은 남아 있지만 현재 running 경쟁은 없어 collector 보정 후 다음 사이클 결과를 확인하는 편이 좋습니다."]

  defp build_recommendations(_total, _completed, running, pending, _timed_out) when running > 0 or pending > 0,
    do: ["진행 중 경쟁 실험이 있어 다음 collector 사이클에서 winner/quality_diff를 함께 확인하는 편이 좋습니다."]

  defp build_recommendations(_total, _completed, _running, _pending, _timed_out),
    do: ["최근 경쟁 실험 요약이 안정적이라 주제/품질 비교 회고에 바로 활용할 수 있습니다."]

  defp recent_competitions_sql(days) do
    """
    SELECT id, topic, status, winner, quality_diff, created_at, completed_at
    FROM agent.competitions
    WHERE team = 'blog'
      AND created_at >= NOW() - INTERVAL '#{days} days'
    ORDER BY created_at DESC
    LIMIT 20
    """
  end

  defp normalize_days(days) when is_integer(days) and days > 0, do: days
  defp normalize_days(days) when is_binary(days) do
    case Integer.parse(days) do
      {value, _} when value > 0 -> value
      _ -> @default_days
    end
  end
  defp normalize_days(_days), do: @default_days

  defp normalize_keys(map) when is_map(map) do
    Map.new(map, fn
      {key, value} when is_binary(key) -> {String.to_atom(key), value}
      entry -> entry
    end)
  end

  defp to_float(nil), do: nil
  defp to_float(value) when is_float(value), do: value
  defp to_float(value) when is_integer(value), do: value * 1.0
  defp to_float(value) when is_binary(value) do
    case Float.parse(value) do
      {parsed, _} -> parsed
      :error -> nil
    end
  end
  defp to_float(_value), do: nil
end
