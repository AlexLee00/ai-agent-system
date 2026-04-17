defmodule Mix.Tasks.Blog.Autonomy.Smoke do
  use Mix.Task

  @shortdoc "블로그 autonomy 판단 저장/요약 경로를 스모크 점검합니다"
  @requirements ["app.start"]

  @moduledoc """
  autonomy_decisions 저장과 AutonomyDigest 요약을 한 번에 점검한다.

  기본 동작은 smoke row를 잠깐 넣고 digest를 확인한 뒤 다시 정리한다.

  ## Examples

      mix blog.autonomy.smoke
      mix blog.autonomy.smoke --json
      mix blog.autonomy.smoke --persist
  """

  alias Ecto.Adapters.SQL
  alias TeamJay.Blog.AutonomyDigest
  alias Jay.Core.Repo

  @impl Mix.Task
  def run(args) do
    {opts, _argv, _invalid} =
      OptionParser.parse(args,
        strict: [
          json: :boolean,
          persist: :boolean,
          cleanup_all_smoke: :boolean
        ]
      )

    persist? = Keyword.get(opts, :persist, false)
    cleanup_all? = Keyword.get(opts, :cleanup_all_smoke, false)

    if cleanup_all? do
      deleted_count = cleanup_all_smoke_rows()

      payload = %{
        cleanup_only: true,
        deleted_count: deleted_count
      }

      if Keyword.get(opts, :json, false) do
        Mix.shell().info(Jason.encode!(payload))
      else
        Mix.shell().info("Blog Autonomy Smoke Cleanup")
        Mix.shell().info("deleted_count: #{deleted_count}")
      end

      :ok
    else
    run_id = "smoke-" <> Integer.to_string(System.system_time(:millisecond))

    inserted_count = insert_smoke_rows(run_id)
    digest = AutonomyDigest.build()

    unless persist? do
      cleanup_smoke_rows(run_id)
    end

    payload = %{
      run_id: run_id,
      persist: persist?,
      inserted_count: inserted_count,
      autonomy_health: Map.get(digest, :health, %{}),
      latest_decision: Map.get(digest, :latest_decision),
      recommendations: Map.get(digest, :recommendations, [])
    }

    if Keyword.get(opts, :json, false) do
      Mix.shell().info(Jason.encode!(payload))
    else
      Mix.shell().info(render_text(payload))
    end
    end
  end

  defp insert_smoke_rows(run_id) do
    metadata =
      Jason.encode!(%{
        smoke_test: true,
        smoke_run_id: run_id,
        source: "mix blog.autonomy.smoke"
      })

    result =
      SQL.query!(
        Repo,
        """
        INSERT INTO blog.autonomy_decisions
          (decision_date, post_type, category, title, post_id, autonomy_phase, decision, score, threshold, reasons, sense_summary, revenue_summary, metadata)
        VALUES
          (CURRENT_DATE, 'general', '홈페이지와App', '[Smoke] autonomy auto publish', NULL, 2, 'auto_publish', 0.92, 0.80, '["smoke:auto_publish"]'::jsonb, '{"signalCount":2}'::jsonb, '{"revenueImpactPct":12}'::jsonb, $1::jsonb),
          (CURRENT_DATE, 'lecture', 'Node.js강의', '[Smoke] autonomy master review', NULL, 1, 'master_review', 0.72, 0.95, '["smoke:master_review"]'::jsonb, '{"signalCount":1}'::jsonb, '{"revenueImpactPct":3}'::jsonb, $1::jsonb)
        """,
        [metadata]
      )

    result.num_rows || 0
  end

  defp cleanup_smoke_rows(run_id) do
    result =
      SQL.query!(
        Repo,
        """
        DELETE FROM blog.autonomy_decisions
        WHERE COALESCE(metadata->>'smoke_run_id', '') = $1
        """,
        [run_id]
      )

    result.num_rows || 0
  end

  defp cleanup_all_smoke_rows do
    result =
      SQL.query!(
      Repo,
      """
      DELETE FROM blog.autonomy_decisions
      WHERE COALESCE(metadata->>'smoke_test', 'false') = 'true'
      """,
      []
    )

    result.num_rows || 0
  end

  defp render_text(payload) do
    health = payload.autonomy_health || %{}
    latest = payload.latest_decision || %{}
    recommendations = Map.get(payload, :recommendations, [])

    """
    Blog Autonomy Smoke
    run_id: #{payload.run_id}
    persist: #{payload.persist}
    inserted_count: #{payload.inserted_count}
    status: #{Map.get(health, :status, :warming_up)}
    total_count: #{Map.get(health, :total_count, 0)}
    auto_publish_count: #{Map.get(health, :auto_publish_count, 0)}
    master_review_count: #{Map.get(health, :master_review_count, 0)}
    max_phase: #{Map.get(health, :max_phase, 1)}
    latest: #{render_latest(latest)}
    recommendations: #{Enum.join(recommendations, " | ")}
    """
    |> String.trim()
  end

  defp render_latest(nil), do: "none"
  defp render_latest(latest) when latest == %{}, do: "none"
  defp render_latest(latest) do
    "#{Map.get(latest, :post_type, "unknown")}:#{Map.get(latest, :decision, "unknown")}"
  end
end
