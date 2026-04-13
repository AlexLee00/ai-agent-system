defmodule TeamJay.Blog.AutonomyDigest do
  @moduledoc """
  블로그팀 autonomy 판단 요약.

  최근 자율 판단 로그를 읽어 auto_publish / master_review 분포와
  최신 판단 상태를 운영 메시지에 붙일 수 있는 형태로 만든다.
  """

  alias Ecto.Adapters.SQL
  alias TeamJay.Repo

  @default_days 14

  def build(days \\ @default_days) do
    query_days = normalize_days(days)

    with {:ok, summary} <- SQL.query(Repo, summary_sql(query_days), []),
         {:ok, latest} <- SQL.query(Repo, latest_sql(), []) do
      summarize(summary.rows, summary.columns, latest.rows, latest.columns, query_days)
    else
      {:error, reason} -> error_digest(reason, query_days)
    end
  end

  defp summarize(summary_rows, summary_cols, latest_rows, latest_cols, days) do
    summary =
      summary_rows
      |> List.first()
      |> then(fn
        nil -> %{}
        row -> row |> Enum.zip(summary_cols) |> Map.new(fn {value, key} -> {String.to_atom(key), value} end)
      end)

    latest =
      latest_rows
      |> List.first()
      |> then(fn
        nil -> nil
        row -> row |> Enum.zip(latest_cols) |> Map.new(fn {value, key} -> {String.to_atom(key), value} end)
      end)

    total = int(Map.get(summary, :total_count))
    auto = int(Map.get(summary, :auto_publish_count))
    review = int(Map.get(summary, :master_review_count))
    phase = int(Map.get(summary, :max_phase))

    status =
      cond do
        total == 0 -> :warming_up
        auto > 0 -> :active
        true -> :ok
      end

    %{
      generated_at: DateTime.utc_now(),
      lookback_days: days,
      health: %{
        status: status,
        total_count: total,
        auto_publish_count: auto,
        master_review_count: review,
        max_phase: phase
      },
      latest_decision:
        if(latest,
          do: %{
            post_type: Map.get(latest, :post_type),
            category: Map.get(latest, :category),
            title: Map.get(latest, :title),
            decision: Map.get(latest, :decision),
            autonomy_phase: int(Map.get(latest, :autonomy_phase)),
            score: to_float(Map.get(latest, :score)),
            threshold: to_float(Map.get(latest, :threshold)),
            created_at: Map.get(latest, :created_at)
          },
          else: nil
        ),
      recommendations: build_recommendations(total, auto, review)
    }
  end

  defp error_digest(reason, days) do
    %{
      generated_at: DateTime.utc_now(),
      lookback_days: days,
      health: %{
        status: :error,
        total_count: 0,
        auto_publish_count: 0,
        master_review_count: 0,
        max_phase: 1
      },
      latest_decision: nil,
      recommendations: ["autonomy digest 조회 실패: #{inspect(reason)}"]
    }
  end

  defp build_recommendations(0, _auto, _review),
    do: ["autonomy 판단 로그가 아직 없어 warming-up 상태입니다."]

  defp build_recommendations(_total, 0, review) when review > 0,
    do: ["최근 판단은 모두 master_review라 자율 기준은 보수적으로 유지 중입니다."]

  defp build_recommendations(total, auto, _review) when auto > 0 and auto < total,
    do: ["auto_publish와 master_review가 함께 나타나고 있어 자율 기준이 실제 운영 데이터로 학습되는 중입니다."]

  defp build_recommendations(_total, _auto, _review),
    do: ["autonomy 판단 로그가 안정적으로 쌓이고 있어 자율 운영 회고에 바로 활용할 수 있습니다."]

  defp summary_sql(days) do
    """
    SELECT
      COALESCE(count(*), 0)::int AS total_count,
      COALESCE(count(*) FILTER (WHERE decision = 'auto_publish'), 0)::int AS auto_publish_count,
      COALESCE(count(*) FILTER (WHERE decision = 'master_review'), 0)::int AS master_review_count,
      COALESCE(max(autonomy_phase), 1)::int AS max_phase
    FROM blog.autonomy_decisions
    WHERE created_at >= NOW() - INTERVAL '#{days} days'
      AND COALESCE(metadata->>'smoke_test', 'false') <> 'true'
      AND title NOT LIKE '[Smoke]%'
    """
  end

  defp latest_sql do
    """
    SELECT post_type, category, title, decision, autonomy_phase, score, threshold, created_at
    FROM blog.autonomy_decisions
    WHERE COALESCE(metadata->>'smoke_test', 'false') <> 'true'
      AND title NOT LIKE '[Smoke]%'
    ORDER BY created_at DESC
    LIMIT 1
    """
  end

  defp normalize_days(days) when is_integer(days) and days > 0, do: days
  defp normalize_days(_days), do: @default_days

  defp int(value) when is_integer(value), do: value
  defp int(value) when is_float(value), do: trunc(value)
  defp int(value) when is_binary(value) do
    case Integer.parse(value) do
      {parsed, _} -> parsed
      :error -> 0
    end
  end
  defp int(_value), do: 0

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
