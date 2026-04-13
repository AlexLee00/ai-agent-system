defmodule TeamJay.Blog.MarketingDigest do
  @moduledoc """
  블로그팀 마케팅 확장 다이제스트.

  event_lake에 적재된 marketing snapshot을 읽어 최근 상태, 신호 수,
  revenue impact 추세를 운영 메시지에 붙일 수 있는 형태로 만든다.
  """

  alias Ecto.Adapters.SQL
  alias TeamJay.Repo

  @default_days 7

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
    ok_count = int(Map.get(summary, :ok_count))
    watch_count = int(Map.get(summary, :watch_count))
    avg_signal = to_float(Map.get(summary, :avg_signal_count)) || 0.0
    avg_impact = to_float(Map.get(summary, :avg_revenue_impact_pct)) || 0.0

    status =
      cond do
        total == 0 -> :warming_up
        watch_count > 0 -> :watch
        true -> :ok
      end

    latest_status = latest |> Map.get(:status) |> to_status_atom()
    latest_weakness = Map.get(latest, :latest_weakness)

    %{
      generated_at: DateTime.utc_now(),
      lookback_days: days,
      health: %{
        status: status,
        total_count: total,
        ok_count: ok_count,
        watch_count: watch_count,
        avg_signal_count: Float.round(avg_signal, 2),
        avg_revenue_impact_pct: Float.round(avg_impact, 4)
      },
      latest_snapshot:
        if(latest,
          do: %{
            created_at: Map.get(latest, :created_at),
            status: latest_status,
            latest_weakness: latest_weakness
          },
          else: nil
        ),
      recommendations: build_recommendations(total, watch_count, latest_weakness)
    }
  end

  defp error_digest(reason, days) do
    %{
      generated_at: DateTime.utc_now(),
      lookback_days: days,
      health: %{
        status: :error,
        total_count: 0,
        ok_count: 0,
        watch_count: 0,
        avg_signal_count: 0.0,
        avg_revenue_impact_pct: 0.0
      },
      latest_snapshot: nil,
      recommendations: ["marketing digest 조회 실패: #{inspect(reason)}"]
    }
  end

  defp build_recommendations(0, _watch_count, _weakness),
    do: ["marketing snapshot이 아직 없어 마케팅 확장 루프는 warming-up 상태입니다."]

  defp build_recommendations(_total, watch_count, weakness) when watch_count > 0 and is_binary(weakness) and weakness != "",
    do: ["최근 marketing snapshot에 watch 신호가 있고 약점은 #{weakness}라 제목/CTA/전환형 비중을 함께 점검하는 편이 좋습니다."]

  defp build_recommendations(_total, watch_count, _weakness) when watch_count > 0,
    do: ["최근 marketing snapshot에 watch 신호가 있어 실험보다 안정 운영 비중을 높이는 편이 좋습니다."]

  defp build_recommendations(_total, _watch_count, weakness) when is_binary(weakness) and weakness != "",
    do: ["현재는 안정 구간이지만 최신 약점 #{weakness}를 다음 회차 품질 보정 포인트로 잡는 편이 좋습니다."]

  defp build_recommendations(_total, _watch_count, _weakness),
    do: ["marketing snapshot 추세가 안정적이라 weekly diagnosis와 함께 회고 데이터로 활용하기 좋습니다."]

  defp summary_sql(days) do
    """
    SELECT
      COALESCE(count(*), 0)::int AS total_count,
      COALESCE(count(*) FILTER (WHERE metadata->'health'->>'status' = 'ok'), 0)::int AS ok_count,
      COALESCE(count(*) FILTER (WHERE metadata->'health'->>'status' = 'watch'), 0)::int AS watch_count,
      COALESCE(avg(NULLIF(metadata->'senseSummary'->>'signalCount', '')::numeric), 0)::float AS avg_signal_count,
      COALESCE(avg(NULLIF(metadata->'revenueCorrelation'->>'revenueImpactPct', '')::numeric), 0)::float AS avg_revenue_impact_pct
    FROM agent.event_lake
    WHERE event_type = 'blog_marketing_snapshot'
      AND team = 'blog'
      AND created_at >= NOW() - INTERVAL '#{days} days'
    """
  end

  defp latest_sql do
    """
    SELECT
      created_at,
      metadata->'health'->>'status' AS status,
      metadata->'diagnosis'->'primaryWeakness'->>'code' AS latest_weakness
    FROM agent.event_lake
    WHERE event_type = 'blog_marketing_snapshot'
      AND team = 'blog'
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

  defp to_status_atom("ok"), do: :ok
  defp to_status_atom("watch"), do: :watch
  defp to_status_atom("error"), do: :error
  defp to_status_atom(nil), do: nil
  defp to_status_atom(other) when is_binary(other), do: String.to_atom(other)
  defp to_status_atom(other), do: other
end
