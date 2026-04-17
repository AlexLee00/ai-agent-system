defmodule Jay.V2.Sigma.Feedback do
  @moduledoc """
  시그마 피드백 수집기 (sigma-feedback.ts Elixir 포트).
  팀별 피드백을 DB에 기록 + RAG 저장.
  """

  require Logger

  @schema "sigma"

  @doc "DB 스키마 초기화"
  def ensure_tables do
    sqls = [
      """
      CREATE SCHEMA IF NOT EXISTS #{@schema}
      """,
      """
      CREATE TABLE IF NOT EXISTS #{@schema}.daily_runs (
        id BIGSERIAL PRIMARY KEY,
        run_date DATE NOT NULL DEFAULT CURRENT_DATE,
        formation JSONB NOT NULL DEFAULT '{}'::jsonb,
        events JSONB NOT NULL DEFAULT '{}'::jsonb,
        report TEXT,
        insight_count INTEGER NOT NULL DEFAULT 0,
        feedback_count INTEGER NOT NULL DEFAULT 0,
        meta JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
      """,
      """
      CREATE INDEX IF NOT EXISTS idx_sigma_daily_runs_date
      ON #{@schema}.daily_runs(run_date DESC, created_at DESC)
      """,
      """
      CREATE TABLE IF NOT EXISTS #{@schema}.feedback_effectiveness (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        feedback_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        target_team VARCHAR(20) NOT NULL,
        feedback_type VARCHAR(30) NOT NULL,
        content TEXT,
        formation JSONB DEFAULT '{}'::jsonb,
        analyst_used VARCHAR(30),
        before_metric JSONB DEFAULT '{}'::jsonb,
        after_metric JSONB DEFAULT '{}'::jsonb,
        effectiveness DOUBLE PRECISION,
        effective BOOLEAN,
        measured_at TIMESTAMPTZ,
        measured BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
      """,
      """
      CREATE INDEX IF NOT EXISTS idx_sigma_fb_team
      ON #{@schema}.feedback_effectiveness(target_team, feedback_date DESC)
      """
    ]

    Enum.each(sqls, fn sql ->
      Jay.Core.HubClient.pg_query(sql, "public")
    end)
    :ok
  rescue
    e ->
      Logger.warning("[Sigma.Feedback] ensure_tables 실패: #{Exception.message(e)}")
      :error
  end

  @doc "팀별 메트릭 수집 (sigma-feedback.ts collectTeamMetric 포트)"
  def collect_team_metric(team) when is_atom(team) do
    Jay.V2.TeamConnector.collect(team)
  end

  @doc "피드백 레코드 저장 (feedback_effectiveness)"
  def record_feedback(target_team, feedback_type, content, analyst, before_metric, opts \\ []) do
    # HubClient.pg_query는 파라미터 바인딩 미지원 → 안전한 값만 보간
    # target_team/feedback_type/analyst는 내부 atom → to_string 안전
    # content/metric/formation은 JSON 직렬화 후 single-quote 이스케이프
    formation = Keyword.get(opts, :formation, %{})
    team_s    = to_string(target_team)   |> escape_sql()
    type_s    = to_string(feedback_type) |> escape_sql()
    content_s = (content || "")          |> escape_sql()
    analyst_s = to_string(analyst)       |> escape_sql()
    metric_s  = Jason.encode!(before_metric || %{}) |> escape_sql()
    form_s    = Jason.encode!(formation)            |> escape_sql()

    sql = """
      INSERT INTO #{@schema}.feedback_effectiveness
        (target_team, feedback_type, content, analyst_used, before_metric, formation)
      VALUES ('#{team_s}', '#{type_s}', '#{content_s}', '#{analyst_s}',
              '#{metric_s}', '#{form_s}')
    """

    case Jay.Core.HubClient.pg_query(sql, @schema) do
      {:ok, _} ->
        Logger.debug("[Sigma.Feedback] 피드백 저장: #{target_team}/#{feedback_type}")
        :ok
      {:error, err} ->
        Logger.warning("[Sigma.Feedback] 저장 실패: #{inspect(err)}")
        :error
    end
  rescue
    _ -> :error
  end

  @doc "일일 실행 기록 저장 (daily_runs)"
  def record_daily_run(formation, events, report, insight_count, feedback_count) do
    form_s   = Jason.encode!(formation) |> escape_sql()
    events_s = Jason.encode!(events)    |> escape_sql()
    report_s = (report || "")           |> escape_sql()
    # insight_count/feedback_count는 integer — 보간 안전
    sql = """
      INSERT INTO #{@schema}.daily_runs
        (formation, events, report, insight_count, feedback_count)
      VALUES ('#{form_s}', '#{events_s}', '#{report_s}',
              #{insight_count}, #{feedback_count})
    """
    Jay.Core.HubClient.pg_query(sql, @schema)
    :ok
  rescue
    e ->
      Logger.warning("[Sigma.Feedback] daily_run 저장 실패: #{Exception.message(e)}")
      :error
  end

  @doc "피드백 효과 측정 업데이트 (7일 후 after_metric 비교)"
  def measure_effectiveness(feedback_id, after_metric, effective) do
    effectiveness = if effective, do: 1.0, else: 0.0
    # feedback_id는 UUID 형식 검증 후 사용
    unless valid_uuid?(feedback_id) do
      Logger.warning("[Sigma.Feedback] 잘못된 feedback_id: #{inspect(feedback_id)}")
      :error
    else
      metric_s = Jason.encode!(after_metric) |> escape_sql()
      sql = """
        UPDATE #{@schema}.feedback_effectiveness
        SET after_metric = '#{metric_s}',
            effective = #{effective},
            effectiveness = #{effectiveness},
            measured = TRUE,
            measured_at = NOW()
        WHERE id = '#{feedback_id}'
      """
      Jay.Core.HubClient.pg_query(sql, @schema)
      :ok
    end
  rescue
    _ -> :error
  end

  # ────────────────────────────────────────────────────────────────
  # SQL 안전 헬퍼
  # ────────────────────────────────────────────────────────────────

  # single-quote 이스케이프 (SQL 표준: ' → '')
  defp escape_sql(str) when is_binary(str), do: String.replace(str, "'", "''")
  defp escape_sql(other), do: escape_sql(to_string(other))

  # UUID v4 형식 검증
  defp valid_uuid?(id) when is_binary(id) do
    Regex.match?(~r/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, id)
  end
  defp valid_uuid?(_), do: false
end
